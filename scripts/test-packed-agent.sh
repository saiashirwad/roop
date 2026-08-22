#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_dir"
trap 'unlink "$repo_dir/roop-agent-0.0.0.tgz" 2>/dev/null || true; unlink "$repo_dir/roop-agent.tgz" 2>/dev/null || true' EXIT
pnpm --filter @roop/agent run clean
pnpm --filter @roop/agent build
pnpm --filter @roop/agent pack --pack-destination "$repo_dir"
archive=$(find "$repo_dir" -maxdepth 1 -name 'roop-agent-*.tgz' -print | head -n 1)
unexpected=$(tar -tf "$archive" | grep -Ev '^package/(package.json|dist/)' || true)
if [ -n "$unexpected" ]; then
  echo "Unexpected packed files:"
  echo "$unexpected"
  exit 1
fi
if tar -tf "$archive" | grep -Eq '^package/dist/(toolScheduler|toolCallCorrelator)\.'; then
  echo "The package contains stale root-level interpreter helpers."
  exit 1
fi
node -e 'const p=require(process.argv[1]); const keys=Object.keys(p.exports); if (keys.join(",")!==".,./testing") { throw new Error(`Unexpected exports: ${keys.join(",")}`) }' "$repo_dir/packages/agent/package.json"
if rg -n "src/internal|from [\"'].*\\/internal\\/" \
  "$repo_dir/packages/agent/dist/index.d.ts" \
  "$repo_dir/packages/agent/dist/testing/index.d.ts"; then
  echo "A public declaration exposes an internal source path."
  exit 1
fi
cp "$archive" "$repo_dir/roop-agent.tgz"
pnpm --ignore-workspace --dir "$repo_dir/test-consumer" install --frozen-lockfile=false --ignore-scripts
node "$repo_dir/test-consumer/index.mjs"
