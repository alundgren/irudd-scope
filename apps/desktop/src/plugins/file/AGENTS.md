# Published file views

`views.tsx` contains the existing image, Markdown, HTML, text, and download
fallback views. `renderer.tsx` registers them as one file plugin. Shared
content loading belongs to `../../library/content-view.tsx`.

HTML stays inside an empty-sandbox iframe with scripts, external resources,
forms, and navigation disabled. Markdown omits raw HTML and displays links
and images as text. Revoke image object URLs when replacing content or
unmounting. Test these restrictions in real Electron when changing rendering.
