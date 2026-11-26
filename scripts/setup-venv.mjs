import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const VENV = path.join(ROOT, ".venv");
const REQ = path.join(ROOT, "requirements.txt");
const ENV = path.join(ROOT, ".env");

// PyMuPDF 1.24.0 does not ship wheels for Python 3.13+.
const PY_VERSION = process.env.PYTHON || "python3.11";

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT, shell: false, ...opts });
  if (r.error) {
    console.error(`Failed to run ${cmd}: ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`${cmd} ${args.join(" ")} failed with exit code ${r.status}`);
    process.exit(r.status ?? 1);
  }
}

/** Add or replace a single KEY=value line, preserving the rest of .env. */
function setEnvVar(key, value) {
  let text = existsSync(ENV) ? readFileSync(ENV, "utf8") : "";
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(text)) text = text.replace(re, `${key}=${value}`);
  else text = `${text.trimEnd()}\n${key}=${value}\n`;
  writeFileSync(ENV, text, "utf8");
}

// `npm run setup --no-docker` is consumed by npm as npm_config_docker="" (or
// "false" on older npm). Also accept the raw argv form when invoked directly.
const npmDocker = process.env.npm_config_docker;
const noDocker = process.argv.includes("--no-docker")
  || (npmDocker !== undefined && ["", "false", "0"].includes(String(npmDocker).toLowerCase()));
setEnvVar("USE_DOCKER", noDocker ? "false" : "true");

if (!noDocker) {
  console.log("Docker mode selected.");
  console.log("Python libraries live inside full-vlm-parser:latest — no local .venv is needed.");
  console.log("Build it with: npm run docker:build");
  process.exit(0);
}

console.log("No-Docker mode selected — creating local .venv with all pinned Python deps.");
const py = process.env.PYTHON || (existsSync("/usr/bin/python3.11") ? "/usr/bin/python3.11" : PY_VERSION);

if (!existsSync(VENV)) {
  console.log(`Creating .venv with ${py}...`);
  run(py, ["-m", "venv", VENV]);
} else {
  console.log("Reusing existing .venv");
}

const pyBin = process.platform === "win32"
  ? path.join(VENV, "Scripts", "python.exe")
  : path.join(VENV, "bin", "python");

if (!existsSync(pyBin)) {
  console.error(`Python executable not found at ${pyBin}`);
  process.exit(1);
}

run(pyBin, ["-m", "pip", "install", "--upgrade", "pip"]);
run(pyBin, ["-m", "pip", "install", "-r", REQ]);
console.log("Python environment ready.");
