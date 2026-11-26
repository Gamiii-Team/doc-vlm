// src/vlmRun.js — the ONLY analysis pipeline: PDF or PPTX -> full-VLM JSON.
// PPTX inputs are converted to PDF in Docker (Windows-safe), then every page is
// rendered by PyMuPDF and sent to the configured Groq VLM. PDF inputs skip the
// conversion step. Results land under out/vlm/<jobId>/vlm/<model-slug>/.

import fs from "node:fs";
import path from "node:path";

import { config, missingFor } from "./config.js";
import { validatePptx } from "./input/pptxValidate.js";
import { convertPptxToPdf } from "./input/pptxToPdf.js";
import { extractHints } from "./input/pptxHints.js";
import { extractSlidesVlm } from "./extract/slideVlm.js";
import { analyzePdf } from "./pymupdf/run.js";
import { makeProvider } from "./providers/index.js";
import { genRunId, modelSlug } from "./util/runName.js";
import { buildStatusSlideMap, mergeSlides, writeMainAtomic, writeFileAtomic } from "./mergeMain.js";
import { buildManifest } from "./vlmManifest.js";
import { recentTimings } from "./util/log.js";

// Module-level set of job ids cancelled mid-run. Cancellation is checked between
// VLM calls (best effort); in-flight model requests are not interrupted.
const cancelledJobs = new Set();
export function isCancelled(jobId) { return cancelledJobs.has(jobId); }
export function markCancelled(jobId) { cancelledJobs.add(jobId); }
export function clearCancelled(jobId) { cancelledJobs.delete(jobId); }

