// src/input/pptxToPdf.js — PPTX -> PDF conversion.
//
// Docker mode: LibreOffice headless inside the single unified image
//              `full-vlm-parser:latest`. No host soffice, ever.
// No-Docker:   approximate local render via python-pptx + Pillow -> PyMuPDF PDF
//              (enabled by `npm run setup --no-docker`).
//
// Each conversion gets a per-job directory under <repo>/data/convert/<jobId>/
// with an input copy and an isolated LibreOffice profile.

import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { config } from "../config.js";
import { hideEmptySlides, pptxToPdfApprox } from "../pymupdf/run.js";
import {
  DOCKER_IMAGE,
  baseRunArgs,
  ensureImage,
  killDockerContainer,
  runDocker,
  toDockerPath,
} from "../docker.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

const int = (name, fallback) => {
  const v = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
const TIMEOUT = () => int("PPTX_CONVERT_TIMEOUT_MS", 120_000);
const CONCURRENCY = () => int("PPTX_CONVERT_CONCURRENCY", 2);
const JOB_ROOT = () => path.resolve(process.env.PPTX_JOB_ROOT ?? path.join(REPO_ROOT, "data", "convert"));
const TMP_ROOT = path.join(REPO_ROOT, "data", "tmp");

export class PptxConversionError extends Error {
  constructor(message, { cause, stderr } = {}) {
    super(message);
    this.name = "PptxConversionError";
    this.code = "PPTX_CONVERT_FAILED";
    this.cause = cause;
    this.stderr = stderr;
  }
}

// ── Concurrency semaphore ──────────────────────────────────────────────────
let active = 0;
const waiters = [];
function acquire() {
  if (active < CONCURRENCY()) { active++; return Promise.resolve(); }
  return new Promise((resolve) => waiters.push(resolve));
}
function release() {
  active--;
  const next = waiters.shift();
  if (next) { active++; next(); }
}
export function conversionsInFlight() { return active; }

const silent = () => {};

async function removeQuiet(target) {
  try { await fs.promises.rm(target, { recursive: true, force: true }); } catch {}
}

async function moveToTmp(from) {
  await fs.promises.mkdir(TMP_ROOT, { recursive: true });
  const tmp = path.join(TMP_ROOT, `full-vlm-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.pdf`);
  await fs.promises.rename(from, tmp);
  return tmp;
}

function jobPaths(jobId) {
  const jobDir = path.join(JOB_ROOT(), jobId);
  return {
    jobDir,
    input: path.join(jobDir, "input.pptx"),
    pdf: path.join(jobDir, "input.pdf"),
    profile: path.join(jobDir, "profile"),
    cidfile: path.join(jobDir, "cid"),
  };
}

async function dockerConvert(paths, logger) {
  await ensureImage();
  const mountSource = toDockerPath(paths.jobDir);
  const args = [
    ...baseRunArgs({ memory: "1g", tmpfs: "128m" }),
    "-e", "HOME=/job",
    "-v", `${mountSource}:/job:rw`,
    "--cidfile", toDockerPath(paths.cidfile),
    DOCKER_IMAGE,
    "convert",
    "--headless", "--norestore",
    "--convert-to", "pdf",
    "--outdir", "/job",
    "/job/input.pptx",
    "-env:UserInstallation=file:///job/profile",
  ];

  logger?.info?.(`pptx: converting via docker image ${DOCKER_IMAGE} (mount ${mountSource})`);
  const res = await runDocker(args, {
    timeoutMs: TIMEOUT(),
    onTimeout: () => killDockerContainer(paths.cidfile),
  });
  if (res.timedOut) {
    throw new PptxConversionError(
      `PPTX conversion timed out after ${TIMEOUT()} ms. Increase PPTX_CONVERT_TIMEOUT_MS or export the deck to PDF yourself.`,
      { stderr: res.stderr },
    );
  }
  if (res.code !== 0) {
    const tail = res.stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 300);
    throw new PptxConversionError(`LibreOffice conversion failed (exit ${res.code})${tail ? `: ${tail}` : ""}`, { stderr: res.stderr });
  }
}

async function localConvert(paths, logger) {
  logger?.info?.("pptx: converting with local approximate renderer (--no-docker mode)");
  await pptxToPdfApprox(paths.input, paths.pdf);
}

async function containerConvert(paths, logger) {
  logger?.info?.("pptx: converting with in-container LibreOffice");
  const args = [
    "--headless", "--norestore",
    "--convert-to", "pdf",
    "--outdir", paths.jobDir,
    paths.input,
    `-env:UserInstallation=${pathToFileURL(paths.profile).href}`,
  ];
  try {
    await execFileAsync("soffice", args, {
      timeout: TIMEOUT(),
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, HOME: paths.jobDir },
      windowsHide: true,
    });
  } catch (err) {
    const detail = String(err?.stderr ?? err?.message ?? err).trim().slice(0, 500);
    throw new PptxConversionError(`LibreOffice conversion failed: ${detail}`, { stderr: detail });
  }
}

/**
 * Convert a validated .pptx to PDF.
 * @param {string} inputPath absolute path to the .pptx
 * @param {{ logger?: object, hideEmptySlides?: boolean }} [options]
 * @returns {Promise<{ pdfPath: string }>} temp PDF owned by the caller
 */
export async function convertPptxToPdf(inputPath, options = {}) {
  const logger = options.logger ?? { info: silent, warn: silent };
  await acquire();
  const paths = jobPaths(crypto.randomBytes(8).toString("hex"));
  try {
    await fs.promises.mkdir(paths.jobDir, { recursive: true });
    await fs.promises.mkdir(paths.profile, { recursive: true });
    await fs.promises.copyFile(inputPath, paths.input);

    // Hide empty slides in the job copy only; LibreOffice skips hidden slides.
    if (options.hideEmptySlides) {
      const rewritten = `${paths.input}.rewritten.pptx`;
      try {
        await hideEmptySlides(paths.input, rewritten);
        await fs.promises.rename(rewritten, paths.input);
        logger?.info?.("pptx: hidden empty slides in job copy");
      } catch (err) {
        await fs.promises.rm(rewritten, { force: true }).catch(() => {});
        throw new PptxConversionError(`could not hide empty slides in job copy: ${err?.message ?? err}`);
      }
    }

    if (config.inContainer) await containerConvert(paths, logger);
    else if (config.useDocker) await dockerConvert(paths, logger);
    else await localConvert(paths, logger);

    const stat = await fs.promises.stat(paths.pdf).catch(() => null);
    if (!stat || stat.size === 0) {
      throw new PptxConversionError("conversion produced no PDF output");
    }
    return { pdfPath: await moveToTmp(paths.pdf) };
  } catch (err) {
    if (err instanceof PptxConversionError) throw err;
    if (err?.code === "ENOENT" && config.useDocker) {
      throw new PptxConversionError("docker not found — install Docker Desktop and keep it running.", { cause: err });
    }
    throw new PptxConversionError(`conversion failed: ${err?.message ?? err}`, { cause: err });
  } finally {
    await removeQuiet(paths.jobDir);
    release();
  }
}
