#!/usr/bin/env node
// UI/server.mjs — localhost-only review dashboard for the full-VLM pipeline.
// Every upload (PDF or PPTX) is routed to src/vlmRun.js. There is no hybrid
// text-layer path and no Modal backend. All output stays under out/vlm/.

import express from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runVlm, markCancelled } from "../src/vlmRun.js";
import { validatePptx } from "../src/input/pptxValidate.js";
import { makeProvider } from "../src/providers/index.js";
import { rerunFigures, translateFigure, translateSlideText, explainFigure } from "../src/extract/slideVlm.js";
import { buildFigureContext } from "../src/figureContext.js";
import { validateFigures, validateTables } from "../src/validate/slideSchema.js";
import { applyRerun, undoRerun } from "../src/slideMerge.js";
import { renderFigureCrop } from "../src/crop.js";
import { tiles2x2, mergeVisibleText, zoomTilesWithVlm } from "../src/zoom.js";
import { mergeSlides, writeMainAtomic, writeFileAtomic } from "../src/mergeMain.js";
import { buildManifest } from "../src/vlmManifest.js";
import { config, missingFor, MAX_PAGES, hasEnvFile } from "../src/config.js";
import { etaFor, formatEtaMs } from "../src/eta.js";
import { genRunId, stripExt } from "../src/util/runName.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const UI_DIR = path.resolve(REPO, "UI");
const OUT_DIR = path.resolve(REPO, config.outputDir, "ui");
const UPLOAD_DIR = path.resolve(REPO, config.outputDir, ".ui-uploads");

const PORT = Number(process.env.PORT) || config.port || 3040;
// Host default keeps the app local-only; the all-in-one container sets HOST=0.0.0.0
// so Docker's -p mapping can reach it.
const HOST = process.env.HOST || "127.0.0.1";

const SUPPORTED_EXTS = new Set([".pdf", ".pptx"]);
const VLM_ID = /^[0-9a-f]{16}$/;

// Optional demo decks: drop a file at one of these paths to enable the buttons
// already present in the shipped dashboard.
const DEMOS = {
  "test.pdf": { path: path.join(REPO, "fixtures", "test.pdf"), name: "test.pdf" },
  "fixtures/scanned.pdf": { path: path.join(REPO, "fixtures", "scanned.pdf"), name: "scanned.pdf" },
  "fixtures/sample.pptx": { path: path.join(REPO, "fixtures", "sample.pptx"), name: "sample.pptx" },
};

const VLM_JOB_ROOT = path.resolve(REPO, config.outputDir, "vlm");
const VLM_JOB_TTL_MS = 24 * 60 * 60 * 1000;

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(VLM_JOB_ROOT, { recursive: true });

// ---------- helpers ----------
function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function vlmJobDir(jobId) {
  if (!VLM_ID.test(String(jobId))) return null;
  const root = path.join(VLM_JOB_ROOT, jobId);
  if (!fs.existsSync(root)) return null;
  const modeDir = fs.readdirSync(root, { withFileTypes: true }).find((e) => e.isDirectory());
  if (!modeDir) return null;
  const modePath = path.join(root, modeDir.name);
  const modelDir = fs.readdirSync(modePath, { withFileTypes: true }).find((e) => e.isDirectory());
  return modelDir ? path.join(modePath, modelDir.name) : null;
}

function readVlmJob(jobId) {
  const dir = vlmJobDir(jobId);
  if (!dir) return null;
  const status = readJsonSafe(path.join(dir, "status.json"));
  const result = readJsonSafe(path.join(dir, "result.json"));
  const report = readJsonSafe(path.join(dir, "run-report.json"));
  const hints = readJsonSafe(path.join(dir, "hints.json"));
  if (!status && !result) return null;
  return { id: String(jobId), dir, mode: "vlm", status, result, report, hints, slidesDir: path.join(dir, "slides") };
}

function sweepVlmJobs() {
  try {
    for (const e of fs.readdirSync(VLM_JOB_ROOT, { withFileTypes: true })) {
      if (!e.isDirectory() || !VLM_ID.test(e.name)) continue;
      const root = path.join(VLM_JOB_ROOT, e.name);
      if (Date.now() - fs.statSync(root).mtimeMs > VLM_JOB_TTL_MS) fs.rmSync(root, { recursive: true, force: true });
    }
  } catch {}
}

function listVlmJobs() {
  sweepVlmJobs();
  const out = [];
  try {
    for (const e of fs.readdirSync(VLM_JOB_ROOT, { withFileTypes: true })) {
      if (!e.isDirectory() || !VLM_ID.test(e.name)) continue;
      const job = readVlmJob(e.name);
      if (!job) continue;
      out.push({
        id: job.id, mode: "vlm",
        input: job.result?.input ?? job.status?.input ?? "input",
        model: job.result?.model ?? job.status?.model ?? null,
        status: job.status?.status ?? "unknown",
        created: job.status?.created ?? fs.statSync(path.join(VLM_JOB_ROOT, e.name)).mtimeMs,
        updated: job.status?.updated ?? null,
        slides: job.result?.slides?.length ?? null,
      });
    }
  } catch {}
  return out;
}

// Rebuild main.json + manifest atomically from the on-disk result + status.
function renderMainAndManifest(vlm, statusesOverride) {
  try {
    const result = readJsonSafe(path.join(vlm.dir, "result.json"));
    if (!result) return null;
    const status = readJsonSafe(path.join(vlm.dir, "status.json"));
    const statuses = statusesOverride ?? status?.slides ?? {};
    const merged = mergeSlides(result, statuses);
    writeMainAtomic(vlm.dir, merged);
    const hints = Array.isArray(vlm.hints) ? vlm.hints.filter((h) => !h?.hidden && !h?.empty) : [];
    const safeHints = hints.length === result.slides?.length ? hints : [];
    const manifest = buildManifest(result, statuses, safeHints, {
      sourceFile: result?.source_file ?? `${result?.input ?? "deck"}`,
    });
    writeFileAtomic(path.join(vlm.dir, "manifest.json"), manifest);
    return { main: merged, manifest };
  } catch (err) {
    console.error("renderMainAndManifest failed:", err);
    return null;
  }
}

