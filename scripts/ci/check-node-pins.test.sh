#!/usr/bin/env bash
# Self-test of check-node-pins.sh: a drifted fixture must fail and name the file.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
t="$(mktemp -d)"; trap 'rm -rf "$t"' EXIT
mk() { rm -rf "$t/r"; mkdir -p "$t/r/.github/workflows"; cd "$t/r"
  echo 26.13.0 > .nvmrc
  echo '{"engines":{"node":">=26"},"devDependencies":{"@types/node":"^26.6.6"}}' > package.json
  printf 'FROM node:26-bookworm-slim@sha256:%064d\n' 0 > Dockerfile
  printf 'jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version-file: .nvmrc\n' > .github/workflows/ci.yml; }
expect_fail() { local name="$1" needle="$2" out
  if out="$("$here/check-node-pins.sh" "$t/r" 2>&1)"; then echo "FAIL $name: passed on drift"; exit 1; fi
  grep -qF -- "$needle" <<<"$out" || { echo "FAIL $name: output lacks $needle"; echo "$out"; exit 1; }
  echo "ok $name"; }
expect_pass() { local name="$1" out
  out="$("$here/check-node-pins.sh" "$t/r" 2>&1)" || { echo "FAIL $name: refused a consistent tree"; echo "$out"; exit 1; }
  echo "ok $name"; }

