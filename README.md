# full-vlm-parser

Full-VLM document extraction with a dark-mode review dashboard.

**Only two inputs are supported:** `.pdf` and `.pptx`.

```
Browser → Node server (in container) → LibreOffice / Python (same container)
        → Groq VLM → JSON → review UI → export
```

There is no hybrid text-layer path, no Modal/vLLM backend, and no host `soffice`
dependency. All model requests go to `GROQ_MODEL` (default `qwen/qwen3.8-27b`).

The normal setup is **one all-in-one container**. Docker is the only prerequisite.
The image contains Node.js + all npm runtime dependencies, LibreOffice Impress for
headless PPTX→PDF, fonts, Python, `PyMuPDF==1.24.0`, and `python-pptx==0.6.23`.

You do **not** need `npm install`, a host Node.js, a host Python, or a host
`soffice` for this setup. Build once, run once, and open:

```text
http://127.0.0.1:3040
```

---

## Windows setup (PowerShell)

### 1. Prerequisite

Install and start **Docker Desktop** — <https://www.docker.com/products/docker-desktop/>.
Keep the whale icon steady and use **Linux containers**.

Nothing else needs to be installed on Windows for the normal setup.

### 2. Configure the API key

```powershell
copy .env.example .env
notepad .env
```

Set your real key:

```ini
GROQ_API_KEY=gsk_your_real_key_here
GROQ_MODEL=qwen/qwen3.8-27b
PORT=3040
```

`.env.example` remains a minimal three-line template. Do not bake `.env` into the
image; it is passed at runtime with `--env-file .env`.

### 3. Build the image

```powershell
docker build -t full-vlm-parser:latest -f docker/Dockerfile .
```

The first build downloads Debian Bookworm slim, LibreOffice, fonts, Node/npm
packages, and Python wheels. Debian has manylinux wheels, so the image can use the
exact pinned `PyMuPDF==1.24.0` and `python-pptx==0.6.23` — the same versions as the
host-only `--no-docker` mode in `requirements.txt`.

### 4. Run the container

```powershell
mkdir out,data
docker run --rm --name full-vlm-parser -p 127.0.0.1:3040:3040 --env-file .env `
  -e USE_DOCKER=false -e RUNTIME=container `
  -v "$($PWD.Path)\out:/app/out" `
  -v "$($PWD.Path)\data:/app/data" `
  full-vlm-parser:latest
```

### 5. Open the UI

Open <http://127.0.0.1:3040>. Press **Ctrl+C** to stop the container. `out/` and
`data/` are mounted, so reviews and uploads survive restarts.

The dashboard polls the job, then redirects to `review.html` where you can
draw/adjust bounding boxes, re-run figures, zoom (2×2 high-DPI tiles), translate,
approve, and export. Bundled demos (`fixtures/test.pdf`, `fixtures/scanned.pdf`,
`fixtures/sample.pptx`) call the VLM and spend tokens.

Artifacts are written under `out/vlm/<jobId>/vlm/<model>/`:
`status.json`, `result.json`, `manifest.json`, `main.json`, `source.pdf`, `slides/`, `crops/`.

---

## Linux / macOS setup (bash)

These commands assume you start in the project root — the folder containing this
README, `src/`, `docker/`, and `package.json`.

### 1. Prerequisite

Install **Docker Engine** or **Docker Desktop** — `docker --version` and
`docker info` must work. On Linux, if `docker info` needs `sudo`:

```bash
sudo usermod -aG docker "$USER"
newgrp docker
```

Log out and back in if `newgrp` is not enough.

Nothing else needs to be installed on the host for the normal setup.

### 2. Configure the API key

```bash
cp .env.example .env
nano .env
```

Use the same three `GROQ_*` / `PORT` values shown in the Windows section.

### 3. Build the image

```bash
docker build -t full-vlm-parser:latest -f docker/Dockerfile .
```

### 4. Run the container

```bash
mkdir -p out data
docker run --rm --name full-vlm-parser -p 127.0.0.1:3040:3040 --env-file .env \
  -e USE_DOCKER=false -e RUNTIME=container \
  --user "$(id -u):$(id -g)" \
  -v "$PWD/out:/app/out" \
  -v "$PWD/data:/app/data" \
  full-vlm-parser:latest
```

`--user` keeps mounted output files owned by your host user.

### 5. Open the UI

Open <http://127.0.0.1:3040>. The workflow is identical on Windows, Linux, and macOS.

---

## Optional: build wrapper with global ETA (not required)

The raw `docker build` command above is the canonical build step. If you already have
Node.js installed, `npm run docker:build` produces the same image and adds global
download progress plus an ETA:

```bash
npm run docker:build
```

After the wrapper fix in `src/docker.js`, this also needs **no** `npm install`;
it uses only Node built-ins. You can ignore this section completely.

---

## Optional: host-driven Docker mode

Use this only if you prefer the UI/API to run on your host and just Python/LibreOffice
in the container. This mode runs Node on the host, so it needs `npm install`.

```bash
npm install
npm run docker:build
npm run setup
npm start
```

`npm run setup` writes `USE_DOCKER=true` to `.env`. Do not set `RUNTIME=container`
in this mode. The container is started per job with networking disabled and is
removed automatically.

---

## Optional: no-Docker mode