function renderMainJson(vlm) { return renderMainAndManifest(vlm)?.main ?? null; }

/** Normalize the persisted slides map into the review queue vocabulary. */
function normalizeSlideStatuses(raw, slides) {
  const map = {};
  for (const slide of slides ?? []) {
    const n = slide?.slide;
    if (n == null) continue;
    const v = raw?.[n];
    map[n] = (v === "approved" || v === "queued" || v === "auto" || v === "failed") ? v
      : slide.failed ? "failed"
      : slide.tables?.length || slide.figures?.length ? "queued"
      : "auto";
  }
  return map;
}

// ---------- app ----------
sweepVlmJobs();

// Track slides currently inside re-run/zoom/translation.
const rerunsInFlight = new Set();
const translationsInFlight = new Set();

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename(_req, file, cb) {
      const ext = path.extname(file.originalname ?? "").toLowerCase().replace(/[^a-z0-9.]/g, "");
      cb(null, `${genRunId()}${ext}`);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
  fileFilter(_req, file, cb) {
    cb(null, SUPPORTED_EXTS.has(path.extname(file.originalname ?? "").toLowerCase()));
  },
});

app.use(express.static(UI_DIR));
app.get("/", (_req, res) => res.sendFile(path.join(UI_DIR, "index.html")));

// --- status ---
app.get("/api/status", (_req, res) => {
  const missing = missingFor();
  res.json({
    ok: missing.length === 0,
    backend: "groq",
    model: config.groqModel,
    missing,
    maxPages: MAX_PAGES,
    dpi: config.dpi,
    limits: { maxFileMb: 50, maxPages: MAX_PAGES },
    figurePassDefault: true,
    supportedExts: [...SUPPORTED_EXTS],
    keys: { GROQ_API_KEY: config.groqApiKey ? "••••set" : "", envFile: hasEnvFile() },
    node: process.version,
    host: `${HOST}:${PORT}`,
  });
});

// --- demos (optional files) ---
app.get("/api/demos", (_req, res) => {
  res.json({
    demos: Object.entries(DEMOS).map(([id, d]) => ({
      id, name: d.name, kind: "full-vlm", tokens: "calls the VLM — costs tokens",
      exists: fs.existsSync(d.path),
    })),
  });
});

// --- analyze: ALL uploads route to full VLM ---
async function handleAnalyze(req, res) {
  let cleanupPath = null;
  try {
    const body = req.body ?? {};
    const demo = typeof body.demo === "string" ? body.demo.trim() : null;
    let inputPath;
    let inputName;

    if (demo) {
      const d = DEMOS[demo];
      if (!d) return res.status(400).json({ error: `Unknown demo: ${demo}. Allowed: ${Object.keys(DEMOS).join(", ")}` });
      if (!fs.existsSync(d.path)) return res.status(400).json({ error: `Demo not found: ${d.path}` });
      inputPath = d.path;
      inputName = d.name;
    } else if (req.file) {
      const ext = path.extname(req.file.originalname ?? "").toLowerCase();
      if (!SUPPORTED_EXTS.has(ext)) {
        fs.rmSync(req.file.path, { force: true });
        return res.status(400).json({ error: `Unsupported file type: ${ext || "unknown"}. Supported: .pdf .pptx` });
      }
      inputPath = req.file.path;
      inputName = req.file.originalname ?? "input";
      cleanupPath = req.file.path;
    } else {
      return res.status(400).json({ error: "Provide a file field (multipart) named 'file' (PDF or PPTX)" });
    }

    // Validate PPTX synchronously so malformed decks get an immediate 400.
    if (path.extname(inputPath).toLowerCase() === ".pptx") {
      try { await validatePptx(inputPath); } catch (err) {
        if (cleanupPath) fs.rmSync(cleanupPath, { force: true });
        return res.status(400).json({ error: String(err?.message ?? err) });
      }
    }

    const missing = missingFor();
    if (missing.length) {
      if (cleanupPath) fs.rmSync(cleanupPath, { force: true });
      return res.status(400).json({ error: `Full-VLM mode needs ${missing.join(", ")} in .env` });
    }

    const jobId = genRunId();
    res.status(202).json({ ok: true, mode: "vlm", jobId, status: "queued" });

    runVlm(inputPath, { jobId, logger: { info() {}, warn() {}, error() {} } })
      .then(() => { if (cleanupPath) fs.rmSync(cleanupPath, { force: true }); })
      .catch((err) => {
        // Overwrite status best-effort so the review screen can surface the failure.
        try {
          const dir = vlmJobDir(jobId);
          if (dir) fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({
            id: jobId, mode: "vlm", model: config.groqModel, input: path.basename(inputName),
            created: Date.now(), updated: Date.now(), status: "failed",
            error: String(err?.message ?? err), slides: {}, issues: [String(err?.message ?? err)],
          }, null, 2));
        } catch {}
        if (cleanupPath) fs.rmSync(cleanupPath, { force: true });
      });
  } catch (err) {
    if (cleanupPath) fs.rmSync(cleanupPath, { force: true });
    const isInputErr = err?.code === "PPTX_INVALID" || err?.name === "PptxValidationError";
    res.status(isInputErr ? 400 : 500).json({ error: String(err?.message ?? err) });
  }
}

app.post("/api/analyze", upload.single("file"), handleAnalyze);

// --- compatibility stubs for the shipped dashboard's history rail ---
app.get("/api/runs", (_req, res) => res.json({ runs: [] }));
app.get("/api/runs/:id", (_req, res) => res.status(404).json({ error: "run not found" }));
app.get("/api/runs/:id/report", (_req, res) => res.status(404).json({ error: "run not found" }));
app.delete("/api/runs/:id", (_req, res) => res.status(404).json({ error: "run not found" }));

// --- jobs ---
app.get("/api/jobs", (_req, res) => res.json({ jobs: listVlmJobs() }));

