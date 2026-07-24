#!/usr/bin/env bash
#
# The standard determinism gate pair (docs/determinism.md "Gate economy"):
# showcase-tour Verify ×2 (rolling gate) then ws:launch-2026 (null-for-legacy
# sentinel), both 16:9, in ONE app boot (the comma-list autorun). Both legs
# always run; the wrapper exits non-zero if either diverges.
#
#   pnpm gate
#
set -euo pipefail
cd "$(dirname "$0")/.."

echo "gate: showcase-tour + ws:launch-2026 Verify ×2 (16:9), one boot"
pnpm kookaburra:run --action verify --project showcase-tour,ws:launch-2026 --aspect 16:9

echo "gate: both legs EQUAL"
