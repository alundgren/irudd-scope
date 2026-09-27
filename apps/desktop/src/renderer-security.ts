import { protocol, session, type WebContents } from "electron";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";

export function configureRendererSecurity(directory: string): void {
  const csp =
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; frame-src 'self' about:; object-src 'none'; base-uri 'none'; form-action 'none'";
  protocol.handle("scope", async (request) => {
    const url = new URL(request.url);
    if (url.host !== "app" || !["GET", "HEAD"].includes(request.method))
      return new Response(null, { status: 404 });
    const file = resolve(
      directory,
      `.${decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)}`,
    );
    if (!file.startsWith(directory)) return new Response(null, { status: 404 });
    try {
      const mediaTypes: Record<string, string> = {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".woff2": "font/woff2",
        ".woff": "font/woff",
      };
      return new Response(new Uint8Array(await readFile(file)), {
        headers: {
          "Content-Type": mediaTypes[extname(file)] ?? "application/octet-stream",
          "Content-Security-Policy": csp,
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({
      cancel: !["scope:", "data:", "blob:", "about:"].some((prefix) =>
        details.url.startsWith(prefix),
      ),
    });
  });
}

export function restrictRendererNavigation(contents: WebContents): void {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event) => event.preventDefault());
  contents.on("will-attach-webview", (event) => event.preventDefault());
}
