#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_dir"
trap 'unlink "$repo_dir/roop-agent-0.0.0.tgz" 2>/dev/null || true; unlink "$repo_dir/roop-agent.tgz" 2>/dev/null || true' EXIT
pnpm --filter @roop/agent build
pnpm --filter @roop/agent pack --pack-destination "$repo_dir"
archive=$(find "$repo_dir" -maxdepth 1 -name 'roop-agent-*.tgz' -print | head -n 1)
cp "$archive" "$repo_dir/roop-agent.tgz"
pnpm --ignore-workspace --dir "$repo_dir/test-consumer" install --frozen-lockfile=false --ignore-scripts
node "$repo_dir/test-consumer/index.mjs"
