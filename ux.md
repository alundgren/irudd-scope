# UI decisions

Scope is a Mac workspace for inspecting artifacts left by coding agents. The selected design is the compact Excalidraw-inspired interface in the [visual reference](docs/excalidraw-style-study.md) and [interactive specimen](docs/mockups/appearance-study.html).

Use cool neutral backgrounds, violet selection and focus, small rounded controls, system typography, and light or dark appearance. This fits the embedded editor and Mac appearance conventions. The house principles of task focus, reversible actions, plain wording, and keyboard access apply. Scope's palette and system typography are intentional product choices.

The repo's [UX guidance skill](.agents/skills/ux-guidance/SKILL.md) governs UI implementation and review. [tokens.css](apps/desktop/src/renderer/tokens.css) defines the actual values and is imported by both desktop styles and the specimen. [style.css](apps/desktop/src/renderer/style.css) owns layout and the mapping to shadcn roles. The reference documents explain decisions without maintaining another palette.

A single compact tab strip leaves the rest of the window for content. Search and the workspace menu expose tools, settings, provenance, and downloads on demand. Closing a tab preserves its artifact. New arrivals and background updates never steal selection. Tabs indicate unread updates and remain scrollable when titles overflow.

Focus mode keeps the artifact mounted, hides workspace controls, and leaves a small exit at the top center. It preserves selection, scroll, zoom, and diagram conversation. Excalidraw uses zen mode. Escape closes the active dialog or editor interaction before exiting focus.

Settings opens with search focused. Global search finds specific settings too. Appearance offers System, Light, and Dark, initially System. Excalidraw follows the same appearance while images and isolated HTML retain their authored content. Provider, model, and credentials stay together. Saved secrets are never displayed. OpenRouter and Gemini 3.8 Flash are the enabled choices; other providers appear only when implemented.

Create diagram is an explicit tool in the empty workspace, search, and workspace menu. An existing diagram has an optional Ask agent conversation, closed by default. It sits beside the canvas or overlays it in a narrow window. Generation has a cancel action; Save publishes changes. SQLite preserves the conversation, unsent prompt, working canvas, and zoom and pan across restarts and closed tabs. Closing a tab retains that data. Incoming revisions preserve unsaved edits and offer loading the latest content or saving a separate copy.

Ordinary settings and the open and closed tab lists also live in SQLite. Provider credentials live directly in macOS Keychain. If Keychain access fails, show an unavailable status and a recovery message while keeping Settings usable. Show failed draft writes with a retry action and preserve the working canvas.

The app icon uses the Breath of fresh air design: two charcoal open window panels, a blue breeze, and a blue circle on a pale sky-blue tile. Rounded strokes keep it consistent with the Excalidraw canvas. The Mac Dock and README use the same artwork on light and dark backgrounds. The compact version omits the circle and thickens the strokes for small sizes. [Icon assets and export instructions](apps/desktop/resources/README.md) live with the desktop app.

English UI, keyboard navigation, visible focus, labeled icon controls, and readable contrast are normal implementation requirements. Design for a Mac laptop and an external monitor, including long titles and more tabs than fit. Scope has no agent orchestration or general chat. Optional session tools remain future work.
