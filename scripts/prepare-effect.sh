#!/usr/bin/env sh

set -eu

repo_dir=".repos/effect"
repo_url="https://github.com/Effect-TS/effect-smol"

if [ ! -d "$repo_dir/.git" ]; then
  mkdir -p ".repos"
  git clone "$repo_url" "$repo_dir"
fi

pnpm exec effect-tsgo patch --oxlint
