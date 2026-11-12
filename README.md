<p align="center">
  <img src="helide-icon.svg" alt="Helide logo" width="160" height="160">
</p>

<h1 align="center">Helide</h1>

<p align="center">
  <strong>A personal Helium fork, tailored for Linux on the Motobook 60 Pro.</strong>
</p>

<p align="center">
  Wayland transparency · Touchpad page transitions · Linux Energy Saver · Background AI agents
</p>

Helide combines Wayland transparency and compositor blur, touchpad page-slide
navigation, Linux Energy Saver integration, and background AI-agent access.
It is a personal project—not an official Helium or Motorola product.

## Features

### Live transparency and blur

<p align="center">
  <img src="docs/illustrations/appearance.svg" alt="The window tint fades over softly blurred desktop colors while text and controls stay crisp." width="720">
</p>

Adjust the window tint and compositor blur live, while text and controls stay crisp. [Appearance controls](#settings).

### Transparent websites, by choice

<p align="center">
  <img src="docs/illustrations/website-transparency.svg" alt="Opting into transparent website backgrounds reveals the desktop while images, text and explicitly painted surfaces remain opaque." width="720">
</p>

Let the desktop show through transparent page backgrounds without fading images, text or explicitly painted surfaces. [How website transparency works](#transparent-website-backgrounds).

### Touchpad page transitions

<p align="center">
  <img src="docs/illustrations/swipe.svg" alt="A two-finger swipe slides the current page aside to reveal the previous page; the toolbar stays fixed." width="720">
</p>

Swipe through history with a fluid page stack: the page moves with your fingers while the toolbar stays put. [Swipe settings and behavior](#slide-pages-when-swiping).

### Linux-aware Energy Saver

<p align="center">
  <img src="docs/illustrations/energy-saver.svg" alt="Linux battery and power-profile signals enable Energy Saver and reduce background activity." width="720">
</p>

Follow battery state and your power-saver profile to reduce background activity. [Energy Saver rules](#energy-saver-on-linux).

### Opaque fullscreen

<p align="center">
  <img src="docs/illustrations/fullscreen.svg" alt="A window expands into an opaque fullscreen surface, then regains transparency on exit." width="720">
</p>

Fullscreen drops transparency and blur so the compositor can skip background blending. Leaving fullscreen automatically restores your windowed appearance. Direct scanout is possible where the graphics stack supports it.

### Agents without the takeover

<p align="center">
  <img src="docs/illustrations/agent-tabs.svg" alt="An agent works in its collapsed tab group while your selected tab stays unchanged." width="720">
</p>

Keep using your selected tab while agents work in background tabs inside a collapsed Agent group. [Agent Access](#let-ai-agents-control-helide).

### Structured browser tools

<p align="center">
  <img src="docs/illustrations/mcp-tools.svg" alt="Structured inspect, fill and click calls highlight the corresponding browser elements in sequence." width="720">
</p>

Give agents inspect, read, fill and click tools instead of asking them to write browser-control scripts. [Helide MCP setup and tools](#helide-mcp-server).

## Overview

There are separate controls for browser UI opacity, blur, and website
transparency. The tab strip, toolbar, and transparent webpage backgrounds can
show the desktop behind the window. Webpages keep an opaque backing by default;
website transparency is opt-in and respects the site's CSS. Text, images, and
browser controls keep their normal opacity. These features are off by default.

Helide is based on Helium Linux `0.20.3.1`, shared Helium commit
`2f81b9cafa38a95071e20de3f9cd6b0aca6d3c65`, and Chromium `156.0.8078.79`.
It requires a native Wayland session and client side browser decorations. The
compositor blends transparent pixels with the desktop. An optional blur request
is available on compositors supporting `ext-background-effect-v1`.

## What changed

The Linux patch is [`patches/helium/linux/wayland-frame-opacity.patch`](patches/helium/linux/wayland-frame-opacity.patch), registered in `patches/series`.

- Adds an opacity control to **Settings → Appearance**, applied live, plus
  `helium://flags` and the launch switch `--helium-frame-opacity=VALUE`, which
  take precedence. See [Settings](#settings).
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
- Adds [Settings → Appearance controls](#settings) for opacity, blur, and website
  transparency, stored as per-profile prefs, in
  [`wayland-settings.patch`](patches/helium/linux/wayland-settings.patch). Changes
  apply to open windows without a relaunch.
- Adds a Safari-style [page-slide swipe for history navigation](#slide-pages-when-swiping)
  on the touchpad, in
  [`wayland-swipe-page-preview.patch`](patches/helium/linux/wayland-swipe-page-preview.patch),
  with a toggle in **Settings → Behavior**.

- Makes Chromium see the battery on Linux, in
  [`linux-battery-energy-saver.patch`](patches/helium/linux/linux-battery-energy-saver.patch).
  Battery state comes from `/sys/class/power_supply`, and AC or battery status
  from UPower. **Settings → Performance → Energy saver** therefore appears on
  Linux, and its "when unplugged" and "low battery" rules work. The system
  power-saver profile (power-profiles-daemon) also turns Energy saver on, when
  the Energy saver toggle is on.
- Makes fullscreen windows opaque, in
  [`wayland-fullscreen-opaque.patch`](patches/helium/linux/wayland-fullscreen-opaque.patch).
  While a window is fullscreen the transparency and blur are dropped and the
  window is declared opaque. The compositor then skips blending it, and can
  scan fullscreen video out directly. The transparency comes back on exit.

- Lets AI agents and other automation control the browser without taking it
  over, in
  [`helium-agent-access.patch`](patches/helium/linux/helium-agent-access.patch),
  with a toggle in **Settings → Behavior**. See [Let AI agents control
  Helide](#let-ai-agents-control-helide).
- Adds a build option to generate code for one CPU, in
  [`helium-target-march.patch`](patches/helium/linux/helium-target-march.patch).
  `flags.linux.gn` sets it to `arrowlake`. See [CPU target and
  PGO](#cpu-target-and-pgo).

The shared Helium [native materials patch](helium-chromium/patches/helium/ui/native-frame-materials.patch) contains the existing UI painting hooks. The Linux patches extend those hooks with Wayland compositing and website transparency.

## Branding and compatibility

The visible browser name is **Helide**, with the icon in `helide-icon.svg` and
build/About text identifying this as a personal Linux build for the Motobook
60 Pro. Upstream Helium and Chromium versions and copyright attribution remain
visible. The version number currently follows the pinned Helium base.

This is the lightweight rebrand: internal generated product metadata remains
Helium to avoid a large rebuild. Profile/install paths, the `helium` executable,
`helium://` URLs, `--helium-*` switches, preference keys, desktop app ID and the
Pi MCP registration `helium` stay unchanged for compatibility. Do not rename
these paths to follow the visible brand. Existing profiles need no migration.
The companion extension keeps its established name, **Helium Glass**.

The [`helide-branding.patch`](patches/helium/linux/helide-branding.patch) handles
CLI/About build text. [`scripts/apply-helide-branding.py`](scripts/apply-helide-branding.py)
applies visible string/translation and icon overlays after upstream resources,
using GRIT fingerprints to preserve translation matching. It preserves legal
attribution and leaves lowercase internal identifiers alone. PNG/SVG assets use
the full icon; monochrome vector assets use the icon's core paths.

The overlay requires `rsvg-convert` (included by the build Dockerfile), and saves
changed string-file backups in `build/helide-branding/backups/`. Applying it twice
without other source changes should not modify files again. Old Docker builder
images need rebuilding to obtain the new SVG-rendering dependency. For manual
development, run the overlay only after patches, name substitution, translations
and upstream resources have been applied:

```sh
python3 scripts/apply-helide-branding.py
python3 scripts/test-helide-branding.py
```

After compiling, an isolated headless smoke test checks the CLI, version page,
Settings branding and preserved upstream copyright:

```sh
cd mcp
HELIDE_TEST_EXECUTABLE="$(realpath ../build/src/out/Default/helium)" npm test
```

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
python3 scripts/check-frame-opacity-patch.py --patch helium/linux/wayland-settings.patch
python3 scripts/check-frame-opacity-patch.py --patch helium/linux/wayland-swipe-page-preview.patch
python3 scripts/check-frame-opacity-patch.py --patch helium/linux/linux-battery-energy-saver.patch
python3 scripts/check-frame-opacity-patch.py --patch helium/linux/wayland-fullscreen-opaque.patch
python3 scripts/check-frame-opacity-patch.py --patch helium/linux/helium-agent-access.patch
python3 scripts/check-frame-opacity-patch.py --patch helium/linux/helium-target-march.patch
python3 scripts/check-frame-opacity-patch.py --patch helium/linux/helide-branding.patch
python3 scripts/check-frame-opacity-patch.py --patch helium/linux/linux-window-close-toggle.patch
```

To turn edits made in `build/src` into a patch against the pinned upstream
files, use `scripts/generate-patch-from-build.py`. It ignores the domain
substitution that the build tree has applied.

### CPU target and PGO

`flags.linux.gn` sets `helium_target_march = "arrowlake"`, so the compiler and
the ThinLTO link generate code for Intel Core Ultra (Arrow Lake: AVX2,
AVX-VNNI, BMI2, GFNI, SHA). The browser then **does not run on older CPUs**.
Remove the line, or set another `-march` name, for a different machine.

Profile-guided optimization is off by default. Build with
`scripts/build.sh --pgo` to use the profile that matches the pinned Chromium.
Full builds with PGO, ThinLTO and a CPU target need a lot of memory: with 15 GB
of RAM, give the build container a memory cap and enough swap, so that a spike
kills the build and not your session.

## Settings

On native Wayland, **Settings → Appearance** shows three controls, below the
rounded-frame option, and **Settings → Behavior** shows the page-slide swipe
toggle (see [Slide pages when swiping](#slide-pages-when-swiping)). They are
hidden on X11 and other platforms.

| Control | Range | Default |
|---|---|---|
| **Browser window opacity** | Slider, 0–100% in 5% steps | 100% |
| **Blur behind the window** | Toggle | Off |
| **Transparent website backgrounds** | Toggle | Off |

They are per-profile prefs (`helium.browser.wayland_frame_opacity`,
`helium.browser.wayland_frame_blur`, and
`helium.browser.wayland_transparent_web_content`). Changing one applies to every
open window of that profile, with no relaunch: the frame type, opaque and blur
regions, each tab's default page background, and the frame tint are refreshed.
Blur strength cannot be set here, because the Wayland protocol exposes none; set
it in your compositor (see [blur strength on niri](#blur-strength-on-niri)).

The launch switches and `helium://flags` entries below still work and **override**
the Settings values when present, which is useful for scripted or test launches.
Leave a flag on **Default** to use the Settings value. If an opacity flag was
previously enabled in `helium://flags`, reset it to Default so the Settings slider
can take effect. Flags and switches are read at startup.


### Window close button

In **Settings → Appearance → Customize toolbar**, toggle **Show window close
button** to show or hide the window's “×” control. It defaults to on, is saved
per profile, and applies live to normal Linux browser windows. Hiding it removes
its caption-button space too; **Reset to default** brings it back.

This does not affect individual tabs' close buttons, app/popup windows, keyboard
shortcuts or compositor close commands. It controls browser-drawn client-side
buttons, not decorations owned by the compositor.

Implementation: [`linux-window-close-toggle.patch`](patches/helium/linux/linux-window-close-toggle.patch).
The isolated WebUI/persistence test uses the Playwright dependency from `mcp/`:

```sh
node scripts/test-window-close-toggle.mjs
```

It uses a temporary headless profile; visual button placement still needs a
Wayland window check.

## Let AI agents control Helide

**Settings → Behavior → Let AI agents control Helide** keeps Chromium's remote
debugging server (the DevTools protocol, CDP) running on `127.0.0.1:9222`, with
no per-connection approval prompt. Agents and tools that speak CDP, such as
chrome-devtools-mcp, Playwright, Puppeteer and plain scripts, connect to your
running browser at that fixed address. The setting is off by default, and
applies to the whole browser, not one profile.

```sh
curl http://127.0.0.1:9222/json/version      # the endpoint
chrome-devtools-mcp --browserUrl http://127.0.0.1:9222
```

An agent can work in your own window while you keep using it:

- **Its tabs stay in the background.** `Target.createTarget`, `/json/new`,
  `window.open` and links with `target="_blank"` from an agent's page all open
  as background tabs in your current window, whatever the client asks for
  (`focus`, `background: false` and `newWindow` are overridden).
- **They are grouped.** Agent tabs go into a collapsed, purple **Agent** tab
  group at the end of the tab strip. The group is not saved or synced, and goes
  away with its tabs. Expand it to watch.
- **It can't change what you see.** `Target.activateTarget` and
  `Page.bringToFront` succeed but do nothing, and a page in an agent tab cannot
  activate itself. Your active tab stays your active tab.
- **Its tabs keep running at full speed while hidden.** Their pages report
  `visibilityState: "visible"`, and timers, animation frames and screenshots
  work, so scripts don't stall.
- **It can see everything.** Clients can still list, attach to and control all
  your tabs, and use your signed-in sessions. Tabs the agent creates are what is
  kept out of your way, not what it can reach.

Anything running as your user can connect while the setting is on. Leave it off
unless you use agents. `--remote-debugging-port` and `--remote-debugging-pipe`
work as before, and Chromium's own approval mode under `chrome://inspect` is
used when this setting is off.

### Helide MCP server

The [`mcp/`](mcp/README.md) directory contains an attach-only TypeScript MCP
server for this endpoint. It provides 18 core tools for tabs, page reading,
element-based interaction, screenshots, dialogs, uploads and downloads. Agents
can browse without writing JavaScript. Existing tabs are readable but guarded
against modification; tabs created by the server are session-owned.

See [setup, tools and tests](mcp/README.md). History and media controls are planned
next, not part of the initial toolset. No Chromium rebuild is required.

## Energy saver on Linux

Energy saver is in **Settings → Performance**. It needs no setup: Helide reads the
battery from sysfs and UPower. Each rule works as follows:

- **Turn on when your computer is unplugged** or **Turn on at 20% battery**: as
  on other platforms.
- **System power-saver profile**: when power-profiles-daemon is in `power-saver`
  (`powerprofilesctl get`), Energy saver turns on too, whichever rule you chose,
  as long as the Energy saver toggle is on. Switching the profile back turns it
  off again.

Energy saver throttles background tabs, limits frame rates and reduces timer
frequency. With the Energy saver toggle off, the power-saver profile has no
effect on Helide.

## Slide pages when swiping

On native Wayland, a two-finger horizontal swipe on the touchpad slides the page
with your fingers, like Safari on macOS. The pages behave as a stack: going back,
the current page slides to the right and uncovers the previous page, which stays
still; going forward, the next page slides in from the right over the current
page, which stays still. A soft shadow falls from the moving page's edge. Release
past the commit point to navigate, or earlier to snap back. The browser chrome
stays in place; only the page area moves. Without this, Chromium only shows a
small arrow and then navigates.

Turn it off in **Settings → Behavior → Slide pages when swiping** (on by
default; the option is hidden outside Wayland). It is stored as the per-profile
pref `helium.browser.wayland_swipe_page_preview`. It affects touchpad swipes
only; touchscreen swipes and pull-to-refresh are unchanged, and Chromium's own
swipe-between-pages option still gates the gesture.

How it works, and its limits:

- A snapshot of a page is captured when you navigate away from it, and again when
  a swipe starts. Snapshots are kept in a memory-bounded cache (about 190 MB for
  the whole browser) and are dropped with their tab. Same-page (fragment or
  `pushState`) navigations cannot be captured reliably after the fact, so such an
  entry only has a snapshot if you swiped away from it. When there is none, the
  page slides over a plain themed background.
- The page moves at 0.3× the swipe distance and follows your fingers across its
  full width. Whether a release navigates is still Chromium's rule (a fixed swipe
  distance, 30% of the screen size), not a fraction of how far the page has moved.
- With **Transparent website backgrounds** on, the slide stays translucent: the
  real page is hidden while snapshots stand in for it, no opaque background is
  painted, and the page underneath is clipped to the strip the top page has
  uncovered, so the desktop (not the other page) shows through transparent
  areas. With it off, the slide is drawn over a solid themed background.

## Set the opacity

Use **Settings → Appearance → Browser window opacity**, or open
`helium://flags/#helium-frame-opacity`, choose an opacity, and relaunch the
browser. Available values range from fully opaque to clear. At `0`, the browser UI
background tint is invisible while text, icons, and controls remain visible.
The default is fully opaque.

Alternatively, pass an opacity at launch:

```sh
helium --ozone-platform=wayland --helium-frame-opacity=0.8
```

The value is a number from `0` to `1`; for example, `0.8` means 80% opacity.
Malformed, nonfinite, or out-of-range switch values fall back to fully opaque.
With no switch, the Settings value is used. The switch is read at startup, so
close the existing Helide process before relaunching. For the development build,
the executable is `build/src/out/Default/helium`.

Only the browser UI background uses this opacity. Web content remains opaque unless
its separate transparency option is enabled. Custom theme background
images are suppressed while this effect is active, and some floating controls
may retain their own backgrounds.

## Enable or disable blur

Turn on **Settings → Appearance → Blur behind the window**, or open
`helium://flags/#helium-frame-blur`, choose **Enabled** or **Disabled**, and
relaunch. Default makes no blur request. Enable browser UI or website transparency
so the effect can be seen. For example:

```sh
helium --ozone-platform=wayland --helium-frame-opacity=0.8 --helium-frame-blur=1
```

Use `--helium-frame-blur=0` to remove Helide's request. A compositor window rule
that forces blur can override that choice. Fullscreen, app, popup, devtools, and
picture-in-picture windows do not request this effect. Unsupported compositors
keep transparency without blur.

These controls require a build of this fork; standard Helium binaries do not
include them.

### Blur strength on niri

Wayland's background-effect protocol exposes a blur region, but no radius,
strength, or algorithm. Helide therefore cannot set a portable blur-strength
value. Set strength in your compositor. For example, niri 26.04+ accepts this
top-level block in `~/.config/niri/config.kdl`:

```kdl
blur {
    passes 3
    offset 3.0
}
```

Merge these settings into an existing `blur` block if you have one. They affect
**all background blur in niri**, not just Helide. Increasing `offset` makes the
blur broader without adding passes; increasing `passes` can smooth a broader
blur but costs more GPU work. Large offsets can produce artifacts. Niri's
global `blur { off }` disables blur even if Helide requests it.

#### Tips for niri users

- **Blur windows instead of wallpaper:** By default, niri enables `xray` on
  any background effect, which blurs the desktop wallpaper rather than the
  windows stacked underneath Helide. To blur windows behind Helide, add a
  window rule with `xray false` to `~/.config/niri/config.kdl`:
  ```kdl
  window-rule {
      match app-id="^helium$"
      background-effect {
          xray false
      }
  }
  ```
- **Prevent border/focus ring tint bleed:** Niri normally draws focus rings
  and borders with a solid background behind client-side decorated windows.
  To prevent this solid color from tinting the translucent frame:
  ```kdl
  window-rule {
      match app-id="^helium$"
      draw-border-with-background false
  }
  ```

See [niri's blur configuration](https://github.com/niri-wm/niri/wiki/Configuration%3A-Miscellaneous#blur),
[niri's window effects](https://github.com/niri-wm/niri/wiki/Window-Effects),
and the [Wayland background-effect protocol](https://wayland.app/protocols/ext-background-effect-v1).

## Transparent website backgrounds

Turn on **Settings → Appearance → Transparent website backgrounds**, or enable
**Transparent web content on Wayland** at
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

Version 0.2 starts at document creation, prioritizes visible backgrounds, and
locally caches learned page-canvas colors for earlier styling on repeat visits.
Cached fills are checked against the loaded page and replaced by fresh analysis.
The bounded cache expires after seven days and respects site/global opt-outs.

## License

Helium's original license and attribution are preserved. Helium-specific code
and patches use GPL-3.0; see [`LICENSE`](LICENSE). Unmodified imported Chromium
and ungoogled-chromium code keeps its original license; see
[`LICENSE.ungoogled_chromium`](LICENSE.ungoogled_chromium).
