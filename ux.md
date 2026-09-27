# UI decisions

The main task is inspecting the current artifact. Content should occupy almost the entire window. Use compact tabs or another equally efficient navigation treatment. Do not add a permanent dashboard, chat pane, activity sidebar, or provenance panel.

Closing a tab does not delete its artifact. Search can reopen artifacts and optional tools. New arrivals and background updates must not steal selection. Show a small indication when an existing artifact changes. Protect unsaved edits with a visible conflict choice.

Focus mode hides workspace controls except a small visible exit control. Escape exits focus mode without losing selection, zoom, or scroll. Optional session tabs are added manually through the same discoverable navigation as tools. Observation and hooks are never required to use artifacts.

Local artifact storage starts with the app and requires no connection setup. Settings keeps the diagram provider, model, and credentials together. Initially the provider list contains OpenRouter and the model list contains Gemini 3.8 Flash. Show whether a key is saved, plus replace and remove actions. Never display a saved secret again. Explain temporary key storage in Linux development only when relevant. Future local Codex/Claude provider choices are not enabled until implemented.

English UI. Keyboard navigation, visible focus, labels for icon controls, and readable contrast are part of normal implementation. Design for a Mac laptop and an external monitor, including long artifact titles and more tabs than fit.

The house visual style does not apply. The [prototype brief](docs/visual-prototype-brief.md) asks a separate agent to explore navigation and visual choices. Until one is selected, use the stock shadcn neutral tokens and restrained compact controls. [Desktop CSS](apps/desktop/src/renderer/style.css) owns the actual values: white background, near-black primary text, neutral secondary controls, a 0.625rem base radius, and locally bundled Geist Variable with a sans-serif fallback. Excalidraw keeps its canvas controls and fonts. This functional styling is not the final visual direction.

The app icon uses the Breath of fresh air design: two charcoal open window panels, a blue breeze, and a blue circle on a pale sky-blue tile. Rounded strokes keep it consistent with the Excalidraw canvas. The Mac Dock and README use the same artwork on light and dark backgrounds. The compact version omits the circle and thickens the strokes for small sizes. [Icon assets and export instructions](apps/desktop/resources/README.md) live with the desktop app.

Create diagram is an explicit tool found from the empty workspace or search. An existing canvas has one change field, a cancel action during generation, and an explicit Save action. This is not agent chat. An incoming revision preserves unsaved diagram edits and offers loading the latest content or saving a separate copy. Unsaved drafts survive changing tabs during the current process; Save writes them to the artifact store on the Mac.
