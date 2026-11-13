#!/usr/bin/env bash
# Builds the fake compositor with libwayland-server (pacman: wayland).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="${1:-$here/../../build/fake-wayland-compositor}"
mkdir -p "$out"
protocols=/usr/share/wayland-protocols
wayland-scanner server-header "$protocols/stable/xdg-shell/xdg-shell.xml" "$out/xdg-shell-server-protocol.h"
wayland-scanner private-code "$protocols/stable/xdg-shell/xdg-shell.xml" "$out/xdg-shell-protocol.c"
wayland-scanner server-header "$protocols/unstable/pointer-gestures/pointer-gestures-unstable-v1.xml" "$out/pointer-gestures-unstable-v1-server-protocol.h"
wayland-scanner private-code "$protocols/unstable/pointer-gestures/pointer-gestures-unstable-v1.xml" "$out/pointer-gestures-unstable-v1-protocol.c"
cc -std=gnu17 -O1 -Wall -Wextra -Wno-unused-parameter -Wno-strict-prototypes \
  -I"$out" "$here/compositor.c" "$out/xdg-shell-protocol.c" \
  "$out/pointer-gestures-unstable-v1-protocol.c" $(pkg-config --cflags --libs wayland-server) \
  -o "$out/fake-wayland-compositor"
echo "$out/fake-wayland-compositor"
