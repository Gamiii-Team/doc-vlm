// src/config.js — central configuration for the full-VLM pipeline.
// Only Groq / local processing settings. No Modal / vLLM / hybrid backend config.

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");

dotenv.config({ path: path.join(REPO_ROOT, ".env") });

const int = (name, fallback) => {
  const v = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
const str = (name, fallback = "") => {
  const v = process.env[name];
  return v == null ? fallback : String(v).trim();
};

export const MAX_PAGES = 25;

export const config = {
  // Required external service
  groqApiKey: str("GROQ_API_KEY"),
  groqModel: str("GROQ_MODEL", "qwen/qwen3.8-27b"),
  port: int("PORT", 3040),

  // Runtime mode:
  //   useDocker   - Node on host, Python/LibreOffice via `docker run`
  //   inContainer - everything inside the image; call tools directly, no nested Docker
  //   neither     - --no-docker mode with approximate local PPTX rendering
  dockerImage: str("DOCKER_IMAGE", "full-vlm-parser:latest"),
  useDocker: (process.env.USE_DOCKER ?? "true").trim().toLowerCase() !== "false",
  inContainer: (process.env.RUNTIME ?? "").trim().toLowerCase() === "container",

  // Local output directories (all paths stay under <repo>/out)
  outputDir: str("OUTPUT_DIR", path.join(REPO_ROOT, "out")),

  // Input guards
  maxPages: MAX_PAGES,

  // Rendering
  dpi: int("DPI", 150),
  cropDpi: int("CROP_DPI", 200),

  // Concurrency / retries
  concurrency: int("CONCURRENCY", 4),
  retries: int("MODEL_RETRIES", 3),
  httpRetries: int("HTTP_RETRIES", 6),

  // Groq request pacing (429 recovery lives in providers/groq.js + util/pacer.js)
  vlmTimeoutMs: int("VLM_TIMEOUT_MS", 90_000),
  vlmMinGapMs: int("VLM_MIN_GAP_MS", 400),
  vlmGapJitterMs: int("VLM_GAP_JITTER_MS", 100),
  vlmMaxWaitMs: int("VLM_MAX_WAIT_MS", 60_000),
  vlm429MinGapMs: int("VLM_429_MIN_GAP_MS", 400),
  vlm429MaxAttempts: int("VLM_429_MAX_ATTEMPTS", 1),
  jobStallMinutes: int("JOB_STALL_MINUTES", 5),
  vlmMaxRetries: int("VLM_MAX_RETRIES", 2),
  vlmImageMaxSide: int("VLM_IMAGE_MAX_SIDE", 1400),

  // Cost reporting (optional; defaults to zero)
  pricePerMInputToken: Number.parseFloat(process.env.PRICE_PER_M_INPUT_TOKEN ?? "0") || 0,
  pricePerMOutputToken: Number.parseFloat(process.env.PRICE_PER_M_OUTPUT_TOKEN ?? "0") || 0,

  // Figures
  figureMaxDimension: int("FIGURE_MAX_DIM", 1600),
};

/** Missing required configuration. Full-VLM only needs a Groq API key. */
export function missingFor() {
  return config.groqApiKey ? [] : ["GROQ_API_KEY"];
}

/** True when the .env file exists on disk (used by the status endpoint). */
export function hasEnvFile() {
  try {
    fs.accessSync(path.join(REPO_ROOT, ".env"), fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