app.get("/api/jobs/:id", (req, res) => {
  const vlm = readVlmJob(req.params.id);
  if (!vlm) return res.status(404).json({ error: "job not found" });
  const statusObj = readJsonSafe(path.join(vlm.dir, "status.json"));
  const statuses = normalizeSlideStatuses(statusObj?.slides, vlm.result?.slides ?? []);
  const queue = Object.keys(statuses).filter((n) => statuses[n] === "queued" || statuses[n] === "failed").map(Number).sort((a, b) => a - b);
  const skipped = Object.keys(statuses).filter((n) => statuses[n] === "auto").map(Number).sort((a, b) => a - b);
  const created = vlm.result?.created ?? statusObj?.created ?? null;
  const done = Object.values(statuses).filter((s) => ["done", "approved", "reviewing", "auto", "failed", "queued"].includes(s)).length;
  const queuedCount = Object.values(statuses).filter((s) => s === "queued").length;
  const startedAt = statusObj?.startedAt ?? created ?? null;
  const total = vlm.result?.slides?.length ?? 0;
  const etaMs = startedAt != null ? etaFor({ done, total, startedAt, now: Date.now() }) : null;
  res.json({
    job: {
      id: vlm.id, mode: "vlm",
      input: vlm.result?.input ?? statusObj?.input ?? "input",
      model: vlm.result?.model ?? statusObj?.model ?? null,
      status: statusObj?.status ?? "unknown",
      stage: statusObj?.status ?? null,
      created, updated: statusObj?.updated ?? created,
      error: statusObj?.error ?? null,
      slides: vlm.result?.slides?.length ?? 0,
      issues: statusObj?.issues ?? [],
      translations: statusObj?.translations ?? {},
      outDir: vlm.dir,
      queue, skipped, statuses,
      progress: {
        done, total, queued: queuedCount,
        stage: statusObj?.stage ?? statusObj?.status ?? null,
        startedAt, etaMs, etaText: etaMs == null ? null : formatEtaMs(etaMs),
      },
    },
    result: vlm.result,
    report: vlm.report,
  });
});

// GET crop preview of figure i (normalized box from source.pdf).
app.get("/api/jobs/:id/slides/:n/crop/:i", async (req, res) => {
  if (!VLM_ID.test(req.params.id)) return res.status(400).json({ error: "invalid job id" });
  const vlm = readVlmJob(req.params.id);
  if (!vlm || !vlm.result) return res.status(404).json({ error: "job result not found" });
  const n = Number.parseInt(req.params.n, 10);
  const figIdx = Number.parseInt(req.params.i, 10);
  if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: "slide number out of range" });
  if (!Number.isInteger(figIdx) || figIdx < 0) return res.status(400).json({ error: "figure index out of range" });
  const fig = vlm.result?.slides?.[n - 1]?.figures?.[figIdx];
  if (!fig) return res.status(404).json({ error: "figure not found" });
  if (!Array.isArray(fig.bbox)) return res.status(400).json({ error: "figure has no bounding box — draw one first" });
  try {
    const outPng = path.join(vlm.dir, "crops", `preview-${figIdx}.png`);
    await renderFigureCrop(path.join(vlm.dir, "source.pdf"), n, fig.bbox, outPng, { pad: 0.03, dpi: 300 });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    fs.createReadStream(outPng).pipe(res);
  } catch (err) {
    res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// GET rendered slide image.
app.get("/api/jobs/:id/slides/:n", (req, res) => {
  if (!VLM_ID.test(req.params.id)) return res.status(400).json({ error: "invalid job id" });
  const n = Number.parseInt(req.params.n, 10);
  if (!Number.isInteger(n) || n < 1 || n > 100) return res.status(400).json({ error: "slide number out of range" });
  const vlm = readVlmJob(req.params.id);
  if (!vlm) return res.status(404).json({ error: "job not found" });
  const file = path.join(vlm.slidesDir, `${String(n).padStart(2, "0")}.png`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: "slide image not found" });
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "private, max-age=86400");
  fs.createReadStream(file).pipe(res);
});

// PUT edited figures/tables for one slide (refuses approved slides).
app.put("/api/jobs/:id/slides/:n", (req, res) => {
  if (!VLM_ID.test(req.params.id)) return res.status(400).json({ error: "invalid job id" });
  const n = Number.parseInt(req.params.n, 10);
  if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: "slide number out of range" });
  const vlm = readVlmJob(req.params.id);
  if (!vlm || !vlm.result) return res.status(404).json({ error: "job result not found" });
  const idx = n - 1;
  const current = vlm.result?.slides?.[idx];
  if (!current) return res.status(400).json({ error: `slide ${n} out of range` });

  const status = readJsonSafe(path.join(vlm.dir, "status.json"));
  if (status?.slides?.[n] === "approved") return res.status(409).json({ error: "slide is approved — reopen it first" });

  const body = req.body?.json ?? req.body ?? {};
  const figures = Array.isArray(body.figures) ? body.figures : [];
  const tables = Array.isArray(body.tables) ? body.tables : [];
  const figCheck = validateFigures(figures);
  if (!figCheck.ok) return res.status(400).json({ error: "figures JSON failed schema validation: " + figCheck.errors.slice(0, 6).join("; ") });
  const tableCheck = validateTables(tables);
  if (!tableCheck.ok) return res.status(400).json({ error: "tables JSON failed schema validation: " + tableCheck.errors.slice(0, 6).join("; ") });

  const slide = { ...current, figures, tables, failed: false, reviewed: false, rerun_count: current.rerun_count ?? 0, previous: undefined };
  delete slide.previous;
  const hadAny = (current.figures?.length ?? 0) > 0 || (current.tables?.length ?? 0) > 0;
  const nowAny = figures.length > 0 || tables.length > 0;

  vlm.result.slides[idx] = slide;
  try {
    fs.writeFileSync(path.join(vlm.dir, "result.json"), JSON.stringify(vlm.result, null, 2));
    if (status) {
      status.updated = Date.now();
      let slideStatus = status.slides?.[n] ?? (nowAny ? "queued" : "auto");
      if (!hadAny && nowAny) slideStatus = "queued";
      status.slides = { ...(status.slides ?? {}), [n]: slideStatus };
      fs.writeFileSync(path.join(vlm.dir, "status.json"), JSON.stringify(status, null, 2));
    }
    const main = renderMainJson(vlm);
    res.json({ ok: true, slide, main: main ? { jobId: main.jobId, slides: main.slides.length } : null });
  } catch (err) {
    res.status(500).json({ error: String(err?.message ?? err) });
  }
});

