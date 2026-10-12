#!/usr/bin/env bash
# Generates wrangler.jsonc from wrangler.template.jsonc, filling in the private values
# (R2 bucket name) from the environment or .env. The output is not committed.
set -euo pipefail
cd "$(dirname "$0")/.."
source tools/env.sh

sed "s/\${R2_BUCKET}/$R2_BUCKET/g" wrangler.template.jsonc > wrangler.jsonc
echo "OK: wrangler.jsonc"
