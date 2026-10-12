#!/usr/bin/env bash
# Renders wrangler.jsonc from the template and deploys the worker. Extra arguments go to
# `wrangler deploy`. Use this as the deploy command in Cloudflare Workers Builds too, with
# R2_BUCKET set as a build variable.
set -euo pipefail
cd "$(dirname "$0")/.."

tools/render_wrangler.sh
npx wrangler deploy "$@"
