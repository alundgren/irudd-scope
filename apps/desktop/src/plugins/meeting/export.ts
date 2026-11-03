import type { Page } from "./contract.ts";
import { escapeHtml } from "./html.ts";

/**
 * JSON that is safe inside a `<script>` element. Escaping every `<` means the text
 * can never contain `</script` or `<!--`; U+2028 and U+2029 are escaped for older
 * JavaScript parsers that treat them as line ends.
 */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** A standalone HTML document for the page, from already sanitized body HTML. */
export function standaloneHtml({
  page,
  bodyHtml,
  css,
}: {
  page: Page;
  bodyHtml: string;
  css: string;
}): string {
  const title = escapeHtml(page.title.trim() || "Meeting");
  const style = css.replace(/<\/style/gi, "<\\/style");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title}</title>
<style>
:root { color-scheme: light dark; }
body { margin: 0; }
${style}
</style>
</head>
<body>
<main class="mc-page">${bodyHtml}</main>
<!-- Meeting canvas page. The JSON in #meeting-page is the editable source; the HTML above was rendered from it. -->
<script type="application/json" id="meeting-page">${scriptJson(page)}</script>
</body>
</html>
`;
}
