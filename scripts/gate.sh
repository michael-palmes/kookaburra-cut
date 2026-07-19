#!/usr/bin/env bash
#
# The standard determinism gate pair (docs/determinism.md "Gate economy"):
# showcase-tour Verify ×2 (rolling gate) then ws:launch-2026 (null-for-legacy
# sentinel), both 16:9. Runs one leg at a time; stops on the first failure.
#
#   pnpm gate
#
set -euo pipefail
cd "$(dirname "$0")/.."

echo "gate: leg 1/2 — showcase-tour Verify ×2 (16:9)"
pnpm kookaburra:run --action verify --project showcase-tour --aspect 16:9

echo "gate: leg 2/2 — ws:launch-2026 Verify ×2 (16:9)"
pnpm kookaburra:run --action verify --project ws:launch-2026 --aspect 16:9

echo "gate: both legs EQUAL"
