# Published file views

`views.tsx` contains the existing image, Markdown, HTML, text, and download
fallback views. `renderer.tsx` registers them as one file plugin. Shared
content loading belongs to `../../library/content-view.tsx`.

HTML displays the published document unchanged in an iframe. Scripts, external
resources, and embedded forms work without a sandbox or injected content policy.
HTTP(S) links and popups open in the default browser; in-page anchors stay in the
document. Desktop main owns this navigation handling. Test interactive prototypes
in real Electron when changing rendering. Markdown omits raw HTML and displays links and images as text.
Revoke image object URLs when replacing content or unmounting.