export async function runVlm(input, options = {}) {
  const ext = path.extname(input).toLowerCase();
  if (ext !== ".pptx" && ext !== ".pdf") {
    throw new Error(`Unsupported input "${ext || "(no extension)"}" — full-VLM mode accepts .pdf and .pptx only`);
  }

  const missing = options.provider ? [] : missingFor();
  if (missing.length) throw new Error(`Missing configuration for full-VLM mode: ${missing.join(", ")}`);

  const logger = options.logger ?? console;
  const onStatus = options.onStatus ?? (() => {});
  const t0 = Date.now();
  const jobId = options.jobId ?? genRunId();
  const model = config.groqModel || "qwen/qwen3.8-27b";
  const outDir = path.resolve(path.join(config.outputDir, "vlm", jobId, "vlm", modelSlug(model)));
  const slidesDir = path.join(outDir, "slides");
  const manifestPath = path.join(outDir, "manifest.json");
  const resultPath = path.join(outDir, "result.json");
  const statusPath = path.join(outDir, "status.json");
  const reportPath = path.join(outDir, "run-report.json");
  fs.mkdirSync(slidesDir, { recursive: true });

  const status = {
    id: jobId, mode: "vlm", model, input: path.basename(input),
    created: Date.now(), updated: Date.now(), status: "analyzing",
    startedAt: Date.now(), stage: "converting",
    slides: {}, issues: [],
  };
  const writeStatus = (patch = {}) => {
    Object.assign(status, patch, { updated: Date.now() });
    fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));
  };
  writeStatus();

  const provider = options.provider ?? makeProvider("groq");
  let validation = { hidden: 0, empty: 0, slides: null };

  // ── Input preparation: PPTX -> Docker conversion; PDF copied directly ──────
  onStatus({ stage: "converting" });
  let convertedPdfPath = null;
  const prep = (async () => {
    if (ext === ".pptx") {
      validation = await validatePptx(input); // throws PptxValidationError on violation
      const converted = await convertPptxToPdf(input, {
        logger,
        hideEmptySlides: (validation.empty ?? 0) > 0,
      });
      convertedPdfPath = converted.pdfPath;
      return converted.pdfPath;
    }
    // PDF input: no Docker conversion, no native hints.
    const stat = await fs.promises.stat(input);
    if (!stat.isFile() || stat.size === 0) throw new Error("PDF input is missing or empty");
    return path.resolve(input);
  })();

  const [analysis, hintsResult] = await Promise.all([
    (async () => {
      const source = await prep;
      fs.mkdirSync(outDir, { recursive: true });
      // Keep a stable source.pdf inside the job for crops/zoom after upload cleanup.
      fs.copyFileSync(source, path.join(outDir, "source.pdf"));
      const result = await analyzePdf(path.join(outDir, "source.pdf"));
      if (convertedPdfPath) { try { fs.unlinkSync(convertedPdfPath); } catch {} }
      return result;
    })(),
    ext === ".pptx" ? extractHints(input, { logger }) : Promise.resolve({ hints: [] }),
  ]);

  const hints = Array.isArray(hintsResult?.hints) ? hintsResult.hints : [];
  const visible = hints.filter((h) => !h?.hidden && !h?.empty);
  const hintsAttach = visible.length === (analysis.num_pages ?? 0);
  const hintsForPages = hintsAttach ? visible : [];
  if (!hintsAttach && ext === ".pptx") {
    status.issues.push(`native hints unavailable or misaligned (visible slides=${visible.length}, pdf pages=${analysis.num_pages}) — using image + text layer only`);
    logger?.warn?.(status.issues[0]);
    writeStatus();
  }

  const pages = (analysis.pages ?? []).slice(0, config.maxPages);

  // Stall detection + per-slide progress.
  let lastProgressAt = Date.now();
  const stallMs = (config.jobStallMinutes ?? 5) * 60 * 1000;
  const stallWatchdog = setInterval(() => {
    if (status.status === "done" || status.status === "failed" || status.status === "review") { clearInterval(stallWatchdog); return; }
    if (Date.now() - lastProgressAt > stallMs) {
      status.status = "failed";
      status.error = `stalled: ${Math.round((Date.now() - lastProgressAt) / 60000)} minutes with no task completing`;
      status.updated = Date.now();
      writeStatus();
      clearInterval(stallWatchdog);
    }
  }, 30_000);
  stallWatchdog.unref?.();

  const onSlideStatus = (n, s) => { lastProgressAt = Date.now(); status.slides[n] = s; writeStatus(); };

  writeStatus({ stage: "analyzing" });
  const { slides, usage, images, failed } = await extractSlidesVlm({
    pdfPath: path.join(outDir, "source.pdf"), pages, hints: hintsForPages, provider, slidesDir, logger,
    concurrency: Number(process.env.VLM_CONCURRENCY) || 3,
    dpi: Number(process.env.PPTX_VLM_DPI) || 150,
    onSlideStatus,
    cancelRequested: () => cancelledJobs.has(jobId),
  });
  clearInterval(stallWatchdog);
  if (cancelledJobs.has(jobId)) {
    status.status = "failed";
    status.error = "cancelled";
    status.updated = Date.now();
    writeStatus();
    throw new Error("job cancelled");
  }

  const report = {
    run_id: jobId, mode: "vlm", model, backend: "groq",
    source_file: path.resolve(input),
    duration_ms: Date.now() - t0,
    pages: analysis.num_pages,
    slides: { total: analysis.num_pages, failed, per_slide: status.slides },
    total_tokens_input: usage.input, total_tokens_output: usage.output,
    images_sent: images,
    pptx: {
      total: ext === ".pptx" ? (validation.slides ?? analysis.num_pages) : 0,
      visible: analysis.num_pages,
      hidden: validation.hidden ?? 0,
      empty: validation.empty ?? 0,
    },
    errors: { vlm: slides.filter((s) => s.failed).map((s) => ({ slide: s.slide, issues: s.issues })) },
    validation: {},
  };

  const resultDoc = {
    jobId, mode: "vlm", model, backend: "groq",
    input: path.basename(input),
    source_file: path.resolve(input),
    subject: "unknown",
    subject_source: "unavailable",
    created: t0,
    slides: slides.map((s) => s.failed
      ? { slide: s.slide, failed: true, issues: s.issues ?? [], confidence: "low" }
      : { ...s.json, reviewed: false, failed: false }),
  };

  const initialStatuses = buildStatusSlideMap(resultDoc.slides, hints);
  for (const [n, s] of Object.entries(initialStatuses)) status.slides[n] = s;

  writeStatus({ stage: "merging" });
  const manifest = buildManifest(resultDoc, status.slides, hintsForPages, { sourceFile: path.resolve(input) });

  writeFileAtomic(manifestPath, manifest);
  fs.writeFileSync(resultPath, JSON.stringify(resultDoc, null, 2));
  fs.writeFileSync(reportPath, JSON.stringify({ ...report, timings: recentTimings() }, null, 2));
  fs.writeFileSync(path.join(outDir, "hints.json"), JSON.stringify(hints, null, 2));
  writeStatus({ status: "review", stage: "review", slides: status.slides, issues: status.issues });
  writeMainAtomic(outDir, mergeSlides(resultDoc, status.slides));

  return { jobId, outDir, result: resultDoc, report, manifest, status, slidesDir };
}

// Backward-compatible alias used by older callers.
export const runPptxVlmDeck = runVlm;