const RERUN_LIMIT = 5;
const NOTE_LIMIT = 1000;
const isStr = (v) => typeof v === "string";

// POST guided re-run of figures & tables.
app.post("/api/jobs/:id/slides/:n/rerun", async (req, res) => {
  if (!VLM_ID.test(req.params.id)) return res.status(400).json({ error: "invalid job id" });
  const n = Number.parseInt(req.params.n, 10);
  if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: "slide number out of range" });
  const vlm = readVlmJob(req.params.id);
  if (!vlm || !vlm.result) return res.status(404).json({ error: "job result not found" });
  const idx = n - 1;
  const current = vlm.result?.slides?.[idx];
  if (!current) return res.status(400).json({ error: `slide ${n} out of range` });
  if (current.failed) return res.status(422).json({ error: "slide analysis failed — re-run from the initial page instead" });
  if (readJsonSafe(path.join(vlm.dir, "status.json"))?.slides?.[n] === "approved") return res.status(409).json({ error: "slide is approved — reopen it first" });
  rerunsInFlight.add(`${req.params.id}:${n}`);
  try {
    const rerunCount = Number(current.rerun_count ?? 0);
    if (rerunCount >= RERUN_LIMIT) return res.status(429).json({ error: `re-run limit reached for slide ${n} (${RERUN_LIMIT}/slide)` });
    if ((isStr(req.body?.slideNote) ? req.body.slideNote.length : 0) > NOTE_LIMIT) {
      return res.status(400).json({ error: `slideNote exceeds the ${NOTE_LIMIT}-character limit` });
    }
    const slideNote = isStr(req.body?.slideNote) ? req.body.slideNote.slice(0, NOTE_LIMIT) : "";
    const figureNotes = Array.isArray(req.body?.figureNotes)
      ? req.body.figureNotes.map((fn) => ({ index: Number(fn?.index), note: String(fn?.note ?? "").slice(0, NOTE_LIMIT) })).filter((fn) => Number.isInteger(fn.index))
      : [];
    const missing = missingFor();
    if (missing.length) return res.status(400).json({ error: `rerun needs ${missing.join(", ")}` });
    const pngPath = path.join(vlm.slidesDir, `${String(n).padStart(2, "0")}.png`);
    if (!fs.existsSync(pngPath)) return res.status(400).json({ error: "slide image missing — cannot rerun" });

    const figureIndexes = Array.isArray(req.body?.figureIndexes)
      ? req.body.figureIndexes.filter((i) => Number.isInteger(i) && i >= 0 && i < (current.figures?.length ?? 0))
      : null;
    const cropDir = path.join(vlm.dir, "crops");
    const crops = [];
    if (figureIndexes?.length) {
      for (const i of figureIndexes.slice(0, 2)) {
        const f = current.figures?.[i];
        if (!Array.isArray(f?.bbox)) continue;
        try {
          const outPng = path.join(cropDir, `rerun-${i}.png`);
          await renderFigureCrop(path.join(vlm.dir, "source.pdf"), n, f.bbox, outPng, { pad: 0.03, dpi: 300 });
          crops.push({ path: outPng, index: i, label: `Figure ${i + 1} crop` });
        } catch {}
      }
    }
    const logger = { info() {}, warn() {}, error() {} };
    const { figures, tables, auditIssues } = await rerunFigures({
      pngPath, currentSlide: current, slideNote, figureNotes,
      nativeHints: (vlm.hints ?? [])[idx] ?? null,
      provider: makeProvider("groq"), logger, crops,
    });
    const merged = applyRerun(current, { figures, tables }, (vlm.hints ?? [])[idx] ?? null);
    merged.issues = [...(merged.issues ?? []), ...(auditIssues ?? [])];

    const cropByIndex = new Map(crops.map((c) => [c.index, c.path]));
    const grounded = await groundFigureExplanations(
      vlm, n, merged.figures, makeProvider(), (i) => cropByIndex.get(i) ?? null,
      { ...vlm.result, slides: vlm.result.slides.map((s, i) => (i === idx ? merged : s)) },
      logger,
    );
    merged.figures = grounded.figures;

    vlm.result.slides[idx] = merged;
    fs.writeFileSync(path.join(vlm.dir, "result.json"), JSON.stringify(vlm.result, null, 2));
    try {
      const status = readJsonSafe(path.join(vlm.dir, "status.json"));
      if (status) {
        status.updated = Date.now();
        status.slides = { ...(status.slides ?? {}), [n]: "done" };
        fs.writeFileSync(path.join(vlm.dir, "status.json"), JSON.stringify(status, null, 2));
      }
    } catch {}
    res.json({ ok: true, slide: merged });
  } catch (err) {
    res.status(422).json({ error: String(err?.message ?? err) });
  } finally {
    rerunsInFlight.delete(`${req.params.id}:${n}`);
  }
});

