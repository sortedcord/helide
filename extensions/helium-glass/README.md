# Helium Glass

A companion extension for [Helide](https://github.com/sortedcord/helium-translucent-wayland). It
automatically samples each page's palette and replaces suitable background
fills with translucent versions of their original colors. Light pages keep
light tints; dark pages keep dark tints. Large page backgrounds become clearer
than cards, while floating overlays retain more opacity.

Text and images keep their normal opacity. The extension changes background
colors and suitable CSS gradient stops, rather than fading whole elements.

## Install

1. Turn on **Settings → Appearance → Transparent website backgrounds** in this
   fork (no relaunch needed). Alternatively, enable **Transparent web content on
   Wayland** at `helium://flags/#helium-transparent-web-content` and relaunch,
   or launch with `--helium-transparent-web-content=1` on Wayland.
2. Open `helium://extensions` (or `chrome://extensions`) and enable
   **Developer mode**.
3. Click **Load unpacked** and select this directory, `extensions/helium-glass`,
   which contains `manifest.json`. If using a release ZIP, extract it first and
   select the extracted directory containing the manifest.
4. Reload already open websites, then pin **Helium Glass** in the extensions
   menu for quick access to its controls.

The extension is enabled automatically on supported websites. No Chromium
rebuild, package manager, bundler, account, or network service is needed.
In regular Chrome/Helium, it can change CSS fills but cannot make the browser's
opaque page backing show the desktop.

Optional compositor blur is controlled by Helide's separate **Blur behind the
window** setting (or `--helium-frame-blur=1`). This extension does not set the compositor's
blur radius or change your browser launch settings.

## Configure

Click the extension icon to adjust:

- **Global switch:** enable or disable the extension on all supported pages.
- **This website:** keep the site's original styling. This also covers its
  embedded frames; the preference is saved for the hostname (including port).
- **Transparency:** `0` restores original styles; higher values make eligible
  fills clearer. The default is `65%`. It is an effect strength, rather than a
  uniform alpha for every surface. Cards and overlays retain a tint at `100%`.
- **Protect surface contrast:** retain more opacity on cards when their normal
  text contrast would otherwise fall. Enabled by default.
- **Reanalyze this page:** run another scan after an unusual layout change.

Settings stay on this device. Turning the extension off restores the original
backgrounds without reloading. Site settings apply across HTTP and HTTPS for the
same host. Local file pages share one `file://` preference.

Open [`demo.html`](demo.html) to try light and dark themes, gradients, and new
cards. For local files, open the extension's **Details** page and enable
**Allow access to file URLs** first. Alternatively, run
`python3 -m http.server 8765 --bind 127.0.0.1` from this directory and visit
`http://127.0.0.1:8765/demo.html`.

## How it works

`content.js` samples visible page points and their ancestors to infer the
dominant opaque background. The page's colors take precedence over the OS theme;
the OS preference supplies a fallback when no opaque surface can be found.

`palette.js` classifies fills by color similarity, saturation, area, and layout.
It keeps the existing RGB tint, assigns less alpha to broad page canvases, and
more alpha to smaller surfaces and elevated overlays. The optional contrast
check increases card opacity when necessary against black and white backdrops.
It is a heuristic: wallpaper, stacked fills, inherited text colors, and complex
layouts can still affect readability. Clear page canvases are exempt from the
contrast check so they can actually clear.

`background.js` applies background-only CSS at user origin, targeted to the
exact frame document. This works with page CSP and inline `!important` fills.
Original inline styles are not edited. Unique element markers select grouped
rules; rescans temporarily remove those markers and suspend provisional cached
styles before measuring the original page, so repeated scans do not keep
reducing alpha.

A mutation observer rechecks added content and theme/style changes. Work runs
in small idle batches, capped at 8,000 elements per scan and 1,000 distinct
style groups per document. Returning to a tab triggers another scan. Per-site
settings use the top-level site's host, including for cross-origin frames.

`shared.js` contains setting defaults, `cache.js` validates and renders learned
backgrounds, and `popup.*` implements the controls. The
extension uses Manifest V3 and requires Chromium 120 or later.

## Loading and caching (0.2.0)

The content script starts at [`document_start`](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts#run_time),
instead of waiting for `document_idle`. A small priority pass handles the page
canvas and visible ancestors first. The remaining page is scanned in idle
batches. Startup does not wait for a full scan, a 180 ms debounce, or deferred
page scripts. CSS updates are throttled to about one frame instead of having
their timer postponed by each scan batch. Continuous page mutations also no
longer keep resetting the scan timer.

The extension learns original RGB/alpha values for `html`, `body`, and eligible
large flat backgrounds with a unique simple ID or `main` tag. On a repeat visit,
the service worker inserts provisional background CSS as soon as the document
starts. It uses the current transparency strength, then hands over to fresh
analysis once the new page's surfaces have been checked. Cards, text, media,
images, and entire DOM snapshots are not cached.

The local cache keeps up to **64 page paths**, with up to 24 background records
each; entries expire after **seven days**. Keys are hashes of the page's origin
and path; query strings and fragments are excluded. Pages on the same path can
share a provisional record, which is always rechecked. Root/body theme classes
and attributes guard replay, and a different OS color scheme skips it. Global
and site opt-outs skip replay too. Incognito visits do not read or write this
cache.

This reduces the initial opaque flash; it cannot guarantee zero flashing on
every page. A service-worker cold start, new backgrounds, late stylesheets,
script-driven theme changes, or uncached containers can still need a fresh
pass. First visits also benefit from the earlier priority scan.

## Limits

This is an experimental automatic restyler, and some sites will need the site
toggle or a lower strength. In particular:

- Strong accent/status colors, links, buttons, inputs, editable areas, and
  media subtrees are left alone. Background image URLs are preserved.
- Neutral CSS gradients can be made translucent. Image pixels, SVG/canvas
  drawings, masks, pseudo-elements, and shadow DOM are not rewritten.
- A remaining opaque ancestor or background image can still cover the desktop.
  Deeply nested translucent fills also accumulate opacity.
- Browser pages, the Chrome Web Store, and other restricted documents cannot
  be styled by content scripts. Embedded PDF viewers are not supported.
- DOM changes are detected after they happen; there may still be a short flash
  of the original background while a page loads or switches theme. Constantly animated
  or very large pages can need a manual rescan.

## Privacy and permissions

Palette analysis happens entirely in the page's local content script. There are
no uploads, analytics, remote styles, remote code, or external dependencies.
The extension reads computed styles and element geometry; it does not collect
page text. Saved site preferences contain hostnames. The bounded background
cache stores colors, simple surface selectors, theme attributes, and hashed
page-path keys; it contains no plaintext page URLs, query strings, HTML, or
page text. This cache stays in extension-local storage, alongside preferences;
it is separate from the browser's HTTP cache.

HTTP/HTTPS host access is required to run automatically across websites. File
access is optional and controlled by the browser. `scripting` inserts/removes
the generated CSS; `storage` saves local preferences; `activeTab` supports the
popup's current-tab controls. The popup displays the current host and palette.

## Development and tests

Edit the files, click **Reload** on the extension's browser page, and reload the
website. There is no compilation step.

```sh
# From the repository root; Node's built-in test runner, no npm install.
node --test extensions/helium-glass/test/*.test.cjs

# Native Wayland integration check: built Helium, matching ChromeDriver, Pillow.
python3 extensions/helium-glass/test/browser.py
```

The browser check uses a temporary profile and local HTTP fixtures. It checks
rendered screenshot alpha, CSP and inline important styles, gradients, protected
controls, theme changes, dynamic cards, saved settings, cross-origin frames,
and restoration when disabled. A deliberately delayed page checks transparency
before `DOMContentLoaded`, cache replay, fresh-color sampling, theme guards,
and cached-load opt-outs. `--startup-only` prints first/repeat-visit timings;
`--extension PATH` can compare another unpacked version. `--binary` and
`--driver` override the default
`build/src/out/Default` executables. It does not modify your existing profile.

To make a release ZIP from a source checkout, run from this directory:

```sh
python3 package.py
```

The archive contains the extension runtime files, icons, demo, README, and
license. It excludes tests, build tooling, profiles, and caches.

Licensed under GPL-3.0; see [`LICENSE`](LICENSE).
