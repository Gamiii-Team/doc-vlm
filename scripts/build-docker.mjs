import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DOCKER_IMAGE, BUILD_COMMAND } from "../src/docker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// Used only when BuildKit JSON progress is unavailable. Real progress is parsed
// from buildx events below; this is a conservative planning number.
const ESTIMATED_DOWNLOAD_MB = 700;

function hasBuildx() {
  const r = spawnSync("docker", ["buildx", "version"], { stdio: "ignore", shell: false });
  return r.status === 0;
}

/** Older buildx calls JSON progress "rawjson"; detect it before choosing a mode. */
function hasRawJsonProgress() {
  const r = spawnSync("docker", ["buildx", "build", "--help"], { encoding: "utf8", shell: false });
  return r.status === 0 && /rawjson/i.test(r.stdout ?? "");
}

function fmtMb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtEta(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "done";
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

function parseSize(value) {
  const m = String(value).trim().match(/^([\d.]+)\s*(B|kB|MB|GB|KiB|MiB|GiB)?$/i);
  if (!m) return 0;
  const mult = { B: 1, kB: 1e3, MB: 1e6, GB: 1e9, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 };
  return Number(m[1]) * (mult[(m[2] || "B").replace(/^./, (c) => c.toUpperCase())] ?? 1);
}

function runFallback() {
  console.log(`Building ${DOCKER_IMAGE}`);
  console.log(`Estimated total download: ~${ESTIMATED_DOWNLOAD_MB} MB (live ETA shown below).`);
  console.log(`Command: ${BUILD_COMMAND}`);

  const child = spawn("docker", ["build", "-t", DOCKER_IMAGE, "-f", "docker/Dockerfile", "."], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });

  const layers = new Map();
  const started = Date.now();
  let lastPrint = 0;
  let buffer = "";
  let sawProgress = false;

  const handleChunk = (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/[\r\n]/);
    buffer = lines.pop() ?? "";

    for (let text of lines) {
      text = text.trim();
      if (!text) continue;
      const m = text.match(/sha256:([0-9a-f]+)\s+([\d.]+(?:B|kB|MB|GB|KiB|MiB|GiB)?)\s*\/\s*([\d.]+(?:B|kB|MB|GB|KiB|MiB|GiB)?)/i);
      if (m) {
        sawProgress = true;
        const current = parseSize(m[2]);
        const total = parseSize(m[3]);
        const id = m[1];
        const prev = layers.get(id) ?? { current: 0, total: 0 };
        layers.set(id, { current: Math.max(prev.current, current), total: Math.max(prev.total, total) });
        continue; // suppress raw repeating progress line
      }
      process.stdout.write(`${text}\n`);
    }

    if (!sawProgress || Date.now() - lastPrint < 1000) return;
    lastPrint = Date.now();
    let total = 0, done = 0;
    for (const l of layers.values()) { total += l.total; done += l.current; }
    if (total <= 0) return;
    const pct = Math.min(100, (done / total) * 100);
    const elapsed = Date.now() - started;
    const rate = elapsed > 0 ? done / elapsed : 0;
    const eta = rate > 0 ? ((total - done) / rate) : Infinity;
    process.stdout.write(`\rGlobal download: ${fmtMb(done)} / ${fmtMb(total)} (${pct.toFixed(1)}%) — ETA ${fmtEta(eta)}   `);
  };

  child.stdout.on("data", handleChunk);
  child.stderr.on("data", handleChunk);
  child.on("error", (err) => {
    process.stderr.write(`docker build failed: ${err.message}\n`);
    process.exit(1);
  });
  child.on("close", (code) => {
    if (sawProgress) process.stdout.write("\n");
    if (code === 0) console.log(`Image ready: ${DOCKER_IMAGE}`);
    else process.stderr.write(`docker build failed with exit code ${code}\n`);
    process.exit(code ?? 1);
  });
}

function runWithProgress() {
  console.log(`Building ${DOCKER_IMAGE} with global download progress...`);
  const child = spawn("docker", [
    "buildx", "build",
    "--progress=rawjson",
    "--load",
    "-t", DOCKER_IMAGE,
    "-f", "docker/Dockerfile",
    ".",
  ], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], shell: false });

  const layers = new Map();
  const started = Date.now();
  let lastPrint = 0;
  let buffer = "";
  let sawProgress = false;
  let errorText = "";

  const handleChunk = (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const text = line.trim();
      if (!text) continue;

      let evt;
      try { evt = JSON.parse(text); } catch {
        errorText += `${text}\n`;
        process.stdout.write(`${text}\n`);
        continue;
      }

      if (evt.stream) process.stdout.write(String(evt.stream));
      const errMsg = evt.error || evt.errorDetail?.message;
      if (errMsg) {
        errorText += `${String(errMsg)}\n`;
        process.stderr.write(`${String(errMsg)}\n`);
      }

      const detail = evt.progressDetail;
      if (detail && Number(detail.total) > 0) {
        sawProgress = true;
        const id = String(evt.id ?? "layer");
        layers.set(id, {
          current: Math.max(Number(detail.current) || 0, layers.get(id)?.current ?? 0),
          total: Math.max(Number(detail.total) || 0, layers.get(id)?.total ?? 0),
        });
      }

      const now = Date.now();
      if (!sawProgress || now - lastPrint < 1000) continue;
      lastPrint = now;

      let total = 0, done = 0;
      for (const l of layers.values()) { total += l.total; done += l.current; }
      if (total <= 0) continue;
      const pct = Math.min(100, (done / total) * 100);
      const elapsed = now - started;
      const rate = elapsed > 0 ? done / elapsed : 0;
      const eta = rate > 0 ? ((total - done) / rate) : Infinity;
      process.stdout.write(
        `\rGlobal download: ${fmtMb(done)} / ${fmtMb(total)} (${pct.toFixed(1)}%) — ETA ${fmtEta(eta)}   `,
      );
    }
  };

  child.stdout.on("data", handleChunk);
  child.stderr.on("data", handleChunk);
  child.on("error", (err) => {
    process.stderr.write(`docker buildx failed: ${err.message}\n`);
    process.exit(1);
  });
  child.on("close", (code) => {
    if (sawProgress) process.stdout.write("\n");
    if (code !== 0 && /invalid progress mode|unknown flag.*progress/i.test(errorText)) {
      console.log("BuildKit JSON progress is unavailable here — falling back to standard build output.");
      runFallback();
      return;
    }
    if (code !== 0) {
      process.stderr.write(`docker build failed with exit code ${code}\n`);
    } else {
      console.log(`Image ready: ${DOCKER_IMAGE}`);
    }
    process.exit(code ?? 1);
  });
}

if (!hasBuildx() || !hasRawJsonProgress()) runFallback();
else runWithProgress();
