# Container Color Highlighter for Burp Suite

Highlights Burp Proxy HTTP history rows using the container headers added by the browser
extension:

- `X-Container-Name`
- `X-Container-Color`
- `X-Container-Tab`

The row highlight color follows the container color, and the row note records the container name
and tab ID. Existing notes are preserved.

## Requirements

- Burp Suite 2024.12 or later. The extension is compiled against Montoya API `2024.12`, which also
  runs on Burp 2025.x.
- JDK 17 or later only if rebuilding from source. Burp supplies the Montoya API at runtime, so the
  API JAR is not bundled in the extension.

## Build

From this directory:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\build.ps1
```

The script downloads `montoya-api-2024.12.jar` from Maven Central into `.build/` and writes:

```
dist/containers-burp-highlighter.jar
```

To compile against another Montoya release:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\build.ps1 -ApiVersion 2025.10
```

Use the API version that matches the installed Burp release if a build is rejected.

## Install in Burp

1. Open **Extensions → Installed**.
2. Click **Add**.
3. Set **Extension type** to **Java**.
4. Select `dist/containers-burp-highlighter.jar`.
5. Confirm that **Container Color Highlighter** appears in the installed extensions list.

## Use

1. In the browser extension options, enable **Burp Suite headers**.
2. Proxy the browser through Burp.
3. Load pages in non-Default containers.
4. Proxy HTTP history rows will be highlighted and annotated with the container name and tab ID.

Color mapping: red, orange, yellow, green, cyan, blue, pink, purple/magenta, and grey/gray. Unknown
colors map to grey. Requests without `X-Container-Name` are left unchanged.

If a row is not highlighted, check that the header is present in the request and that the browser
traffic is going through Burp Proxy rather than another tool.