// POST zoom pass: 2x2 high-DPI tiles -> merged visible_text.
app.post("/api/jobs/:id/slides/:n/zoom", async (req, res) => {
  if (!VLM_ID.test(req.params.id)) return res.status(400).json({ error: "invalid job id" });
  const n = Number.parseInt(req.params.n, 10);
  if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: "slide number out of range" });
  const vlm = readVlmJob(req.params.id);
  if (!vlm || !vlm.result) return res.status(404).json({ error: "job result not found" });
  const idx = n - 1;
  const current = vlm.result?.slides?.[idx];
  if (!current) return res.status(400).json({ error: `slide ${n} out of range` });
  if (current.failed) return res.status(422).json({ error: "slide analysis failed — re-run first" });
  if (readJsonSafe(path.join(vlm.dir, "status.json"))?.slides?.[n] === "approved") return res.status(409).json({ error: "slide is approved — reopen it first" });
  rerunsInFlight.add(`${req.params.id}:${n}`);
  try {
    const figIdx = Number.parseInt(req.body?.figureIndex, 10);
    const fig = current.figures?.[figIdx];
    if (!Number.isInteger(figIdx) || figIdx < 0) return res.status(400).json({ error: "figureIndex must be a non-negative integer" });
    if (!fig) return res.status(404).json({ error: `figure ${figIdx + 1} not found on this slide` });
    if (!Array.isArray(fig.bbox)) return res.status(400).json({ error: "figure has no bounding box — draw one first" });

    const rerunCount = Number(current.rerun_count ?? 0);
    if (rerunCount >= RERUN_LIMIT) return res.status(429).json({ error: `re-run limit reached for slide ${n} (${RERUN_LIMIT}/slide)` });
    const sourcePdf = path.join(vlm.dir, "source.pdf");
    if (!fs.existsSync(sourcePdf)) return res.status(400).json({ error: "source PDF no longer exists for this job" });
    const missing = missingFor();
    if (missing.length) return res.status(400).json({ error: `zoom needs ${missing.join(", ")}` });

    const cropDir = path.join(vlm.dir, "crops");
    fs.mkdirSync(cropDir, { recursive: true });
    const logger = { info() {}, warn() {}, error() {} };
    const tileBoxes = tiles2x2(fig.bbox);
    const fullCrop = path.join(cropDir, `zoom-full-${figIdx}.png`);
    await renderFigureCrop(sourcePdf, n, fig.bbox, fullCrop, { pad: 0, dpi: 300, maxDim: 2048 });
    const tilePaths = [];
    for (const [i, tileBox] of tileBoxes.entries()) {
      const tilePng = path.join(cropDir, `zoom-tile-${figIdx}-${i}.png`);
      await renderFigureCrop(sourcePdf, n, tileBox, tilePng, { pad: 0, dpi: 300, maxDim: 2048 });
      tilePaths.push(tilePng);
    }
    const tileLists = await zoomTilesWithVlm({ provider: makeProvider("groq"), fullCropPath: fullCrop, tilePaths, logger });
    const mergedText = mergeVisibleText(fig.visible_text ?? [], tileLists);
    const failedTiles = tileLists.filter((l) => l.length === 0).length;
    const updated = {
      ...current,
      figures: current.figures.map((f, i) => (i === figIdx ? { ...f, visible_text: mergedText } : f)),
      rerun_count: rerunCount + 1,
    };
    if (failedTiles > 0) updated.issues = [...(updated.issues ?? []), `zoom: ${failedTiles} tile(s) unreadable`];
    vlm.result.slides[idx] = updated;
    fs.writeFileSync(path.join(vlm.dir, "result.json"), JSON.stringify(vlm.result, null, 2));
    try {
      const status = readJsonSafe(path.join(vlm.dir, "status.json"));
      if (status) {
        status.updated = Date.now();
        status.slides = { ...(status.slides ?? {}), [n]: "done" };
        fs.writeFileSync(path.join(vlm.dir, "status.json"), JSON.stringify(status, null, 2));
      }
    } catch {}
    res.json({ ok: true, slide: updated, tilesProcessed: tileBoxes.length - failedTiles });
  } finally {
    rerunsInFlight.delete(`${req.params.id}:${n}`);
  }
});

// Grounded explanation pass for a set of figures.
async function groundFigureExplanations(vlm, n, figures, provider, cropFor = () => null, resultOverride = null, log = { info() {}, warn() {}, error() {} }) {
  const out = [];
  const failures = [];
  let grounded = 0;
  for (const [i, fig] of (figures ?? []).entries()) {
    if (!fig || fig.excluded) { out.push(fig); continue; }
    const fallback = path.join(vlm.slidesDir, `${String(n).padStart(2, "0")}.png`);
    const cropPath = cropFor(i) ?? (Array.isArray(fig.bbox) && fs.existsSync(fallback) ? fallback : null);
    if (!cropPath || !fs.existsSync(cropPath)) { out.push(fig); continue; }
    try {
      const context = buildFigureContext({ result: resultOverride ?? vlm.result, hints: vlm.hints, slideNumber: n, figureIndex: i });
      const r = await explainFigure({ cropPath, figure: fig, context, provider, logger: log });
      out.push({
        ...fig,
        visual_description: fig.description,
        description: r.explanation,
        explanation_evidence: r.evidence,
        explanation_labels: r.labels,
        explanation_audit: r.audit,
        needs_review: !r.audit.ok ? true : fig.needs_review,
      });
      grounded += 1;
    } catch (err) {
      failures.push(`figure ${i + 1}: ${String(err?.message ?? err)}`);
      out.push(fig);
    }
  }
  return { figures: out, grounded, failures };
}

