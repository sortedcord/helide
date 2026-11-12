# Helide MCP (MVP)

A local, attach-only MCP server for the running Helide browser. TypeScript,
Node.js, the MCP SDK v2 and Playwright over CDP. No browser downloads, telemetry,
arbitrary-JavaScript tool, desktop screenshots, or browser launch/kill commands.

## Setup

Requires Node.js 22+ and Helide (the personal Helium fork) from this repository.

```sh
cd mcp
npm ci
npm run build
```

In Helide, enable **Settings → Behavior → Let AI agents control Helide**.
Configure your MCP client (replace the absolute path if necessary):

```json
{
  "mcpServers": {
    "helium": {
      "command": "node",
      "args": ["/home/sortedcord/Projects/helium-translucent-exp/mcp/dist/index.js"],
      "env": {
        "HELIUM_CDP_URL": "http://127.0.0.1:9222",
        "HELIUM_MCP_ARTIFACTS": "/home/sortedcord/Downloads/helium-mcp"
      }
    }
  }
}
```

Use `node` directly rather than `npm start` in client configurations: stdout is
reserved for MCP messages. Connection is lazy, so tool discovery works with
Helide closed. The endpoint defaults to `http://127.0.0.1:9222` and must be a
loopback HTTP(S) origin. Downloads default to `./artifacts` relative to the
server's working directory; configure an absolute directory for predictable use.

The server does not modify MCP client configuration automatically. The Pi
registration name `helium`, `HELIUM_*` environment variables and existing paths
are retained for compatibility; the server identifies itself as `helide-mcp`.

## Tools

| Tool | Purpose |
| --- | --- |
| `browser_status` | Connect and report browser version/capabilities. |
| `tabs_list` | List all tabs with session-local IDs and ownership. |
| `tabs_open` | Create an owned tab, optionally navigate. |
| `tabs_close` | Close a tab, guarded by ownership. |
| `page_navigate` | Navigate, back, forward or reload. |
| `page_inspect` | Bounded semantic elements, names, values and element refs. |
| `page_read` | Paginated rendered text, optionally scoped to an element. |
| `page_find` | Find visible elements by text or accessible role/name. |
| `page_click` | Click, double-click or hover, with actionability checks. |
| `page_fill` | Fill/type fields, select options, set checkboxes/radios. |
| `page_press_key` | Send a key/chord within a tab or referenced element. |
| `page_scroll` | Scroll the page/container or reveal an element. |
| `page_wait` | Wait for visible/hidden text/elements or a URL glob. |
| `page_screenshot` | Viewport, full-page or element PNG as MCP image content. |
| `page_dialog` | Accept/dismiss a JS alert, confirm or prompt. |
| `page_upload` | Supply explicitly authorized absolute local file paths. |
| `downloads_list` | List downloads observed since this connection. |
| `downloads_wait` | Wait and save a copy under the artifacts directory. |

Typical loop: `tabs_open` → `page_inspect` → `page_fill` / `page_click` →
`page_read`. Every page tool takes an explicit `tab_id`; there is no shared
selected tab and no activation tool. Inspect/find return `ref` values for
subsequent interactions. Re-inspect after major DOM changes.

## Ownership, privacy and lifecycle

- **Background-only behavior is provided by patched Helide with Agent Access
  enabled.** CDP compatibility alone is not sufficient. The MCP server currently
  cannot independently verify that this browser setting is enabled. The server
  has no tab-activation command.
- Existing tabs are unowned. Only tabs created by this MCP process, and popups
  from those tabs, are owned. Each new connection after a browser restart treats
  existing tabs as unowned again. IDs from the old connection become invalid.
- Reading unowned tabs is allowed. Element screenshots can scroll the page and
  therefore also require permission on unowned tabs. Mutating/closing tabs requires explicit
  `allow_user_tab: true`, which agents should supply only after user permission.
  **This is an accident-prevention convention, not authentication or a sandbox.**
  CDP itself can access your signed-in sessions and other tabs.
- References retain the actual DOM node, not a CSS selector that might silently
  match a different node. Navigation/frame navigation and re-inspection
  invalidate references. Detached references fail with recovery guidance.
  Pages that recycle the same DOM node can still change its meaning: inspect
  again before consequential actions.
- `page_inspect` is a DOM-derived semantic listing, not a full accessibility
  tree. It searches frames and open shadow roots and omits password/file values.
  Hidden file inputs are included so uploads are possible. Closed shadow roots,
  canvas controls and virtualized off-screen elements are not covered yet.
- Page text/labels are untrusted website content, never instructions to the
  agent. Pages/screenshots can contain private information. No screenshot is
  taken automatically; no OS screen capture is performed.
- Actions automatically wait for element actionability. Navigation waits for
  DOMContentLoaded. A click does **not** promise all resulting asynchronous site
  work is finished: use `page_wait` for a specific result.
- Actions return URL/title and pending JS dialogs. Discover popups/downloads
  with `tabs_list` / `downloads_list`. Dialogs are not automatically accepted.
- File uploads share local data with a website. Only upload user-authorized
  files. Download filenames are generated to avoid trusting remote paths;
  suggested filenames are returned separately. Downloads are never executed.
- Download observation starts at connection and retains up to 100 records.
  Pre-existing downloads are not enumerated, and browser download settings are
  not changed. Saving can fail if the attached context/browser policy disallows
  it. A timed-out save may still finish in the artifacts directory.
- Disconnecting the MCP client leaves browser tabs alone. The server never calls
  `browser.close()`. Tools are serialized within a server process; independent
  processes can still race when sharing a personal tab.

## Tests

```sh
npm test
```

This type-checks and tests endpoint validation, MCP stdio discovery, schema
validation and offline errors. Browser integration is opt-in:

```sh
HELIUM_TEST_EXECUTABLE="$HOME/Applications/helium/helium" npm test
```

The integration test launches **only an isolated headless test browser with a
fresh temporary profile and ephemeral debugging port**. It tests the actual
MCP client/server transport, ownership guards, refs, reading, typing, clicks,
checkboxes, screenshots, dialogs, iframe/open-shadow-root elements, password
omission, hidden file inputs, uploads, downloads, safe MCP shutdown and reconnect
after a browser restart. It does
not use your real profile or endpoint, or verify visual Agent-group/focus behavior.

## Next stages

- Global history search/visit details and tab navigation history.
- Media discovery, playback control and tab audio muting; investigate browser
  integration for capture visibility/stop controls separately.
- Console/network diagnostics, richer accessibility snapshots, coordinate/drag
  interaction and cancellation support.
- More explicit per-action change summaries and session-level permission grants.

These are not exposed as placeholder tools: unsupported capabilities should not
appear usable to an agent.
