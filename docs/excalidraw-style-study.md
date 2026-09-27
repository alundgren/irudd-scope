# Scope visual reference

Scope uses the compact Excalidraw-inspired design demonstrated in the [interactive specimen](mockups/appearance-study.html). The [UI decisions](../ux.md) and [repo UX skill](../.agents/skills/ux-guidance/SKILL.md) describe how to extend it.

The compact strip leaves content unobstructed and keeps open artifacts visible. The floating strip remains in the specimen to compare its cost: it covers the top of a document or diagram. It is not a production layout option.

The specimen includes light and dark appearance, twelve tabs, reading, searchable Settings, a workspace menu, focus, and an optional diagram conversation. Its diagram is an illustration and its replies are fixed demonstrations. All content is synthetic; it sends no credentials and calls no model. The desktop uses the real editor and provider.

## Shared values

[Desktop tokens](../apps/desktop/src/renderer/tokens.css) is the single palette and scale definition. Both the specimen and desktop import it. Cool neutrals separate the canvas, strip, and dialogs; violet marks selection and keyboard focus. Selected labels use primary text. Controls use system fonts, leaving handwriting to diagram content.

The shared file defines both appearances, type roles and weights, spacing, control and strip sizes, corner radii, focus rings, and motion. [Desktop CSS](../apps/desktop/src/renderer/style.css) maps these to shadcn roles. Use System, Light, and Dark through Settings. Theme changes preserve diagram content and image pixels; isolated HTML retains its authored colors.

## Resources

The palette derives from Excalidraw's [theme variables](https://github.com/excalidraw/excalidraw/blob/afed9e6e27dd1cd5cc52857a405f7bea5312d813/packages/excalidraw/css/theme.scss). The specimen bundles a Comic Shanns Latin subset for its illustration. Its [third-party notices](mockups/THIRD-PARTY-NOTICES.md) accompany those resources and apply to the shared theme values too.

Scope uses its own app icon and the installed Lucide control icons. Its interface uses system typography. Excalidraw retains its editor controls and drawing fonts; no editor fork or extra interface font is needed.

## Visual examples

The specimen opens directly from disk and loads the shared stylesheet by relative path. Use its Settings to compare appearance and navigation. Its controls use temporary demonstration state and do not write desktop preferences.

- Compact strip at laptop size: [light](mockups/screenshots/compact-light-laptop.png), [dark](mockups/screenshots/compact-dark-laptop.png).
- Reading on a large display: [light](mockups/screenshots/reading-light-large.png), [dark](mockups/screenshots/reading-dark-large.png).
- Floating comparison: [light](mockups/screenshots/floating-light-laptop.png), [dark](mockups/screenshots/floating-dark-laptop.png).
- Overflow: [twelve tabs](mockups/screenshots/twelve-tabs-narrow.png).
- Diagram conversation: [light](mockups/screenshots/diagram-chat-light-laptop.png), [dark](mockups/screenshots/diagram-chat-dark-laptop.png), [narrow](mockups/screenshots/diagram-chat-dark-narrow.png).
- Searchable Settings: [light](mockups/screenshots/settings-search-light-laptop.png), [dark](mockups/screenshots/settings-search-dark-laptop.png), [API key](mockups/screenshots/settings-key-dark-laptop.png).
- Navigation: [workspace menu](mockups/screenshots/workspace-menu-light-laptop.png).

Screenshots illustrate layout and appearance. Use [architecture](architecture.md) for current storage and publication behavior. Check live Electron controls, focus, cancellation, and conflicts in the desktop rather than inferring them from the specimen.
