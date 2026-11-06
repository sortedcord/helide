# Helium: Wayland frame opacity experiment

This fork adds a configurable translucent **browser frame** to Helium for Linux
on Wayland. The tab strip and toolbar background can show the desktop behind the
window. The webpage, its text and images, and browser controls keep their normal
opacity. The feature is off by default.

The patch targets Helium Linux `0.20.3.1`, shared Helium commit
`2f81b9cafa38a95071e20de3f9cd6b0aca6d3c65`, and Chromium `156.0.8078.79`.
It requires a native Wayland session and client side browser decorations. Blur
is not requested; the compositor blends the frame's alpha with the desktop.

## What changed

The Linux patch is [`patches/helium/linux/wayland-frame-opacity.patch`](patches/helium/linux/wayland-frame-opacity.patch), registered in `patches/series`.

- Adds the **Wayland frame opacity** entry to `helium://flags` and the launch
  switch `--helium-frame-opacity=VALUE`.
- Reuses Helium's native frame material hooks to let the frame's backgrounds
  show through. On Linux, ordinary browser windows paint one theme-colored
  frame tint at the requested alpha. Caption text and icons stay opaque.
- Enables client side decorations for the affected window. This is needed to
  draw the translucent frame when system decorations are selected.
- Clears Chromium's opaque-region hint for this window so Wayland composites
  its per-pixel alpha correctly.
- Keeps `ContentsWebView` and the renderer's page background opaque. This
  includes loading views and pages whose CSS background is transparent.

The shared Helium helper, [`native-frame-materials.patch`](helium-chromium/patches/helium/ui/native-frame-materials.patch), contains the existing frame painting hooks. The Linux patch enables those hooks for this experiment and adds the Wayland-specific behavior.

## Build

Build from the repository root with Docker. The provided image supplies the
Debian build dependencies; Docker must be installed and accessible to your user.

```sh
git clone --branch main --recurse-submodules \
  https://github.com/sortedcord/helium-translucent-wayland.git
cd helium-translucent-wayland
scripts/docker-build.sh -c
```

The `-c` option builds from a Chromium source checkout and applies the pinned
Helium and Linux patch series. A complete Chromium build needs substantial disk
space, memory, and time.

To package the completed build into a tarball and AppImage using the packaging
container:

```sh
package/docker-package.sh
```

The resulting tarball and AppImage are written under `build/release/`. A Debian
package can be requested with `MAKE_DEB=1 package/docker-package.sh`.

Before compiling, you can check that the patch applies to the pinned upstream
files without downloading all of Chromium or building:

```sh
python3 scripts/check-frame-opacity-patch.py
```

## Set the opacity

Open `helium://flags/#helium-frame-opacity`, choose an opacity, and relaunch the
browser. Available values range from fully opaque to clear. At `0`, the frame
background tint is invisible while text, icons, and controls remain visible.
The default choice is fully opaque.

Alternatively, pass an opacity at launch:

```sh
helium --ozone-platform=wayland --helium-frame-opacity=0.8
```

The value is a number from `0` to `1`; for example, `0.8` means 80% opacity.
Missing, malformed, nonfinite, or out-of-range values fall back to fully opaque.
The setting is read at startup, so close the existing Helium process before
relaunching. For the development build, the executable is
`build/src/out/Default/helium`.

Only the frame background uses this opacity. Web content remains opaque, even
when a website declares a transparent CSS background. Custom theme background
images are suppressed while this effect is active, and some floating controls
may retain their own backgrounds. The opacity can be used without blur; blur
depends on compositor-specific behavior and is outside this patch.

## License

Helium's original license and attribution are preserved. Helium-specific code
and patches use GPL-3.0; see [`LICENSE`](LICENSE). Unmodified imported Chromium
and ungoogled-chromium code keeps its original license; see
[`LICENSE.ungoogled_chromium`](LICENSE.ungoogled_chromium).
