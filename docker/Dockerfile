# docker/Dockerfile — one all-in-one Debian slim image: UI/API + LibreOffice + Python.
# Build once from the project root:
#   docker build -t full-vlm-parser:latest -f docker/Dockerfile .
# Optional wrapper with global download progress + ETA:
#   npm run docker:build

FROM node:20-bookworm-slim

# LibreOffice Impress (headless PPTX -> PDF), fonts, Python 3 and pip.
# Debian has manylinux wheels, so the pinned PyMuPDF==1.24.0 works as-is.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
      libreoffice-impress \
      libreoffice-common \
      fonts-liberation \
      fonts-dejavu-core \
      fonts-noto-core \
      python3 \
      python3-venv \
      python3-pip \
      ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && python3 -m venv /opt/venv \
  && /opt/venv/bin/pip install --no-cache-dir \
      PyMuPDF==1.24.0 \
      python-pptx==0.6.23 \
  && useradd -u 10001 -s /usr/sbin/nologin worker \
  && mkdir -p /app /job /tmp/lo \
  && chown -R worker:worker /app /job /tmp/lo

ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    HOME=/tmp \
    RUNTIME=container \
    USE_DOCKER=false \
    HOST=0.0.0.0 \
    PORT=3040

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && chown -R worker:worker /app

COPY src ./src
COPY UI ./UI
COPY fixtures ./fixtures
COPY src/pymupdf/worker.py /opt/worker.py
COPY src/input/pptx_hints.py /opt/pptx_hints.py
COPY docker/entrypoint.sh /usr/local/bin/vlm-entrypoint
RUN chmod 0755 /usr/local/bin/vlm-entrypoint && chown -R worker:worker /app

USER worker
EXPOSE 3040
ENTRYPOINT ["/usr/local/bin/vlm-entrypoint"]
CMD ["serve"]
