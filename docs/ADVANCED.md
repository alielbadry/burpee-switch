# Advanced details

BURPEE-SWITCH is a cookie-jar swapping extension, not true per-tab isolation. Chromium has no
`contextualIdentities` API, so one container is live at a time.

## How switching works

The active container's cookies are the browser's live cookies. Other containers' cookies are stored
in `chrome.storage.local`. Switching containers saves the current cookies, clears the live jar, and
restores the target jar. The page is reloaded only when it was not already loaded under that
container, so normal tab switching does not refresh pages. After a browser restart, the first
activation of each restored tab is force-reloaded under its assigned container because the
background page may have loaded under another jar. Extension and browser pages never change the live
jar; only web pages do.

For a site that stores its sign-in token in `localStorage`, enable **Isolate login storage** in the
popup's **This site** panel. The extension saves that origin's `localStorage` per container and
restores it when you switch. Sign in once in each container. The first time a tab loads under a
container it may reload once; later switches restore the tab's storage without reloading. This works
for apps that keep multiple account caches in IndexedDB and select them from the restored token, but
it is not full storage isolation: `sessionStorage`, Cache Storage, and in-memory state are still
shared.

## Burp Suite request labels

Enable **Burp Suite headers** under Tab indicators and proxy the browser through Burp. Requests from
every non-Default container tab then carry:

| Header | Value |
|--------|-------|
| `X-Container-Name` | Container name |
| `X-Container-Color` | Container color |
| `X-Container-Tab` | Chrome tab ID |

The headers appear in Burp's Proxy → HTTP history request view, so each request can be traced back to
its container and tab. Default-container tabs are not tagged. These are session-scoped
`declarativeNetRequest` rules rebuilt when tabs are assigned, containers are renamed, or the option
is toggled.

To color Proxy history rows automatically, load
`burp-extension/dist/containers-burp-highlighter.jar` as a Java extension in Burp. It maps
`X-Container-Color` to Burp highlight colors and adds the container name and tab ID to the row note.
See `burp-extension/README.md` for build and installation details.

The headers are sent to the destination site, not only to Burp. Enabling this can affect cross-origin
requests if a server rejects unknown headers or its CORS policy does not allow them. Use it only
while testing and disable it for normal browsing.

## Known limitations

Unlike Firefox containers, this cannot achieve concurrent isolation:

- **One live cookie jar at a time.** Background tabs in other containers can briefly send requests
  with the active jar. Keep one tab per site per container.
- **Cookies are swapped by default; `localStorage` only for sites with login-storage isolation
  enabled.** `sessionStorage`, IndexedDB, Cache Storage, and in-memory tokens remain shared. Sites
  whose auth depends on IndexedDB or in-memory state may still not support multiple accounts.
- **Partitioned (CHIPS) cookies are not swapped.** They are excluded from snapshots and can leak
  across containers.
- **Incognito windows are not supported.**
- **A page reload is still used when it was loaded under a different container** so it re-reads the
  restored cookies. Normal tab switching does not reload the page.
- **Tab markers are cosmetic page changes.** Favicon and title markers are applied by a content
  script; some sites may overwrite them, and `chrome://` / extension pages are never modified.
- **Title markers change the page title**, so bookmarks and history entries may include the marker.
- **Favicon markers can fail on cross-origin or CSP-restricted icons.** They then fall back to a
  colored tile so the tab is still marked.
- **Burp headers are visible to the destination server** and may trigger CORS or unknown-header
  rejections. The option is off by default; enable it only during proxy testing.
- **Cookie changes while suspended** are safe because switches snapshot the live jar first, but a
  browser crash during a swap relies on the recovery marker written before clearing.
- **Tab assignments are restored on browser restart**, even with grouping off, from a local URL
  snapshot. Tabs whose URLs changed or were not present in the last snapshot fall back to Default.
  Restored Default tabs stay in Default even when a site rule matches that domain; rules apply to new
  visits. Cookie jars are always persisted.
- Cleaning cookies through Chrome's site-data UI only affects the live jar; stored jars are not
  updated.
- Sites with strict SSO/session binding may require re-authentication after switching.

If you need real isolation, use one Chrome profile per identity
(`chrome://settings/manageProfile` or separate `--user-data-dir` instances). This extension is a
convenience layer, not a security boundary.

## Permissions

| Permission | Why |
|------------|-----|
| `cookies` | Snapshot, clear, and restore cookie jars. |
| `tabs` | Track tab → container assignments, open tabs, reload after switches. |
| `tabGroups` | Create and color container tab groups. |
| `storage` | Persist containers, site rules, settings, and cookie jars. |
| `unlimitedStorage` | Cookie jars can exceed the default 10 MB storage quota. |
| `contextMenus` | "Open link/page in container" menus. |
| `scripting` | Apply tab markers and the page edge, and read/write `localStorage` for isolated sites. |
| `declarativeNetRequest` | Add optional per-tab Burp Suite request headers. |
| `<all_urls>` | Read and write cookies for any site you visit; run tab-marker content scripts. |

## Data and privacy

- Everything stays local. No network requests, analytics, or telemetry.
- Cookie jars and isolated `localStorage` snapshots are stored in `chrome.storage.local` in plaintext,
  protected only by your OS profile and Chrome's extension storage. Do not use this on a shared
  profile with untrusted users.
- Isolated `localStorage` snapshots include whatever a site stores there, including sign-in tokens.
  Disabling **Isolate login storage** stops further swaps but does not delete existing snapshots.
- Removing the extension deletes its storage. Export anything you need first.
- The extension reads cookies for every site because swapping requires a full jar snapshot.
- If Burp headers are enabled, container names, colors, and tab IDs are sent to every site contacted
  by those tabs.

## Layout

```
background/service-worker.js   routing, events, cookie-swap orchestration
content/container-visual.js    favicon/title/page-edge markers
content/container-visual.css   page-edge styles
lib/constants.js               default containers, colors, marker settings, limits
lib/store.js                   chrome.storage helpers
lib/jars.js                    snapshot/clear/restore + swap queue + recovery
lib/groups.js                  tab groups, toolbar icons, assignment rebuild
lib/util.js                    URL/domain/cookie helpers
popup/                         toolbar popup
options/                       management page
scripts/                       validation and icon generation
```

## Manual test checklist

1. Load unpacked and open the popup. Four seeded containers plus Default are visible.
2. Open a tab in Personal, log in to a site. Open a tab in Work, log in to the same site with a
   different account. Switch tabs; each tab should keep showing its own account without reloading.
3. Switch to Default; the original browser session should return.
4. Assign a domain to a container, then open that domain in a new tab; it should open in that
   container. Open a link from a container tab; the new tab should inherit the container.
5. Add a site assignment manually on the options page and verify it appears in the list.
6. Enable grouping in options; verify container tabs are grouped and colored, then disable it and
   verify tabs ungroup while the brand logo stays in the toolbar.
7. Switch tab indicators between favicon dot, favicon tile, title emoji, and site icon + badge +
   title; verify open web tabs update. Toggle Color tab edge and toolbar icon and verify each. Set it
   to Off and verify all markers are restored.
8. Enable Burp Suite headers, proxy through Burp, and load a page in a non-Default tab. Verify the
   request carries `X-Container-Name`, `X-Container-Color`, and `X-Container-Tab`; a Default tab must
   not carry them. Disable the option and verify new requests are untagged.
9. Restart the browser. Verify cookie jars and tab assignments are restored, with or without
   grouping.
10. Delete a container; its tabs and site rules fall back to Default and its jar is removed.
11. Check the service worker and page consoles (`chrome://extensions` → Details → service worker) for
    errors.
