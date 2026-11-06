# Helium: With Transparency

This fork adds configurable transparency and compositor blur to Helium for Linux
on Wayland, with separate controls for browser UI opacity, blur, and website
transparency. The tab strip, toolbar, and transparent webpage backgrounds can
show the desktop behind the window. Webpages keep an opaque backing by default;
website transparency is opt-in and respects the site's CSS. Text, images, and
browser controls keep their normal opacity. These features are off by default.

## Demo

[![Helium transparency demonstration](docs/media/transparency-demo.gif)](docs/media/transparency-demo.mp4)

Animated preview — click it to [watch the full-resolution recording](docs/media/transparency-demo.mp4).

The patch targets Helium Linux `0.20.3.1`, shared Helium commit
`2f81b9cafa38a95071e20de3f9cd6b0aca6d3c65`, and Chromium `156.0.8078.79`.
It requires a native Wayland session and client side browser decorations. The
compositor blends transparent pixels with the desktop. An optional blur request
is available on compositors supporting `ext-background-effect-v1`.

## What changed

The Linux patch is [`patches/helium/linux/wayland-frame-opacity.patch`](patches/helium/linux/wayland-frame-opacity.patch), registered in `patches/series`.

- Adds an opacity control to `helium://flags` and the launch
  switch `--helium-frame-opacity=VALUE`.
- Reuses Helium's native material hooks to let the browser UI backgrounds
  show through. On Linux, ordinary browser windows paint one theme-colored
  tint at the requested alpha. Caption text and icons stay opaque.
- Enables client side decorations for the affected window. This is needed to
  draw the translucent browser UI when system decorations are selected.
- Clears Chromium's opaque-region hint for this window so Wayland composites
  its per-pixel alpha correctly.
- Keeps `ContentsWebView` and the renderer's page background opaque. This
  includes loading views and pages whose CSS background is transparent, unless
  the separate web-content transparency option is enabled.
- Adds an optional Wayland background-blur request in
  [`wayland-frame-blur.patch`](patches/helium/linux/wayland-frame-blur.patch).
  Ozone binds the compositor's background-effect protocol, owns the effect with
  the surface, and commits blur regions using the same scale conversion as
  input and opaque regions. The outer region follows the window shape;
  page content covers the effect with its opaque backing.
- Adds [web-content transparency](patches/helium/linux/wayland-web-content-transparency.patch).
  With that option enabled, the browser clears its page backing and renderer
  default background to transparent. Rounded page shapes are excluded from the
  browser UI tint, including in split views. Website CSS is not rewritten.

The shared Helium [native materials patch](helium-chromium/patches/helium/ui/native-frame-materials.patch) contains the existing UI painting hooks. The Linux patches extend those hooks with Wayland compositing and website transparency.

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
python3 scripts/check-frame-opacity-patch.py --patch helium/linux/wayland-frame-blur.patch
python3 scripts/check-frame-opacity-patch.py --patch helium/linux/wayland-web-content-transparency.patch
python3 scripts/check-frame-opacity-patch.py --patch helium/linux/wayland-web-content-lifecycle.patch
```

## Set the opacity

Open `helium://flags/#helium-frame-opacity`, choose an opacity, and relaunch the
browser. Available values range from fully opaque to clear. At `0`, the browser UI
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

Only the browser UI background uses this opacity. Web content remains opaque unless
its separate transparency option is enabled. Custom theme background
images are suppressed while this effect is active, and some floating controls
may retain their own backgrounds.

## Enable or disable blur

Open `helium://flags/#helium-frame-blur`, choose **Enabled** or **Disabled**, and
relaunch. Default makes no blur request. Enable browser UI or website transparency
so the effect can be seen. For example:

```sh
helium --ozone-platform=wayland --helium-frame-opacity=0.8 --helium-frame-blur=1
```

Use `--helium-frame-blur=0` to remove Helium's request. A compositor window rule
that forces blur can override that choice. Fullscreen, app, popup, devtools, and
picture-in-picture windows do not request this effect. Unsupported compositors
keep transparency without blur.

These controls require a build of this fork; standard Helium binaries do not
include them.

### Blur strength on niri

Wayland's background-effect protocol exposes a blur region, but no radius,
strength, or algorithm. Helium therefore cannot set a portable blur-strength
value. Set strength in your compositor. For example, niri 26.04+ accepts this
top-level block in `~/.config/niri/config.kdl`:

