#!/usr/bin/env bash
# Back-compat shim: the pipeline lives in prepare-device-model.sh (per-device table).
exec bash "$(dirname "$0")/prepare-device-model.sh" iphone-15-pro "$@"