Use this only when Docker is unavailable. It installs pinned Python libraries
locally and renders PPTX slides approximately with `python-pptx` + Pillow, then
wraps them into a PDF with PyMuPDF before sending images to Groq. Fidelity is
lower than LibreOffice. This mode also needs host Node/npm.

### Windows

```powershell
npm run setup --no-docker
```

### Linux / macOS

```bash
PYTHON=/usr/bin/python3.11 npm run setup --no-docker
# or, if python3 is already 3.9–3.12:
npm run setup --no-docker
```

This writes `USE_DOCKER=false`, creates `.venv\Scripts\python.exe` on Windows or
`.venv/bin/python` elsewhere, and installs `requirements.txt`
(`PyMuPDF==1.24.0`, `python-pptx==0.6.23`). Do not use Python 3.13+ with
PyMuPDF 1.24.0.

Switch back with `npm run setup`.

---

## Configuration

Set these in `.env` if needed:

| Variable             | Default                  | Purpose                                               |
| -------------------- | ------------------------ | ----------------------------------------------------- |
| `VLM_CONCURRENCY`    | `3`                      | Simultaneous Groq slide requests                      |
| `PPTX_VLM_DPI`       | `150`                    | Render DPI for PDF/PPTX pages                         |
| `VLM_MIN_GAP_MS`     | `400`                    | Minimum gap between Groq requests (429 pacer)         |
| `VLM_TIMEOUT_MS`     | `90000`                  | Per-request timeout                                   |
| `VLM_IMAGE_MAX_SIDE` | `1400`                   | Longest side of slide images sent to the model        |
| `USE_DOCKER`         | `true`                   | Managed by `npm run setup`; set `false` in all-in-one |
| `RUNTIME`            | unset                    | Set to `container` inside the all-in-one image        |
| `HOST`               | `127.0.0.1`              | Server bind host; image sets `0.0.0.0`                |
| `DOCKER_IMAGE`       | `full-vlm-parser:latest` | Unified processing image                              |
| `PPTX_JOB_ROOT`      | `<repo>/data/convert`    | Scratch dir for PPTX conversion                       |
| `OUTPUT_DIR`         | `<repo>/out`             | Output root                                           |
| `PYTHON`             | `python` / `python3.11`  | Interpreter used only by `--no-docker` setup          |

Slides are capped at 25 pages per document and uploads at 50 MB.

---

## Troubleshooting

### Windows

- **`Docker image "full-vlm-parser:latest" not found`** — run
  `docker build -t full-vlm-parser:latest -f docker/Dockerfile .`.
- **Docker mount / access denied** — ensure Docker Desktop is running and the drive
  containing this folder is shared (Settings → Resources → File sharing).
- **`GROQ_API_KEY is not set`** — create `.env` from `.env.example` and restart the container.

### Linux / macOS

- **`permission denied while trying to connect to the Docker daemon socket`** — add
  your user to the `docker` group and log out/in.
- **`EACCES` writing to `out/` or `data/`** — include `--user "$(id -u):$(id -g)"`
  in the `docker run` command.
- **`GROQ_API_KEY is not set`** — create `.env` from `.env.example` and restart the container.

### Both

- **Build progress looks different** — the optional `npm run docker:build` wrapper
  parses BuildKit progress and shows a global ETA; the raw `docker build` command
  shows Docker's own output.
- **429 / rate limited** — lower `VLM_CONCURRENCY` or raise `VLM_MIN_GAP_MS` in `.env`.
- **`EADDRINUSE` / port already in use** — change the `PORT` value in `.env` and the
  `-p` mapping together.

---

## Project layout

```text
vlm-only/
├── README.md                     this file (Docker-only quick start; Windows first)
├── .env.example                  minimal template: GROQ_API_KEY, GROQ_MODEL, PORT
├── .env                          your local config
├── .env.legacy                   backup of the old exploratory config
├── requirements.txt              pinned Python deps for --no-docker mode
├── .dockerignore                 keeps secrets/vendor dirs out of build context
├── docker/
│   ├── Dockerfile                single all-in-one Alpine 3.23 image
│   └── entrypoint.sh             serve | convert | hints | worker dispatcher
├── package.json
├── package-lock.json
├── scripts/
│   ├── setup-venv.mjs            mode selection + optional local .venv
│   └── build-docker.mjs          optional image build with global download progress/ETA
├── src/
│   ├── config.js                 Groq, ports, runtime mode, Docker settings
│   ├── docker.js                 shared Docker helpers (no host dotenv dependency)
│   ├── vlmRun.js                 PDF/PPTX → full-VLM pipeline entry point
│   ├── providers/groq.js         Groq adapter, JSON mode, 429 pacer
│   ├── input/                    PPTX validation, hints, conversion
│   ├── extract/slideVlm.js       per-slide VLM calls, rerun, translate, explain
│   ├── pymupdf/                  Python renderer + runtime-aware wrapper
│   ├── prompts/                  VLM prompt templates
│   ├── crop.js zoom.js figureContext.js slideMerge.js mergeMain.js vlmManifest.js
│   └── validate/ util/           schemas, pacer, retry, logging, run names, ETA
├── UI/                           dark dashboard, review screen, server.mjs
├── fixtures/                     bundled demo PDF/PPTX files
├── node_modules/                 OPTIONAL: only after host npm install
└── .venv/                        OPTIONAL: only after `npm run setup --no-docker`
```

The normal Docker-only setup needs neither `node_modules/` nor `.venv/` in this folder.
