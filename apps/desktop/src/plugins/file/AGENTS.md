# Published file views

`renderer.tsx` registers the file plugin. It shows published files with the
shared viewers in `../../renderer/file-views.tsx` and keeps the download
fallback for kinds without a viewer. Shared content loading belongs to
`../../library/content-view.tsx`.

HTML displays the published document unchanged in an iframe. Scripts, external
resources, and embedded forms work without a sandbox or injected content policy.
HTTP(S) links and popups open in the default browser; in-page anchors stay in the
document. Desktop main owns this navigation handling. Test interactive prototypes
in real Electron when changing rendering. Markdown omits raw HTML and displays links and images as text.
Text shows line numbers. Revoke image object URLs when replacing content or unmounting.
