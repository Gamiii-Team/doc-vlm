// src/input/pptxHints.js — native hints from a .pptx (chart values, notes, hidden slides).
// Docker mode runs the parser inside the unified image; --no-docker mode runs it
// with the local .venv. Hints are an enhancement — failures never throw.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { config } from "../config.js";
import {
  DOCKER_IMAGE,
  baseRunArgs,
  ensureImage,
  killDockerContainer,
  runDocker,
  toDockerPath,
} from "../docker.js";
import { findPython } from "../pymupdf/run.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "pptx_hints.py");
const TIMEOUT_MS = 15_000;

export async function extractHints(deckPath, options = {}) {
  const logger = options.logger ?? { info() {}, warn() {} };
  const file = path.resolve(deckPath);
  if (!fs.existsSync(file)) return { hints: [], ok: false, reason: "input missing" };
  try {
    const stdout = (!config.inContainer && config.useDocker)
      ? await runDockerHints(file)
      : await runLocalHints(file);
    const parsed = parseHints(stdout);
    logger?.info?.("pptx hints: " + (parsed.ok ? `${parsed.hints.length} slide entries` : "unavailable"));
    return parsed;
  } catch (err) {
    logger?.warn?.(`pptx hints unavailable (${err?.message ?? err}) — continuing without native hints`);
    return { hints: [], ok: false, reason: String(err?.message ?? err) };
  }
}

async function runDockerHints(file) {
  await ensureImage();
  const cidfile = path.join(os.tmpdir(), `pptx-hints-${crypto.randomBytes(6).toString("hex")}.cid`);
  const args = [
    ...baseRunArgs({ memory: "512m", tmpfs: "16m" }),
    "-v", `${toDockerPath(file)}:/deck.pptx:ro`,
    "--cidfile", toDockerPath(cidfile),
    DOCKER_IMAGE,
    "hints",
    "/deck.pptx",
  ];
  try {
    const res = await runDocker(args, {
      timeoutMs: TIMEOUT_MS,
      onTimeout: () => killDockerContainer(cidfile),
    });
    if (res.timedOut) throw new Error(`hints timed out after ${TIMEOUT_MS} ms`);
    if (res.code !== 0) throw new Error(`exit ${res.code}: ${res.stderr.trim().slice(0, 300)}`);
    return res.stdout;
  } finally {
    fs.rmSync(cidfile, { force: true });
  }
}

async function runLocalHints(file) {
  const py = findPython();
  const { stdout } = await execFileAsync(py, [SCRIPT, file], {
    timeout: TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

function parseHints(stdout) {
  try {
    const arr = JSON.parse(String(stdout).trim() || "[]");
    if (!Array.isArray(arr)) return { hints: [], ok: false, reason: "hints output not a list" };
    return { hints: arr, ok: true };
  } catch {
    return { hints: [], ok: false, reason: "hints output not valid JSON" };
  }
}
