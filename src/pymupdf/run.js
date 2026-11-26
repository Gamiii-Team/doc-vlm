// src/pymupdf/run.js — Node wrapper around worker.py.
// Docker mode runs the worker inside full-vlm-parser:latest; --no-docker mode
// uses the local .venv interpreter. JSON-printing commands are parsed here.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "../config.js";
import {
  DOCKER_IMAGE,
  REPO_ROOT,
  baseRunArgs,
  containerPath,
  ensureImage,
  killDockerContainer,
  runDocker,
  toDockerPath,
} from "../docker.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IS_WINDOWS = process.platform === "win32";
const WORKER_TIMEOUT_MS = 120_000;

/** Resolve the local venv interpreter, preferring the Windows Scripts layout. */
export function findPython() {
  const candidates = [
    "/opt/venv/bin/python",
    path.join(REPO_ROOT, ".venv", IS_WINDOWS ? "Scripts" : "bin", IS_WINDOWS ? "python.exe" : "python"),
    path.join(REPO_ROOT, ".venv", "Scripts", "python.exe"),
    path.join(REPO_ROOT, ".venv", "bin", "python"),
    process.env.PYTHON || null,
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      // try next candidate
    }
  }
  return IS_WINDOWS ? "python" : "python3";
}

function containerArg(arg) {
  const s = String(arg);
  return path.isAbsolute(s) ? containerPath(s) : s;
}

async function spawnWorkerDocker(args) {
  await ensureImage();
  const cidDir = path.join(REPO_ROOT, "data", "docker-cids");
  fs.mkdirSync(cidDir, { recursive: true });
  const cidfile = path.join(cidDir, `worker-${crypto.randomBytes(6).toString("hex")}.cid`);

  const dockerArgs = [
    ...baseRunArgs(),
    "-v", `${toDockerPath(REPO_ROOT)}:/workspace:rw`,
    "--cidfile", toDockerPath(cidfile),
    DOCKER_IMAGE,
    "worker",
    ...args.map(containerArg),
  ];

  try {
    const res = await runDocker(dockerArgs, {
      timeoutMs: WORKER_TIMEOUT_MS,
      onTimeout: () => killDockerContainer(cidfile),
    });
    if (res.timedOut) throw new Error(`PyMuPDF worker timed out after ${WORKER_TIMEOUT_MS} ms`);
    if (res.code !== 0) {
      throw new Error(`PyMuPDF worker failed (exit ${res.code}): ${String(res.stderr || res.stdout).slice(0, 1200)}`);
    }
    if (res.stderr.trim() && !res.stdout.trim()) {
      throw new Error(`PyMuPDF worker failed:\n${res.stderr.slice(0, 2000)}`);
    }
    return res.stdout;
  } finally {
    fs.rmSync(cidfile, { force: true });
  }
}

async function spawnWorkerLocal(args, maxBuffer) {
  const python = findPython();
  const worker = path.join(__dirname, "worker.py");
  let stdout, stderr;
  try {
    ({ stdout, stderr } = await execFileAsync(python, [worker, ...args], {
      maxBuffer,
      timeout: WORKER_TIMEOUT_MS,
      windowsHide: true,
    }));
  } catch (err) {
    const msg = `${err?.stderr ?? ""}\n${err?.message ?? ""}`;
    if (/No module named ['"]?(pymupdf|fitz)['"]?/.test(msg)) {
      throw new Error(`PyMuPDF is not installed for '${python}'. Run 'npm run setup --no-docker' first.`);
    }
    throw new Error(`PyMuPDF worker failed: ${String(err?.stderr ?? err?.message ?? err).slice(0, 1200)}`);
  }
  if (stderr && stderr.trim() && !stdout.trim()) {
    throw new Error(`PyMuPDF worker failed:\n${stderr.slice(0, 2000)}`);
  }
  return stdout;
}

export async function spawnWorker(args, { maxBuffer = 256 * 1024 * 1024 } = {}) {
  if (config.inContainer) return spawnWorkerLocal(args, maxBuffer);
  return config.useDocker ? spawnWorkerDocker(args) : spawnWorkerLocal(args, maxBuffer);
}

/** Render all pages of a PDF at 150 DPI -> array of PNG paths. */
export async function renderAllPages(pdfPath, outputDir, dpi = 150) {
  const out = await spawnWorker(["render-all", pdfPath, outputDir, String(dpi)]);
  const paths = JSON.parse(out.trim() || "[]");
  if (!Array.isArray(paths)) throw new Error("render-all did not return a JSON array");
  return paths;
}

export async function analyzePdf(pdfPath) {
  return JSON.parse((await spawnWorker(["analyze", pdfPath])).trim());
}

export async function cropRegion(pdfPath, page, x0, y0, x1, y1, dpi, outPath) {
  await spawnWorker(["crop", pdfPath, String(page), String(x0), String(y0), String(x1), String(y1), String(dpi), outPath]);
  return outPath;
}

export async function renderPage(pdfPath, page, dpi, outPath) {
  await spawnWorker(["render", pdfPath, String(page), String(dpi), outPath]);
  return outPath;
}

export async function hideEmptySlides(srcPptx, dstPptx) {
  return JSON.parse((await spawnWorker(["hide-empty-slides", srcPptx, dstPptx])).trim());
}

/** Approximate PPTX -> PDF used only in --no-docker mode. */
export async function pptxToPdfApprox(srcPptx, outPdf, dpi = 150) {
  return JSON.parse((await spawnWorker(["pptx-to-pdf", srcPptx, outPdf, String(dpi)])).trim());
}
