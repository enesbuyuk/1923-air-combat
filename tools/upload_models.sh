#!/usr/bin/env bash
# Uploads the aircraft GLBs to the R2 bucket the worker serves them from.
# Run after replacing a model in web/models/ (they are not part of the static assets).
# Usage: tools/upload_models.sh [dir]   (default web/models, e.g. dist/models after
# tools/optimize_models.sh)
set -euo pipefail
cd "$(dirname "$0")/.."
source tools/env.sh

for f in "${1:-web/models}"/*.glb; do
  npx wrangler r2 object put "$R2_BUCKET/models/$(basename "$f")" \
    --file "$f" --content-type model/gltf-binary --remote
done
