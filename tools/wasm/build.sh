#!/bin/sh
# Build the WASM tiling counter and copy it to tools/lib/dlx.wasm (needs: rustup target add wasm32-unknown-unknown).
set -e
cd "$(dirname "$0")"
cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/dlx.wasm ../lib/dlx.wasm
ls -l ../lib/dlx.wasm
