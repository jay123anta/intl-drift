#!/bin/sh
# Phase 0 snapshot capture (PLAN.md section 5).
# Runs probe.cjs under every Phase 0 runtime and stores canonical snapshots.
# Usage: sh harness/run-phase0.sh   (from the repo root, Docker required)
set -e
cd "$(dirname "$0")/.."
mkdir -p phase0/snapshots

probe_default() { # $1 image  $2 outfile
  echo "== $1 -> $2"
  docker run --rm -i "node:$1" node < probe.cjs > "phase0/snapshots/$2" 2>/dev/null
}

probe_fullicu() { # $1 image  $2 icu4c-data version tag  $3 outfile
  # full-icu's own postinstall breaks on Node < 10 (URL global); install the
  # underlying icu4c-data package directly instead (PLAN.md section 5).
  echo "== $1 + icu4c-data@$2 -> $3"
  docker run --rm -i "node:$1" sh -c "
    cat > /tmp/probe.cjs &&
    cd /tmp && npm install --no-save icu4c-data@$2 >/dev/null 2>&1 &&
    NODE_ICU_DATA=/tmp/node_modules/icu4c-data node /tmp/probe.cjs
  " < probe.cjs > "phase0/snapshots/$3" 2>/dev/null
}

# Incident 2 pair: the small-icu defaults these Nodes actually shipped,
# plus full-icu control builds (expected: no ru-RU change on the controls).
probe_default 7-slim          node-7.10.1-small.json
probe_default 8.0.0-slim      node-8.0.0-small.json
probe_fullicu 7-slim     58l  node-7.10.1-full.json
probe_fullicu 8.0.0-slim 59l  node-8.0.0-full.json

# Incident 1 pair (both full-icu by default).
probe_default 14.16.1-buster  node-14.16.1.json
probe_default 14.17.0-buster  node-14.17.0.json

# Incident 4 pair (ICU 75.1 -> 76.1) and the ladder for unseeded drift.
probe_default 18.13.0-slim    node-18.13.0.json
probe_default 18-slim         node-18.20.8.json
probe_default 22.5.0-slim     node-22.5.0.json
probe_default 22.14.0-slim    node-22.14.0.json
probe_default 22.16.0-slim    node-22.16.0.json
probe_default 24-slim         node-24.json

echo "== done"
ls -la phase0/snapshots/
