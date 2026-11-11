# Wayland frame opacity experiment

This Linux patch targets Helium 0.20.3.1, its pinned shared patch commit
`2f81b9cafa38a95071e20de3f9cd6b0aca6d3c65`, and Chromium 156.0.8078.79.

After a future build, choose an opacity with **Settings → Appearance → Browser
window opacity** (applied live), or in `helium://flags/#helium-frame-opacity` and
relaunch. The choices range from a fully opaque frame to a clear frame. Default
preserves normal Helium rendering. The flag and the switch below override the
Setting. For arbitrary values, launch the resulting browser with:

```sh
helium --ozone-platform=wayland --helium-frame-opacity=0.8
```

The value is a finite number from 0 through 1: 0.8 means 80% opacity.
Malformed, nonfinite, and out-of-range switch values fall back to 1. With no
switch, the Settings value is used.
The control takes effect at launch, so close the existing browser process first,
or use a separate development profile. This option controls the frame background;
tab text, icons, and web content retain their normal opacity.

## Implementation

Linux browser windows already request `WindowOpacity::kTranslucent` in
`BrowserNativeWidgetAuraLinux::GetWidgetParams()`. Chromium's Wayland backend
already supports alpha and clears the Aura compositor to transparent. No new
Wayland protocol is required for per-pixel alpha.

The patch reuses Helium's shared native-material background suppression for normal
browser windows on the active Wayland backend. On Linux, that also brings over the
macOS material behavior: inactive tabs have no fill, hover fills fade in, and
infobars lose their solid background. The frame paints one theme-colored tint
with the requested alpha:

- Restored windows: `BrowserFrameViewLinux::PaintRestoredFrameBorder()` fills the
  restored clip shape (rounded corners included) with the tint. It then calls
  `views::PaintRestoredFrameBorderLinux()` without a frame background, so the
  window edge and client-side shadow are still drawn. The shadow is clipped to
  the outside of the window shape, so it never darkens the tint. The GTK-native
  frame (`BrowserFrameViewLinuxNative`) uses this same path, because the GTK
  window frame is opaque.
- Maximized windows: `OpaqueBrowserFrameView::OnPaint()` fills the whole view
  with the tint.

Caption buttons keep receiving the opaque frame color. `FrameCaptionButton`
never paints that color; it only uses it to choose icon and ink-drop colors, so
passing transparent would pick light icons on every theme.

Affected windows always use client decorations, even when "Use system title bar
and borders" is enabled. A server-side frame could not show the tint. App,
popup, devtools, and picture-in-picture windows keep their normal rendering.

`BrowserDesktopWindowTreeHostLinux::UpdateFrameHints()` clears its opaque-region
hint for these windows. Otherwise Wayland may treat translucent frame pixels as
opaque. An empty hint is conservative; it does not lower the opacity of opaque
pixels. This also avoids incorrect hints over rounded page corners, vertical
tabs, and split-view gaps, at a possible cost to compositor occlusion optimization.

On Linux only, `ContentsWebView::UpdateBackgroundColor()` keeps an opaque backing
and renderer background by default while this mode is active. That covers pages with
transparent CSS backgrounds and pages that are still loading. macOS native
materials are unaffected. The patch never applies a window or layer opacity
multiplier to web content.

The optional [`wayland-web-content-transparency.patch`](../patches/helium/linux/wayland-web-content-transparency.patch)
adds a separate setting to remove that opaque backing and exclude the rounded
page shapes from the frame tint. With it enabled, CSS background alpha can reach
the Wayland compositor. See [transparent website backgrounds](../README.md#transparent-website-backgrounds)
for configuration and a manual demo.

Custom theme images are suppressed by the reused material hooks; the frame uses
the theme's frame color as its tint. Floating controls may retain their own
backgrounds. Blur is separate and depends on compositor support/configuration;
this patch requests only alpha compositing. The optional
[`wayland-frame-blur.patch`](../patches/helium/linux/wayland-frame-blur.patch)
adds a compositor blur request; see the [blur configuration in the README](../README.md#enable-or-disable-blur).

Protocol and source references:

- [Wayland opaque-region semantics](https://wayland.app/protocols/wayland#wl_surface:request:set_opaque_region)
- [Pinned Linux browser initialization](https://github.com/chromium/chromium/blob/156.0.8078.79/chrome/browser/ui/views/frame/browser_native_widget_aura_linux.cc)
- [Pinned Linux browser frame hints](https://github.com/chromium/chromium/blob/156.0.8078.79/chrome/browser/ui/views/frame/browser_desktop_window_tree_host_linux.cc)
- [Pinned Wayland surface handling](https://github.com/chromium/chromium/blob/156.0.8078.79/ui/ozone/platform/wayland/host/wayland_window.cc)
- [Pinned content backing](https://github.com/chromium/chromium/blob/156.0.8078.79/chrome/browser/ui/views/frame/contents_web_view.cc)

## Validation without building

```sh
python3 scripts/check-frame-opacity-patch.py
python3 scripts/check-frame-opacity-patch.py --patch helium/linux/wayland-settings.patch
git diff --check
```

The script fetches only the upstream files touched by the experiment, applies
their existing Helium patch sections in series order, then applies and reverses
the experimental patch with zero fuzz. It verifies that reversing restores the
baseline byte for byte. It uses temporary files and does not download a complete
Chromium tree or invoke a compiler.

Compilation and visual behavior have not been verified. After a future build,
check 0, 0.5, 0.8, and 1 opacity with a window behind the browser. Check horizontal
and vertical tabs, split views, rounded corners, loading and transparent HTML,
fullscreen, maximizing, tiling, fractional scaling, and tab dragging. Check light,
dark, custom, and GTK themes, with both GTK and Helium caption buttons. The page
area must stay opaque throughout. Restored windows must keep their shadow and
edge, and caption icons must stay legible on light themes. At low opacity, check
that infobars are still readable. Also check invalid values, X11 fallback, and
excluded window types.