```kdl
blur {
    passes 3
    offset 3.0
}
```

Merge these settings into an existing `blur` block if you have one. They affect
**all background blur in niri**, not just Helium. Increasing `offset` makes the
blur broader without adding passes; increasing `passes` can smooth a broader
blur but costs more GPU work. Large offsets can produce artifacts. Niri's
global `blur { off }` disables blur even if Helium requests it.

See [niri's blur configuration](https://github.com/niri-wm/niri/wiki/Configuration%3A-Miscellaneous#blur)
and the [Wayland background-effect protocol](https://wayland.app/protocols/ext-background-effect-v1).

## Transparent website backgrounds

Enable **Transparent web content on Wayland** at
`helium://flags/#helium-transparent-web-content` and relaunch. Alternatively:

```sh
helium --ozone-platform=wayland --helium-transparent-web-content=1
```

Use `--helium-transparent-web-content=0` to keep the normal opaque backing.
This setting is independent of browser UI opacity: the UI can remain fully opaque
while the page has transparent areas. It applies only to normal browser windows
on native Wayland. Existing binaries need to be rebuilt to include this option.

The feature removes the browser's solid backing behind the page. A page's
`html`/`body` background must also be transparent for the desktop to show
through. A transparent child over an opaque parent still shows that parent's
background. Websites with no background specified may become transparent because
CSS defaults to transparent. Explicit opaque backgrounds still cover the
desktop, and translucent CSS colors blend normally. No page CSS is injected,
and there is no opacity multiplier applied to text or images.

Browser UI opacity and blur may be combined with this setting:

```sh
helium --ozone-platform=wayland --helium-frame-opacity=0.8 \
  --helium-frame-blur=1 --helium-transparent-web-content=1
```

The transparent default is stored on each tab's `WebContents`, so future
renderers inherit it even while the tab is hidden. The page backing is also
reapplied when switching tabs and when the primary page changes. See
[`wayland-web-content-lifecycle.patch`](patches/helium/linux/wayland-web-content-lifecycle.patch).

Open [`docs/web-transparency-demo.html`](docs/web-transparency-demo.html) as a
local file to check clear, translucent, and opaque page regions. Its button
switches the page background between transparent and solid without a reload.
Check it in a restored window, maximized window, and split view; rounded corners
and gutters should retain the browser UI tint. The normal opaque backing should
return when the flag is disabled.

For an automated lifecycle regression check, run these commands on a Wayland
desktop after building. They require Python's Pillow package and the matching
ChromeDriver from the build:

```sh
python3 scripts/check-web-transparency-lifecycle.py
python3 scripts/check-web-transparency-lifecycle.py --opaque
```

The check opens a temporary browser profile with local data pages, switches to
an opaque tab and back, reloads, and navigates again. It checks screenshot alpha
and an opaque CSS panel after every transition. `--pause 30` keeps the other tab
active for 30 seconds before returning. It does not use the existing profile or
change system/browser settings.

## Automatic website transparency: Helium Glass

The companion [Helium Glass extension](extensions/helium-glass/README.md)
analyzes each website's palette and gives its page backgrounds, cards, and
neutral gradients different levels of transparency. Text, images, controls,
and strong accent colors retain their normal opacity. Theme changes and
dynamically added surfaces are detected automatically.

Enable **Transparent web content on Wayland**, open `helium://extensions`,
enable **Developer mode**, and **Load unpacked** from
[`extensions/helium-glass`](extensions/helium-glass). Reload existing pages.
Click the extension icon for a transparency slider, per-site toggle, contrast
protection, and global switch. It runs locally and needs no browser rebuild.

The extension is an experimental automatic restyler. Some sites may need a
lower strength or the site toggle; image backgrounds, pseudo-elements, and
shadow DOM are not rewritten. See its README for installation, permissions,
limitations, and tests, or try the included
[surface demo](extensions/helium-glass/demo.html).

## License

Helium's original license and attribution are preserved. Helium-specific code
and patches use GPL-3.0; see [`LICENSE`](LICENSE). Unmodified imported Chromium
and ungoogled-chromium code keeps its original license; see
[`LICENSE.ungoogled_chromium`](LICENSE.ungoogled_chromium).
