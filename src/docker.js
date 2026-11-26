// src/docker.js — shared Docker helpers for the single unified processing image.
// Docker mode runs every Python step inside `full-vlm-parser:latest`.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Deliberately independent of src/config.js: scripts/build-docker.mjs imports this
// module and must work without a host npm install (no dotenv in node_modules).
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const IS_WINDOWS = process.platform === "win32";
export const DOCKER_IMAGE =
  (process.env.DOCKER_IMAGE ?? "").trim() || "full-vlm-parser:latest";
export const BUILD_COMMAND = `docker build -t ${DOCKER_IMAGE} -f docker/Dockerfile .`;

/** Absolute Docker bind-mount source, Windows drive paths normalised to /c/... */
export function toDockerPath(input) {
  const abs = path.resolve(input).replace(/\\/g, "/");
  const drive = abs.match(/^([A-Za-z]):\/(.*)$/);
  if (drive) return `/${drive[1].toLowerCase()}/${drive[2]}`;
  return abs; // POSIX path or UNC (//server/share) already acceptable
}

/** Translate a project-local host path to its /workspace mount path. */
export function containerPath(input) {
  const abs = path.resolve(String(input));
  const rel = path.relative(REPO_ROOT, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Docker mode only supports paths inside the project root: ${abs}`);
  }
  return `/workspace/${rel.split(path.sep).join("/")}`;
}

/** Hardened flags shared by every container invocation. */
export function baseRunArgs({ memory = "1g", tmpfs = "256m" } = {}) {
  const args = [
    "run", "--rm",
    "--network", "none",
    "--read-only",
    "--memory", memory, "--memory-swap", memory,
    "--pids-limit", "200",
    "--cpus", "1.5",
    "--security-opt", "no-new-privileges",
    "--cap-drop", "ALL",
    "--tmpfs", `/tmp:rw,noexec,nosuid,size=${tmpfs}`,
    "-e", "HOME=/tmp",
    "-e", "PYTHONDONTWRITEBYTECODE=1",
  ];
  // On POSIX, run as the host user so bind-mounted output dirs stay writable.
  // Docker Desktop handles Windows mounts without an explicit --user.
  if (!IS_WINDOWS && typeof process.getuid === "function") {
    args.push("--user", `${process.getuid()}:${process.getgid()}`);
  }
  return args;
}

let imageChecked = false;
export async function ensureImage() {
  if (imageChecked) return;
  const res = await runDocker(["image", "inspect", DOCKER_IMAGE, "--format", "{{.Id}}"], { timeoutMs: 10_000 });
  if (res.code !== 0) {
    throw new Error(`Docker image "${DOCKER_IMAGE}" not found. Build it once with: ${BUILD_COMMAND}`);
  }
  imageChecked = true;
}

/** Run a docker command with a timeout and bounded output capture. */
export function runDocker(args, { timeoutMs = 120_000, onTimeout, maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      detached: !IS_WINDOWS,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "", stderr = "";
    const cap = (buf, add) => (Buffer.byteLength(buf) < maxBuffer ? buf + add : buf);
    child.stdout.on("data", (d) => { stdout = cap(stdout, d.toString()); });
    child.stderr.on("data", (d) => { stderr = cap(stderr, d.toString()); });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      onTimeout?.();
      killGroup(child.pid);
    }, timeoutMs);

    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

export function killDockerContainer(cidfile) {
  try {
    const cid = fs.readFileSync(cidfile, "utf8").trim();
    if (cid) spawn("docker", ["kill", cid], { stdio: "ignore", windowsHide: true });
  } catch {}
}

export function killProcessGroup(pid) {
  killGroup(pid);
}

function killGroup(pid) {
  if (!pid) return;
  try {
    if (IS_WINDOWS) spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else process.kill(-pid, "SIGKILL");
  } catch {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
}
