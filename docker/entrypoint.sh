#!/bin/sh
# Dispatcher for the unified image.
# Default `serve` starts the review UI + API. Explicit subcommands are used by
# the host-driven Docker mode and by internal smoke tests.
set -e

case "${1:-serve}" in
  serve)
    shift
    exec node UI/server.mjs "$@"
    ;;
  worker)
    shift
    exec python /opt/worker.py "$@"
    ;;
  hints)
    shift
    exec python /opt/pptx_hints.py "$@"
    ;;
  convert)
    shift
    exec soffice --headless --norestore "$@"
    ;;
  *)
    exec "$@"
    ;;
esac