// Translate a slide's prose and figures into English via the VLM.
async function translateSlide(vlm, n) {
  const idx = n - 1;
  const current = vlm.result?.slides?.[idx];
  if (!current) return { translated: 0, failures: [], updated: null };

  const slidePng = path.join(vlm.slidesDir, `${String(n).padStart(2, "0")}.png`);
  const sourcePdf = path.join(vlm.dir, "source.pdf");
  const cropDir = path.join(vlm.dir, "crops");
  fs.mkdirSync(cropDir, { recursive: true });
  const logger = { info() {}, warn() {}, error() {} };
  const provider = makeProvider("groq");
  let translated = 0;
  const failures = [];
  let prose = null;

  if (fs.existsSync(slidePng)) {
    try {
      prose = await translateSlideText({ pngPath: slidePng, slide: current, provider, logger });
      translated += 1;
    } catch (err) {
      failures.push(`text: ${String(err?.message ?? err)}`);
    }
  }

  const figures = current.figures ?? [];
  const cropPaths = [];
  const nextFigures = await Promise.all(figures.map(async (f, i) => {
    if (f?.excluded) return f;
    try {
      let cropPath = slidePng;
      if (Array.isArray(f.bbox) && fs.existsSync(sourcePdf)) {
        cropPath = path.join(cropDir, `translate-${i}.png`);
        await renderFigureCrop(sourcePdf, n, f.bbox, cropPath, { pad: 0.03, dpi: 300 });
      }
      cropPaths[i] = cropPath;
      const en = await translateFigure({ cropPath, figure: f, provider, logger });
      translated += 1;
      return {
        ...f,
        title: en.title,
        visual_description: f.description,
        description: en.description,
        visible_text: en.visible_text,
        description_terms: en.description_terms ?? [],
        description_audit: en.description_audit ?? null,
        translated: true,
      };
    } catch (err) {
      failures.push(`figure ${i + 1}: ${String(err?.message ?? err)}`);
      return f;
    }
  }));

  const updated = { ...current, figures: nextFigures };
  if (prose) {
    if (prose.title !== null) updated.title = prose.title;
    if (prose.subtitle !== null) updated.subtitle = prose.subtitle;
    if (prose.speaker_notes !== null) updated.speaker_notes = prose.speaker_notes;
    updated.text_blocks = (current.text_blocks ?? []).map((b, i) => (
      typeof prose.text_blocks[i] === "string" ? { ...b, text: prose.text_blocks[i] } : b
    ));
  }

  const contextResult = { ...vlm.result, slides: [...(vlm.result?.slides ?? [])] };
  contextResult.slides[idx] = updated;
  const grounded = await groundFigureExplanations(vlm, n, updated.figures, provider, (i) => cropPaths[i] ?? null, contextResult, logger);
  updated.figures = grounded.figures;
  translated += grounded.grounded;
  failures.push(...grounded.failures);

  if (failures.length === 0) updated.translated = true;
  return { translated, failures, updated };
}

function setTranslationState(vlm, n, state, extra = {}) {
  try {
    const p = path.join(vlm.dir, "status.json");
    const status = readJsonSafe(p) ?? {};
    status.translations = { ...(status.translations ?? {}), [n]: { state, at: Date.now(), ...extra } };
    status.updated = Date.now();
    writeFileAtomic(p, status);
  } catch {}
}

app.post("/api/jobs/:id/slides/:n/translate-figures", async (req, res) => {
  if (!VLM_ID.test(req.params.id)) return res.status(400).json({ error: "invalid job id" });
  const n = Number.parseInt(req.params.n, 10);
  if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: "slide number out of range" });
  const vlm = readVlmJob(req.params.id);
  if (!vlm || !vlm.result) return res.status(404).json({ error: "job result not found" });
  const current = vlm.result?.slides?.[n - 1];
  if (!current) return res.status(400).json({ error: `slide ${n} out of range` });
  if (current.failed) return res.status(422).json({ error: "slide analysis failed — re-run first" });
  const key = `${req.params.id}:${n}`;
  if (rerunsInFlight.has(key)) return res.status(409).json({ error: "re-run in progress for this slide — try again when it finishes" });
  if (translationsInFlight.has(key)) return res.status(409).json({ error: "translation in progress for this slide — try again when it finishes" });
  const missing = missingFor();
  if (missing.length) return res.status(400).json({ error: `translate needs ${missing.join(", ")}` });

  translationsInFlight.add(key);
  setTranslationState(vlm, n, "translating");
  try {
    const { translated, failures, updated } = await translateSlide(vlm, n);
    if (!updated) return res.status(404).json({ error: "slide vanished during translation" });
    vlm.result.slides[n - 1] = updated;
    fs.writeFileSync(path.join(vlm.dir, "result.json"), JSON.stringify(vlm.result, null, 2));
    const main = renderMainJson(vlm);
    setTranslationState(vlm, n, failures.length ? "translate_failed" : "translated", { translated, failures });
    res.json({ ok: true, translated, failures, main: main ? { jobId: main.jobId, slides: main.slides.length } : null, slide: updated });
  } catch (err) {
    setTranslationState(vlm, n, "translate_failed", { error: String(err?.message ?? err) });
    res.status(422).json({ error: String(err?.message ?? err) });
  } finally {
    translationsInFlight.delete(key);
  }
});

// POST re-extract one figure's text + grounded explanation at high DPI.
app.post("/api/jobs/:id/slides/:n/figures/:i/reextract-text", async (req, res) => {
  if (!VLM_ID.test(req.params.id)) return res.status(400).json({ error: "invalid job id" });
  const n = Number.parseInt(req.params.n, 10);
  const figIdx = Number.parseInt(req.params.i, 10);
  if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: "slide number out of range" });
  if (!Number.isInteger(figIdx) || figIdx < 0) return res.status(400).json({ error: "figure index out of range" });
  const vlm = readVlmJob(req.params.id);
  if (!vlm || !vlm.result) return res.status(404).json({ error: "job result not found" });
  const idx = n - 1;
  const slide = vlm.result?.slides?.[idx];
  const fig = slide?.figures?.[figIdx];
  if (!slide || !fig) return res.status(404).json({ error: "figure not found" });
  if (fig.excluded) return res.status(400).json({ error: "excluded figures are not re-extracted" });
  const key = `${req.params.id}:${n}`;
  if (rerunsInFlight.has(key) || translationsInFlight.has(key)) return res.status(409).json({ error: "re-run or translation in progress for this slide" });
  const missing = missingFor();
  if (missing.length) return res.status(400).json({ error: `re-extraction needs ${missing.join(", ")}` });

  translationsInFlight.add(key);
  try {
    const provider = makeProvider("groq");
    const logger = { info() {}, warn() {}, error() {} };
    const slidePng = path.join(vlm.slidesDir, `${String(n).padStart(2, "0")}.png`);
    const sourcePdf = path.join(vlm.dir, "source.pdf");
    let cropPath = slidePng;
    if (Array.isArray(fig.bbox) && fs.existsSync(sourcePdf)) {
      cropPath = path.join(vlm.dir, "crops", `reextract-${n}-${figIdx}.png`);
      fs.mkdirSync(path.dirname(cropPath), { recursive: true });
      await renderFigureCrop(sourcePdf, n, fig.bbox, cropPath, { pad: 0.04, dpi: 450 });
    }
    if (!fs.existsSync(cropPath)) return res.status(400).json({ error: "figure image unavailable" });

    const en = await translateFigure({ cropPath, figure: fig, provider, logger });
    const literal = {
      ...fig,
      title: en.title,
      visible_text: en.visible_text,
      visual_description: en.description,
      description: en.description,
      description_terms: en.description_terms ?? [],
      description_audit: en.description_audit ?? null,
    };
    const contextResult = {
      ...vlm.result,
      slides: vlm.result.slides.map((s, i) => (i === idx
        ? { ...slide, figures: slide.figures.map((f, j) => (j === figIdx ? literal : f)) }
        : s)),
    };
    const grounded = await groundFigureExplanations(vlm, n, [literal], provider, () => cropPath, contextResult, logger);
    const updated = grounded.figures[0] ?? literal;
    slide.figures[figIdx] = updated;
    fs.writeFileSync(path.join(vlm.dir, "result.json"), JSON.stringify(vlm.result, null, 2));
    renderMainAndManifest(vlm);
    res.json({ ok: true, figure: updated, audit: updated.explanation_audit ?? null, failures: grounded.failures });
  } catch (err) {
    res.status(422).json({ error: String(err?.message ?? err) });
  } finally {
    translationsInFlight.delete(key);
  }
});

