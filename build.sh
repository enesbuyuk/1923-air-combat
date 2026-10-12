#!/usr/bin/env bash
# Builds the Rust simulation core to WebAssembly and copies it next to the web app.
set -euo pipefail
cd "$(dirname "$0")"

rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true
cargo build --manifest-path wasm/Cargo.toml --release --target wasm32-unknown-unknown
cp wasm/target/wasm32-unknown-unknown/release/air_1923.wasm web/1923_air.wasm
echo "OK: web/1923_air.wasm ($(wc -c < web/1923_air.wasm) bytes)"

if [[ "${1:-}" == "serve" ]]; then
  # Use PORT if given, otherwise the first free port from 8080 upward.
  port="${PORT:-8080}"
  while lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; do
    echo "Port $port is in use, trying $((port + 1))…"
    port=$((port + 1))
  done
  echo "http://localhost:$port"
  cd web && python3 -m http.server "$port"
fi
