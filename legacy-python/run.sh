#!/usr/bin/env bash
# Start the local UI on http://127.0.0.1:8765
cd "$(dirname "$0")"
exec python3 -m svgextrude.server "$@"
