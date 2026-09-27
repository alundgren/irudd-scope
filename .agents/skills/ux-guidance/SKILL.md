---
name: ux-guidance
description: Design, implement, or review Scope desktop UI, interactions, user-facing copy, and visual prototypes using its selected Excalidraw-inspired design. Use for UI work in this repository.
---

# Scope UX guidance

Read [ux.md](../../../ux.md) for settled product decisions. Inspect the affected desktop components before changing them. For visual comparison, open the [specimen](../../../docs/mockups/appearance-study.html) and consult the [design reference](../../../docs/excalidraw-style-study.md). The compact strip is selected. The floating version is a comparison only.

Paths above and below are relative to this skill directory.

## Design from the artifact

The user is inspecting or editing the selected artifact on a Mac. Give that content the window. Reserve one compact strip for the workspace menu, open tabs, search, and focus. Put secondary actions in the workspace menu or the artifact's controls. Keep the artifact's title in its tab rather than repeating it in an app heading.

Let diagrams, images, and HTML use the available area. Limit prose to a comfortable reading width. Ordinary artifact content needs no surrounding card or shadow. Menus and dialogs may use the shared shadow.

Keep tab labels readable in one scrolling row, with ellipsis and the full title available through search and a tooltip. Keep the selected tab visible. Selection uses both a tinted background and a solid marker. Arrivals and updates indicate change without selecting themselves. Closing a tab closes its view; reopening finds the same artifact.

Focus keeps the artifact mounted, preserves scroll and zoom, hides workspace controls and diagram chat, and shows the small exit above the canvas. Escape dismisses the active dialog or editor interaction before leaving focus. Verify that the exit clears the editor's controls.

## Use the implementation's values

[Tokens](../../../apps/desktop/src/renderer/tokens.css) owns the palette for both appearances, typography, spacing, radii, control sizes, focus, and motion. The specimen imports this same file. Change shared values there, with a reason tied to the user's task. Keep literal values out of this skill and palette tables in other documents.

[Desktop styles](../../../apps/desktop/src/renderer/style.css) maps the tokens to shadcn roles and owns component layout. Reuse the existing [controls](../../../apps/desktop/src/renderer/components/ui) for buttons, inputs, textareas, selects, and dialogs. Use the installed Lucide icons consistently; add a dependency only for a concrete missing capability.

Use cool neutrals for the canvas and controls, violet for selection and keyboard focus, and primary text on selected backgrounds. Use muted text for secondary details. Decorative dividers and recognizable input boundaries have separate tokens. Error and destructive states use the danger role plus words that explain the action or failure.

Use system text for Scope controls, ordinary weights, and spacing before large headings. Monospace belongs to code, paths, and comparable identifiers. Preserve Excalidraw's drawing fonts and authored content. A UI theme change must not rewrite an artifact, recolor an image, or invert an HTML preview.

Appearance is System, Light, or Dark in Settings. Follow the existing desktop settings API and native appearance integration. Keep palette values, user preferences, and artifact content separate.

## Tools and settings

Search finds artifacts, tools, and specific settings. Settings has its own focused search input, matches related terms, and explains empty results. Keep provider, model, and key together. Show key presence, replacement, and removal without revealing saved secrets. List working provider choices only.

A diagram's Ask agent control opens a conversation on request. Keep the canvas visible alongside it at desktop widths and overlay the panel in a narrow window. Preserve conversation and draft when it closes, when changing tabs, and during focus. Save working canvases, unsent prompts, conversation, and zoom and pan through the desktop SQLite API so they survive restarts. Closed tabs retain their data. A request uses the current scene and goes through the existing desktop provider. Enter sends, Shift+Enter adds a line, and a pending request exposes Cancel. Saving publishes the edited canvas explicitly.

Keep edits when a new revision arrives or the user changes the canvas during generation. Explain the conflict and offer loading the latest artifact or saving a copy. Loading, cancellation, provider failures, and draft write failures must leave a useful next action. Keep persistence in SQLite through named preload operations; do not add renderer storage or settings files.

## Verify the changed experience

Exercise the affected flow in the running desktop with synthetic content. Include light and dark, a laptop and a narrow window, long titles, overflowing tabs, keyboard focus, and relevant empty, pending, error, and conflict states. Check position and drafts after focus, settings, tab switches, and theme changes when those paths are affected.

Read [development](../../../docs/development.md) for launch and validation. Use tests through real desktop entry points for behavior changes. Compare screenshots to the selected specimen for visual changes. Run `vp run ready` before completion. Update `ux.md` only when a product decision changes; keep validation receipts out of durable docs.
