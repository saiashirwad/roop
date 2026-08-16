#!/usr/bin/env sh

set -eu

repo_dir=".repos/effect"
repo_url="https://github.com/Effect-TS/effect-smol"
repo_revision="fbefa850fab2f0a302c20614496aeaaa2a8b5590"

if [ ! -d "$repo_dir/.git" ]; then
  mkdir -p ".repos"
  git clone --no-checkout "$repo_url" "$repo_dir"
fi

is_clean_checkout() {
  local status
  if ! status=$(git -C "$repo_dir" status --porcelain=v1 --untracked-files=all 2>/dev/null); then
    return 1
  fi
  [ -z "$status" ]
}

if ! current_revision=$(git -C "$repo_dir" rev-parse HEAD 2>/dev/null); then
  if ! is_clean_checkout; then
    echo "Effect checkout $repo_dir has local changes; refusing to replace it" >&2
    exit 1
  fi
  git -C "$repo_dir" fetch --depth=1 origin "$repo_revision"
  git -C "$repo_dir" checkout --detach "$repo_revision"
  current_revision=$(git -C "$repo_dir" rev-parse HEAD)
fi
if [ "$current_revision" != "$repo_revision" ]; then
  if ! is_clean_checkout; then
    echo "Effect checkout $repo_dir has local changes; refusing to replace it" >&2
    exit 1
  fi
  git -C "$repo_dir" fetch --depth=1 origin "$repo_revision"
  git -C "$repo_dir" checkout --detach "$repo_revision"
fi

test "$(git -C "$repo_dir" rev-parse HEAD)" = "$repo_revision"

pnpm exec effect-tsgo patch --oxlint
