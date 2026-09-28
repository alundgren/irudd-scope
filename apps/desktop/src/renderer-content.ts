import { protocol } from "electron";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";

export function serveRendererContent(directory: string): void {
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
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}