app.post("/api/jobs/:id/translate-all", async (req, res) => {
  if (!VLM_ID.test(req.params.id)) return res.status(400).json({ error: "invalid job id" });
  const vlm = readVlmJob(req.params.id);
  if (!vlm || !vlm.result) return res.status(404).json({ error: "job result not found" });
  const missing = missingFor();
  if (missing.length) return res.status(400).json({ error: `translate needs ${missing.join(", ")}` });

  const status0 = readJsonSafe(path.join(vlm.dir, "status.json")) ?? {};
  const targets = (vlm.result?.slides ?? [])
    .filter((s) => status0.slides?.[s.slide] === "approved" && !s.translated && !s.failed && !translationsInFlight.has(`${req.params.id}:${s.slide}`))
    .map((s) => s.slide);
  if (targets.length === 0) return res.json({ ok: true, queued: 0, note: "no approved slides need translation" });

  const results = [];
  for (const n of targets) {
    const key = `${req.params.id}:${n}`;
    translationsInFlight.add(key);
    setTranslationState(vlm, n, "translating");
    try {
      const fresh = readVlmJob(req.params.id);
      const { translated, failures, updated } = await translateSlide(fresh, n);
      if (updated) {
        fresh.result.slides[n - 1] = updated;
        fs.writeFileSync(path.join(fresh.dir, "result.json"), JSON.stringify(fresh.result, null, 2));
        setTranslationState(fresh, n, failures.length ? "translate_failed" : "translated", { translated, failures });
      }
      results.push({ slide: n, translated, failures });
    } catch (err) {
      setTranslationState(vlm, n, "translate_failed", { error: String(err?.message ?? err) });
      results.push({ slide: n, error: String(err?.message ?? err) });
    } finally {
      translationsInFlight.delete(key);
    }
  }
  renderMainAndManifest(readVlmJob(req.params.id));
  res.json({ ok: true, queued: targets.length, results });
});

// POST approve the current editor state -> merge into main.json atomically.
app.post("/api/jobs/:id/slides/:n/approve", (req, res) => {
  if (!VLM_ID.test(req.params.id)) return res.status(400).json({ error: "invalid job id" });
  const n = Number.parseInt(req.params.n, 10);
  if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: "slide number out of range" });
  const key = `${req.params.id}:${n}`;
  if (rerunsInFlight.has(key)) return res.status(409).json({ error: "re-run in progress for this slide — try again when it finishes" });
  const vlm = readVlmJob(req.params.id);
  if (!vlm || !vlm.result) return res.status(404).json({ error: "job result not found" });
  const idx = n - 1;
  const current = vlm.result?.slides?.[idx];
  if (!current) return res.status(400).json({ error: `slide ${n} out of range` });

  const status = readJsonSafe(path.join(vlm.dir, "status.json"));
  if (status?.slides?.[n] === "approved") {
    return res.json({ ok: true, slide: current, alreadyApproved: true, main: renderMainJson(vlm) });
  }

  const body = req.body?.json ?? req.body ?? {};
  const figures = Array.isArray(body.figures) ? body.figures : current.figures ?? [];
  const tables = Array.isArray(body.tables) ? body.tables : current.tables ?? [];
  const figCheck = validateFigures(figures);
  if (!figCheck.ok) return res.status(400).json({ error: "figures JSON failed schema validation: " + figCheck.errors.slice(0, 6).join("; ") });
  const tableCheck = validateTables(tables);
  if (!tableCheck.ok) return res.status(400).json({ error: "tables JSON failed schema validation: " + tableCheck.errors.slice(0, 6).join("; ") });

  const slide = { ...current, figures, tables, failed: false, reviewed: true, previous: undefined };
  delete slide.previous;
  vlm.result.slides[idx] = slide;
  try {
    fs.writeFileSync(path.join(vlm.dir, "result.json"), JSON.stringify(vlm.result, null, 2));
    if (status) {
      status.updated = Date.now();
      status.slides = { ...(status.slides ?? {}), [n]: "approved" };
      fs.writeFileSync(path.join(vlm.dir, "status.json"), JSON.stringify(status, null, 2));
    }
    const main = renderMainJson(vlm);
    res.json({ ok: true, slide, main: main ? { jobId: main.jobId, slides: main.slides.length } : null });
  } catch (err) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }

  // Auto-translate after approval (fire-and-forget); never blocks approval.
  if (!translationsInFlight.has(key)) {
    const missing = missingFor();
    if (missing.length) {
      setTranslationState(vlm, n, "translate_failed", { error: `config missing: ${missing.join(", ")}` });
    } else {
      translationsInFlight.add(key);
      setTranslationState(vlm, n, "translating");
      (async () => {
        try {
          const { translated, failures, updated } = await translateSlide(vlm, n);
          if (updated) {
            vlm.result.slides[idx] = updated;
            fs.writeFileSync(path.join(vlm.dir, "result.json"), JSON.stringify(vlm.result, null, 2));
            renderMainAndManifest(vlm);
            setTranslationState(vlm, n, failures.length ? "translate_failed" : "translated", { translated, failures });
          }
          console.error(`translate: job ${req.params.id} slide ${n} → ${translated} field(s), ${failures.length} failure(s)`);
        } catch (err) {
          setTranslationState(vlm, n, "translate_failed", { error: String(err?.message ?? err) });
        } finally {
          translationsInFlight.delete(key);
        }
      })();
    }
  }
});

