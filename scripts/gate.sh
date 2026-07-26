#!/usr/bin/env bash
#
# The default per-change determinism gate (docs/determinism.md "Gate economy"):
# showcase-tour Verify ×2, 16:9 (the rolling gate project). The legacy
# sentinel runs pre-merge instead: `pnpm gate:merge`.
#
#   pnpm gate
#
set -euo pipefail
cd "$(dirname "$0")/.."

echo "gate: showcase-tour Verify ×2 (16:9); run 'pnpm gate:merge' before merging"
pnpm kookaburra:run --action verify --project showcase-tour --aspect 16:9

echo "gate: EQUAL"
