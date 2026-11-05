#!/usr/bin/env bash
# Node pin consistency (CAN-3315): .nvmrc is the single source of the Node
# version. Fails on any Dockerfile node image, engines/@types/node major, or
# setup-node literal that disagrees with it, naming file:line.
# A line ending in `# node-pin: ignore` is skipped (e.g. a deliberate negative test).
set -euo pipefail
root="${1:-.}"
cd "$root"
[ -f .nvmrc ] || { echo "check-node-pins: .nvmrc missing in $PWD" >&2; exit 1; }
major="$(sed -E 's/^v//; s/[^0-9].*$//' .nvmrc | head -n1)"
[ -n "$major" ] || { echo "check-node-pins: cannot read a major from .nvmrc" >&2; exit 1; }

mapfile -t files < <(find . \( -name node_modules -o -name .git \) -prune -o -type f \
  \( -name 'Dockerfile*' -o -name '*.Dockerfile' -o -name 'package.json' -o -name 'mise.toml' -o -name '.tool-versions' \
     -o -name '.node-version' -o -name 'docker-compose*.y*ml' -o -name 'compose*.y*ml' -o -path './.github/*' -name '*.y*ml' \) -print | sort)

stale=0
report() { echo "stale Node pin (want $major): $1"; stale=1; }
for f in "${files[@]}"; do
  if [ "${f##*/}" = .node-version ]; then
    n="$(sed -E 's/^v//; s/[^0-9].*$//' "$f" | head -n1)"
    [ "$n" = "$major" ] || report "$f:1:$(head -n1 "$f")"
    continue
  fi
  while IFS= read -r hit; do
    line="${hit#*:}"
    case "$line" in *'# node-pin: ignore'*) continue ;; esac
    # whole-line comments (YAML, Dockerfile) describe pins, they do not set one
    printf '%s\n' "$line" | grep -qE '^[[:space:]]*#' && continue
    found="$(printf '%s\n' "$line" | grep -oE '(^|[[:space:]"'"'"'=/])node:[0-9]+|("node": *"[^0-9"]*|"@types/node": *"[^0-9"]*|^[[:space:]]*node *= *"?|^nodejs +|NODE_VERSION=)[0-9]+' | grep -oE '[0-9]+$' || true)"
    # floating tags only where an image is named; `node:fs` imports are not images
    if printf '%s\n' "$line" | grep -qE '^[[:space:]]*FROM[[:space:]]|image:|docker-image://|docker (run|pull)|NODE_IMAGE=' &&
       printf '%s\n' "$line" | grep -qE '(^|[[:space:]"'"'"'=/])node:[a-z]|^[[:space:]]*FROM[[:space:]]+node([[:space:]]|$)|image:[[:space:]]*node[[:space:]]*$'; then
      report "$f:$hit (floating node tag, pin the major)"
    fi
    for n in $found; do [ "$n" = "$major" ] || report "$f:$hit"; done
    if printf '%s\n' "$line" | grep -qE '^[[:space:]]*node-version:'; then
      report "$f:$hit (setup-node must use node-version-file: .nvmrc)"
    fi
  done < <(grep -nE 'node:[0-9a-z]|^FROM[[:space:]]+node([[:space:]]|$)|image:[[:space:]]*node[[:space:]]*$|"node": *"|"@types/node"|^[[:space:]]*node-version:|^[[:space:]]*node *=|^nodejs |NODE_VERSION=[0-9]' -- "$f" || true)
done
[ "$stale" = 0 ] && echo "check-node-pins: every pin resolves to Node $major (${#files[@]} files)"
exit "$stale"
