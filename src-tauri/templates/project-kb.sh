#!/bin/sh
# kookaburra-cut kb shim v1 (managed by Kookaburra Cut; replaced on update)
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P) || exit 2
kb="$here/.claude/skills/kookaburra-scene-authoring/scripts/kb.py"
[ -f "$kb" ] || { echo "kb: the kit is missing; reopen the project in Kookaburra Cut" >&2; exit 2; }
exec python3 -I "$kb" "$@"
