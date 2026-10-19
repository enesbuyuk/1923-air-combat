#!/usr/bin/env bash
# Builds the Rust simulation core to WebAssembly and copies it next to the web app.
set -euo pipefail
cd "$(dirname "$0")"

rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true
cargo build --manifest-path wasm/Cargo.toml --release --target wasm32-unknown-unknown
cp wasm/target/wasm32-unknown-unknown/release/air_1923.wasm web/1923_air.wasm

# Optional Binaryen pass (brew install binaryen / npm i -g binaryen); skipped when wasm-opt
# is not installed or fails. -O3 by default because the simulation is hot every frame; set
# WASM_OPT=-Oz to trade speed for size, or WASM_OPT=0 to skip. The feature flags match what
# current rustc enables by default for wasm32-unknown-unknown.
wasm_opt_level="${WASM_OPT:--O3}"
if [[ "$wasm_opt_level" != "0" ]] && command -v wasm-opt >/dev/null 2>&1; then
  before=$(wc -c < web/1923_air.wasm)
  tmp="$(mktemp -t 1923_air.XXXXXX)"
  if wasm-opt "$wasm_opt_level" \
      --enable-bulk-memory --enable-sign-ext --enable-mutable-globals \
      --enable-nontrapping-float-to-int --enable-reference-types --enable-multivalue \
      --strip-debug --strip-producers \
      -o "$tmp" web/1923_air.wasm 2>/dev/null \
    && [[ $(wc -c < "$tmp") -lt $before ]]; then
    mv "$tmp" web/1923_air.wasm
    chmod 644 web/1923_air.wasm
    echo "wasm-opt $wasm_opt_level: $before -> $(wc -c < web/1923_air.wasm) bytes"
  else
    rm -f "$tmp"
  fi
fi
echo "OK: web/1923_air.wasm ($(wc -c < web/1923_air.wasm) bytes)"

if [[ "${1:-}" == "serve" || "${1:-}" == "online" ]]; then
  # Use PORT if given, otherwise the first free port from 8080 upward.
  port="${PORT:-8080}"
  while lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; do
    echo "Port $port is in use, trying $((port + 1))…"
    port=$((port + 1))
  done
fi

if [[ "${1:-}" == "serve" ]]; then
  echo "http://localhost:$port"
  cd web && python3 -m http.server "$port"
fi

# Online play needs the worker (rooms are Durable Objects), so run it locally with
# wrangler. The aircraft GLBs come from R2 there too: copy them into the local bucket,
# only the ones changed since the last copy.
if [[ "${1:-}" == "online" ]]; then
  tools/render_wrangler.sh
  source tools/env.sh
  stamp=.wrangler/models.stamp
  for f in web/models/*.glb; do
    if [[ ! -f "$stamp" || "$f" -nt "$stamp" ]]; then
      echo "Local R2: $(basename "$f")"
      npx wrangler r2 object put "$R2_BUCKET/models/$(basename "$f")" \
        --file "$f" --content-type model/gltf-binary --local >/dev/null
    fi
  done
  mkdir -p .wrangler && touch "$stamp"
  echo "http://localhost:$port"
  exec npx wrangler dev --port "$port"
fi
