#!/usr/bin/env bash
# Builds and runs the standalone tab scrub model tests with the system compiler.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$root/build/src"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
cxx="${CXX:-$(command -v clang++ || command -v g++)}"
"$cxx" -std=c++20 -Wall -Wextra -Werror -I"$src" \
  "$root/scripts/test-tab-scrub-model.cc" \
  "$src/chrome/browser/ui/views/helium/helium_tab_scrub_model.cc" \
  -o "$out/test"
"$out/test"
