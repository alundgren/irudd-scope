---
name: ux-guidance
description: Implement or review Scope desktop UI, interactions, and visible wording using its shared tokens and recorded UX decisions. Use for UI work in this repository.
---

# Scope UX guidance

Read [UI decisions](../../../ux.md) before changing a flow and
[visual design](../../../docs/visual-design.md) for color, typography, and
component work. Inspect the affected live desktop components. Scope's cool
palette, system fonts, and native appearance support are intentional choices;
house UX principles still apply. These relative paths start at this directory.

## Keep the artifact central

Reserve the compact strip for workspace navigation. Keep artifact titles in
tabs. Let diagrams, images, and HTML use the window; constrain reading width
for prose. Put secondary actions in the search panel or artifact controls.
Keep workspace controls, current-tab actions, and artifact results visually
distinct. Omit unavailable panel actions.

Keep the selected tab visible when titles overflow. New publications open in
tabs, selecting the first arrival only when no artifact is open. Later arrivals
and background updates keep the current selection and indicate unread content.
Startup restores saved open tabs and opens queued publications. The left drawer opens on Active with a count, search, and retention filters.
Trashcan is a subdued footer link without a count. Selecting a result moves it
to the right end of the strip. Bookmark toggles permanence without reordering.
Closing moves a tab to Trashcan, preserving content and drafts. Restore returns
it to the right end. Temporary tabs expire after a day outside the visible strip;
trash expires after seven days. Emptying requires an inline slider and click. Quitting Scope preserves tabs left open. Focus keeps the artifact mounted, preserves position,
hides chat, and exposes a small exit clear of editor controls. Escape dismisses
the current dialog or editor interaction before leaving focus.

## Use shared controls and tokens

[tokens.css](../../../apps/desktop/src/renderer/tokens.css) owns visual values.
[style.css](../../../apps/desktop/src/renderer/style.css) maps roles and layout.
Reuse [UI controls](../../../apps/desktop/src/renderer/components/ui) and Lucide
icons. Check text and focus contrast in normal, hover, selected, and disabled
states. Theme changes must not rewrite artifact content.

Search finds artifacts, tools, and specific settings. Preserve Settings search
focus and recovery from empty results. Keep provider, model, and key together.
Fixed provider and model values are text. Saved keys expose presence and
replacement or removal, never the secret itself.

## Preserve editing work

Diagram conversation opens on request beside the canvas or over it in a narrow
window. Keep conversation, draft, and view position across closing the panel,
focus, navigation, and restart with the tab still open. Persist through named desktop SQLite operations.
Canvas edits save automatically to the artifact after the working draft is stored.
Conversation and viewport updates save only the draft. Enter sends,
Shift+Enter adds a line, and pending requests offer Cancel.

Retain local edits when an artifact revision arrives or the canvas changes
during generation. Offer Use incoming version or Keep both.
Cancellation, provider failures, and failed draft writes must leave a useful
next action. Do not add renderer persistence or generic execution APIs.

## Verify the affected flow

Use the running desktop with synthetic artifacts and provider responses.
Read [development](../../../docs/development.md) for launch and tests. Include
both appearances, laptop and narrow widths, long titles, keyboard focus, and
the relevant empty, pending, error, and conflict states. Check position and
drafts across affected navigation paths. For visual changes, inspect desktop
screenshots and keep the evidence outside tracked guidance.

Run `vp run ready` before completion. Update `ux.md` when a product decision
changes; keep token values in their CSS owner and validation receipts out of docs.