// POST reopen an approved slide for editing.
app.post("/api/jobs/:id/slides/:n/reopen", (req, res) => {
  if (!VLM_ID.test(req.params.id)) return res.status(400).json({ error: "invalid job id" });
  const n = Number.parseInt(req.params.n, 10);
  if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: "slide number out of range" });
  const vlm = readVlmJob(req.params.id);
  if (!vlm || !vlm.result) return res.status(404).json({ error: "job result not found" });
  if (!vlm.result?.slides?.[n - 1]) return res.status(400).json({ error: `slide ${n} out of range` });
  const status = readJsonSafe(path.join(vlm.dir, "status.json"));
  if (status?.slides?.[n] !== "approved") return res.status(400).json({ error: "slide is not approved" });
  status.updated = Date.now();
  status.slides = { ...(status.slides ?? {}), [n]: "queued" };
  fs.writeFileSync(path.join(vlm.dir, "status.json"), JSON.stringify(status, null, 2));
  const main = renderMainJson(vlm);
  res.json({ ok: true, main: main ? { jobId: main.jobId, slides: main.slides.length } : null });
});

app.post("/api/jobs/:id/cancel", (req, res) => {
  if (!VLM_ID.test(req.params.id)) return res.status(400).json({ error: "invalid job id" });
  const vlm = readVlmJob(req.params.id);
  if (!vlm) return res.status(404).json({ error: "job not found" });
  const statusObj = readJsonSafe(path.join(vlm.dir, "status.json"));
  if (!statusObj || ["done", "failed", "review"].includes(statusObj.status)) {
    return res.json({ ok: true, note: "nothing to cancel — job is already finished" });
  }
  markCancelled(req.params.id);
  statusObj.status = "failed";
  statusObj.error = "cancelled";
  statusObj.updated = Date.now();
  try { fs.writeFileSync(path.join(vlm.dir, "status.json"), JSON.stringify(statusObj, null, 2)); } catch {}
  res.json({ ok: true, cancelled: true });
});

app.post("/api/jobs/:id/retry-failed", (req, res) => {
  if (!VLM_ID.test(req.params.id)) return res.status(400).json({ error: "invalid job id" });
  const vlm = readVlmJob(req.params.id);
  if (!vlm || !vlm.result) return res.status(404).json({ error: "job result not found" });
  const failed = vlm.result.slides.filter((s) => s?.failed).map((s) => s.slide);
  if (failed.length === 0) return res.json({ ok: true, retried: [] });
  res.json({ ok: true, retried: failed, note: "use per-slide Re-run for each failed slide" });
});

app.post("/api/jobs/:id/slides/:n/undo-rerun", (req, res) => {
  if (!VLM_ID.test(req.params.id)) return res.status(400).json({ error: "invalid job id" });
  const n = Number.parseInt(req.params.n, 10);
  if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: "slide number out of range" });
  const vlm = readVlmJob(req.params.id);
  if (!vlm || !vlm.result) return res.status(404).json({ error: "job result not found" });
  const idx = n - 1;
  const current = vlm.result?.slides?.[idx];
  if (!current) return res.status(400).json({ error: `slide ${n} out of range` });
  const restored = undoRerun(current);
  if (!restored) return res.status(400).json({ error: "nothing to undo — no re-run on this slide" });
  vlm.result.slides[idx] = restored;
  try {
    fs.writeFileSync(path.join(vlm.dir, "result.json"), JSON.stringify(vlm.result, null, 2));
    res.json({ ok: true, slide: restored });
  } catch (err) {
    res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// GET export — download the merged deliverable (main.json).
app.get("/api/jobs/:id/export", (req, res) => {
  if (!VLM_ID.test(req.params.id)) return res.status(400).json({ error: "invalid job id" });
  const vlm = readVlmJob(req.params.id);
  if (!vlm || !vlm.result) return res.status(404).json({ error: "job result not found" });
  const base = stripExt(vlm.result.input ?? "deck") || "deck";
  const statusRaw = readJsonSafe(path.join(vlm.dir, "status.json")) ?? {};
  const statuses = normalizeSlideStatuses(statusRaw?.slides, vlm.result.slides ?? []);
  if (!renderMainAndManifest(vlm, statuses)) return res.status(500).json({ error: "failed to rebuild the merged deliverable" });
  const mainPath = path.join(vlm.dir, "main.json");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${base.replace(/[^a-zA-Z0-9._-]/g, "_")}.json"`);
  fs.createReadStream(mainPath).pipe(res);
});

// DELETE a job and all its artifacts.
app.delete("/api/jobs/:id", (req, res) => {
  if (!VLM_ID.test(req.params.id)) return res.status(400).json({ error: "invalid job id" });
  const dir = vlmJobDir(req.params.id);
  if (!dir) return res.status(404).json({ error: "job not found" });
  const resolved = path.resolve(path.join(VLM_JOB_ROOT, req.params.id));
  if (!resolved.startsWith(VLM_JOB_ROOT + path.sep)) return res.status(500).json({ error: "path safety check failed" });
  fs.rmSync(resolved, { recursive: true, force: true });
  res.json({ ok: true });
});

app.listen(PORT, HOST, () => {
  console.log(`Full-VLM parser → http://${HOST}:${PORT}`);
  const runtime = config.inContainer ? "all-in-one container"
    : config.useDocker ? `docker (${config.dockerImage})` : "local --no-docker";
  console.log(`Model: ${config.groqModel}   Processing: ${runtime}`);
});
