# Desktop visual design

The live desktop is the reference for Scope's interface. Read [UI decisions](../ux.md)
for product behavior and the reasons Scope uses its Excalidraw-inspired palette.
Run it with the [development commands](development.md) and synthetic artifacts.

## Tokens and components

[tokens.css](../apps/desktop/src/renderer/tokens.css) owns the shared palette,
typography, spacing, radii, control dimensions, focus, and motion for both
appearances. Do not copy values into palette tables or individual components.
[style.css](../apps/desktop/src/renderer/style.css) maps those values to Tailwind
and shadcn roles and owns desktop layout. Tailwind scans the complete desktop
source directory, including workspace and plugin views. Component-specific dimensions can
stay with their layout; repeated visual values belong in the tokens.

| Tokens                                                                           | Use                                                                               |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `--scope-canvas`, `--scope-panel`, `--scope-strip`                               | Workspace, dialogs, and tab strip.                                                |
| `--scope-text`, `--scope-muted`                                                  | Primary content and secondary details.                                            |
| `--scope-accent`, `--scope-accent-hover`, `--scope-on-accent`                    | Primary actions and their labels; accent also marks selection and keyboard focus. |
| `--scope-selected`                                                               | Selected tabs and contextual choices, with primary text.                          |
| `--scope-line`, `--scope-outline`                                                | Decorative dividers and recognizable input boundaries.                            |
| `--scope-danger`                                                                 | Errors and destructive actions, accompanied by words.                             |
| `--scope-overlay`, `--scope-shadow`                                              | Modal backdrop and elevated menus or dialogs.                                     |
| `--scope-font-*`, `--scope-text-*`, `--scope-leading-*`, `--scope-weight-*`      | System UI, comparable identifiers, reading text, and titles.                      |
| `--scope-space-*`, `--scope-radius-*`, `--scope-control`, `--scope-strip-height` | Shared spacing and control dimensions.                                            |
| `--scope-focus-*`, `--scope-motion`                                              | Visible keyboard focus and transitions, with reduced-motion support.              |

Reuse the local [controls](../apps/desktop/src/renderer/components/ui) for
buttons, inputs, textareas, the appearance select, and dialogs. Lucide supplies
Scope's control icons. Do not make fixed values look editable. Disabled
actions remain distinct from working controls.

Keep enabled text at least 4.5:1 against its actual background, including
hover and selected states. Input boundaries and focus indicators need 3:1
against adjoining backgrounds. Test the rendered control, including opacity
and compositing. Tint alone does not identify the selected tab. Keep the
solid marker and keyboard focus visible.

Excalidraw control labels use Scope's primary text token. Editor hints and
keyboard shortcuts use its secondary text token at full opacity. Keep these
overrides in `style.css` so both the editor and proposal preview follow the
shared contrast choices without changing drawing colors.

Use the token weights and spacing to establish hierarchy before adding larger
headings. Monospace is for code, paths, and identifiers. Ordinary artifact
content needs no card or shadow. Keep authored HTML colors, image pixels, and
Excalidraw drawing fonts separate from Scope's controls.

## Checking a change

Inspect the actual Electron flow in light and dark appearance. Use a laptop
window and a narrow window, long artifact titles, overflowing tabs, and the
affected loading, empty, error, and conflict states. Check keyboard navigation,
visible focus, and reduced motion when changing controls or animations.

For workspace or editor changes, check position and drafts after focus,
Settings, tab switches, application restart, and appearance changes. Closing a
temporary tab must remove it from active search while preserving content and
drafts in Trashcan. Closing a permanent tab hides it from the strip, moves it to the end of the
drawer, and preserves its mounted content. Check that it stays hidden when the
window expands and after restart. Built-in tabs show a noninteractive lock,
never a permanence toggle, and Trashcan actions close them without deleting data. Verify Restore and the inline slider-plus-click empty action.
Exercise generation and cancellation with synthetic responses. Keep screenshots
and measurements in review evidence so this document remains current guidance.

The shared theme values derive from Excalidraw. Attribution is in the desktop's
[third-party notices](../apps/desktop/resources/THIRD-PARTY-NOTICES.md).