mk; expect_pass "consistent tree passes"
mk; printf 'FROM node:24-bookworm-slim\n' > Dockerfile.base; expect_fail "stale Dockerfile.base" "./Dockerfile.base:1"
mk; sed -i 's/>=26/>=24/' package.json; expect_fail "stale engines" "./package.json:1"
mk; sed -i 's/\^26/^24/' package.json; expect_fail "stale @types/node" "./package.json:1"
mk; sed -i "s/node-version-file: .nvmrc/node-version: '26'/" .github/workflows/ci.yml; expect_fail "literal setup-node" "node-version-file"
mk; echo "      node-version: 24 # node-pin: ignore" >> .github/workflows/ci.yml; expect_pass "ignore marker"
mk; echo "# measured against node:18-slim" >> Dockerfile; expect_pass "comment line ignored"
mk; sed -i 's/>=26/>= 24/' package.json; expect_fail "spaced engines range" "./package.json:1"
mk; sed -i 's/>=26/^24/' package.json; expect_fail "caret engines range" "./package.json:1"
mk; sed -i 's/>=26/24.x/' package.json; expect_fail "x engines range" "./package.json:1"
mk; printf 'FROM node:lts-slim\n' > Dockerfile; expect_fail "floating lts tag" "floating node tag"
mk; printf 'FROM node:hydrogen-slim\n' > Dockerfile; expect_fail "codename tag" "floating node tag"
mk; printf '[tools]\nnode = "24.22.2"\n' > mise.toml; expect_fail "stale mise.toml" "./mise.toml:2"
mk; printf 'nodejs 24.22.2\n' > .tool-versions; expect_fail "stale .tool-versions" "./.tool-versions:1"
mk; printf 'ARG NODE_VERSION=24\nFROM node:${NODE_VERSION}-slim\n' > app.Dockerfile; expect_fail "ARG NODE_VERSION in *.Dockerfile" "./app.Dockerfile:1"
mk; printf 'services:\n  app:\n    image: node:24-alpine\n' > compose.yaml; expect_fail "stale compose image" "./compose.yaml:3"
mk; echo 'v24.22.2' > .node-version; expect_fail "stale .node-version" "./.node-version:1"
mk; echo '{"engines":{"node":">=26"},"volta":{"node":"24.22.2"}}' > package.json; expect_fail "stale volta pin" "./package.json:1"
mk; echo '      - run: docker tag cancore-filler-node:ci x' >> .github/workflows/ci.yml; expect_pass "foo-node:tag is not a node image"
mk; printf 'services:\n  app:\n    image: node:24-alpine\n' > docker-compose.yml; expect_fail "stale docker-compose image" "./docker-compose.yml:3"
mk; echo 'v26.13.0' > .node-version; expect_pass "v-prefixed .node-version"
mk; printf 'FROM ghcr.io/x/my-node:24\n' > Dockerfile; expect_pass "my-node:24 is not a node image"
mk; printf 'FROM node AS b\n' > Dockerfile; expect_fail "untagged FROM node" "floating node tag"
mk; printf 'services:\n  app:\n    image: node\n' > compose.yaml; expect_fail "untagged compose node image" "floating node tag"
mk; printf '[tools]\nnode = "26.13.0"\n' > mise.toml; expect_pass "current mise.toml"
mk; printf '      - run: node -e "require(\x27node:fs\x27)"\n' >> .github/workflows/ci.yml; expect_pass "node:fs import is not an image"
mk; printf '          build-contexts: node:lts=docker-image://x/node:lts\n' >> .github/workflows/ci.yml; expect_fail "floating tag in docker-image://" "floating node tag"
mk; printf 'services:\n  app:\n    image: ghcr.io/x/my-node:latest\n' > compose.yaml; expect_pass "my-node:latest image is not a node image"
mk; sed -i 's/runs-on: ubuntu-latest/runs-on: cancore-runners/' .github/workflows/ci.yml; expect_fail "self-hosted job with bare setup-node" "use ./.github/actions/setup-node26"
mk; sed -i 's/runs-on: ubuntu-latest/runs-on: ${{ vars.R || '"'"'cancore-runners'"'"' }}/' .github/workflows/ci.yml; expect_fail "expression runner counts as self-hosted" "setup-node26"
mk; sed -i 's/runs-on: ubuntu-latest/runs-on: cancore-runners/; s|uses: actions/setup-node@v4|uses: ./.github/actions/setup-node26|' .github/workflows/ci.yml; expect_pass "self-hosted job through setup-node26"
mk; sed -i 's/runs-on: ubuntu-latest/runs-on: cancore-runners\n    container: node:26-bookworm-slim@sha256:0/' .github/workflows/ci.yml; expect_pass "container job is exempt"
mk; sed -i 's/runs-on: ubuntu-latest/runs-on: cancore-runners/; s|uses: actions/setup-node@v4|uses: actions/setup-node@v4 # node-pin: ignore|' .github/workflows/ci.yml; expect_pass "ignore marker on setup-node"
mk; printf '      - run: docker run --rm node:lts node -v\n' >> .github/workflows/ci.yml; expect_fail "floating tag in docker run" "floating node tag"
mk; printf 'ARG NODE_IMAGE=node:lts\nFROM ${NODE_IMAGE}\n' > Dockerfile; expect_fail "floating tag in NODE_IMAGE" "floating node tag"
wf() { printf '%b' "$1" > .github/workflows/ci.yml; }
SN='    steps:\n      - uses: actions/setup-node@v4\n'
mk; wf "jobs:\n  a:\n    runs-on: [self-hosted, ubuntu-22.04]\n$SN"; expect_fail "mixed self-hosted labels" "setup-node26"
mk; wf "jobs:\n  a:\n    runs-on: ubuntu-latest\n$SN  b:\n    runs-on: cancore-runners\n$SN"; expect_fail "hosted job then self-hosted job" ":9:"
mk; wf "jobs:\n  a:\n    runs-on: cancore-runners\n    container: node:26-bookworm-slim\n$SN  b:\n    runs-on: cancore-runners\n$SN"; expect_fail "container job then self-hosted job" ":10:"
mk; wf "jobs:\n  a:\n    runs-on: cancore-runners\n$SN  b:\n    runs-on: ubuntu-latest\n$SN"; expect_fail "self-hosted job then hosted job" ":5:"
mk; wf "jobs:\n  a:\n    runs-on: cancore-runners\n$SN  b:\n    runs-on: ubuntu-latest\n$SN"; out="$("$here/check-node-pins.sh" "$t/r" 2>&1 || true)"; grep -q ':9:' <<<"$out" && { echo "FAIL hosted job b flagged"; exit 1; }; echo "ok hosted job after self-hosted job is not flagged"
mk; wf "jobs:\n    a:\n        runs-on: cancore-runners\n        steps:\n            - uses: actions/setup-node@v4\n"; expect_fail "4-space indented jobs" "setup-node26"
mk; wf "jobs:\n  a: # build\n    runs-on: cancore-runners\n$SN"; expect_fail "job header with a comment" "setup-node26"
mk; wf "jobs:\n  a:\n    runs-on: cancore-runners\n$SN  b:\n    runs-on: cancore-runners\n$SN"; n="$("$here/check-node-pins.sh" "$t/r" 2>&1 | grep -c 'setup-node26' || true)"; [ "$n" = 2 ] || { echo "FAIL two self-hosted jobs: $n reports, want 2"; exit 1; }; echo "ok each self-hosted job reported once"
mk; wf "jobs:\n  a:\n    runs-on: macos-latest\n$SN  b:\n    runs-on: windows-latest\n$SN"; expect_pass "macos and windows runners are hosted"
echo "check-node-pins self-test: all ok"
