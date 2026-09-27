# Visual prototype brief for irudd-scope

Create interactive visual prototypes for the main desktop screen and tab navigation of `irudd-scope`. This is a design exploration. A separate implementation is building the hub, CLI, and Electron integration. Use synthetic local data and mock actions. Do not connect a backend, use real keys, call models, install hooks, or launch agents.

## Product

Coding agents leave artifacts for one human to inspect. Codex and Claude run on a Mac and Ubuntu VM. Their CLI publishes to a persistent VM hub. The human opens Scope on the Mac to inspect, interact with, download, or edit an artifact. Scope does not run coding sessions and has no agent chat.

The central item is an artifact with a stable identity. Tabs are views of artifacts. Artifacts can update in place, and closing a tab must not delete the artifact. Supported content includes Markdown or text, an image, a static HTML preview, a downloadable file, and an editable Excalidraw diagram.

Session observation is optional and less prominent. Leave room for manually adding a session tab and finding a session-analysis tool through search. Future Codex and Claude adapters observe tool-call sizes. No hooks or sessions are required for ordinary use.

## Main design problem

Give the selected content as much space as possible. Explore two or three meaningfully different ways to navigate artifacts and optional tool tabs. Compare behavior and space use, not just colors. Do not build a dashboard of cards or reserve a wide permanent sidebar.

Include a focus mode where content uses the whole window except a tiny visible way back. Support Escape. Exiting must preserve the active artifact and its scroll or zoom. Keep the exit usable without covering important diagram controls.

The app is Mac-first. Browser prototypes on Linux are fine. Work with React, TypeScript, Vite+ `1.0.0-rc.1`, shadcn/ui and Tailwind 4 where practical. Use current stable or RC dependencies, not beta/nightly builds. The house visual style does not apply. Choose a visual language for this product and record actual color, typography, spacing, and focus tokens.

## Content and interactions to demonstrate

Use realistic titles and data, such as `Architecture`, `Checkout layout`, `Retry-loop finding`, `Benchmark results`, `build.zip`, and `Background processing`. Provenance may include Claude or Codex, a host, repository, branch, and age. Show it on demand without permanently shrinking the artifact. Missing provenance is valid.

- Open, switch, close, and reopen an artifact. Closing a view and deleting content are different actions.
- Search artifacts and tools. Include optional session inspection and session analysis in tool results, without making them a default landing page.
- Handle twelve or more tabs, long titles, and a narrow desktop window. Include a sensible keyboard path.
- Receive a new artifact while reading another. Indicate the arrival without changing selection.
- Update an existing artifact in place. Show a small change indication. Show how an edited diagram handles an incoming update without silently discarding work.
- Enter and exit focus mode, preserving position.
- Show an empty workspace with a useful publication example and no required hook setup.
- Show the hub offline and reconnecting while existing content remains inspectable.
- Show an image, Markdown, HTML preview, file download, and diagram at useful sizes. Static HTML is isolated and cannot access app APIs. Do not make arbitrary web-app hosting part of the concept.

## Settings

Include a settings view with a provider selector. The only enabled provider is OpenRouter. Its model selector initially contains only Gemini 3.8 Flash, with API ID `google/gemini-3.8-flash` available in a secondary detail if useful.

Include a masked key-entry field and saved, replace, remove, and failure states. The saved key is protected using macOS Keychain through Electron secure storage. Display only saved status, never reveal a stored key. Use fake data in prototypes. Model calls run on the Mac only while Scope is open, which is intended behavior.

Leave conceptual room for local Codex and Claude CLI providers later, without cluttering the first version with disabled settings or suggesting those integrations work already. Hub connection settings are separate from model credentials.

## Deliverables

Provide runnable interactive prototypes, a small navigation between the alternatives, screenshots at laptop and large-window sizes, and a short recommendation explaining the space and interaction tradeoffs. Document the chosen tokens and important keyboard behavior. Include a test checklist for the states above. Keep mock data clearly separate from app integration.

Do not add a backend, database, authentication system, chat, orchestration, model abstraction framework, or final production Electron packaging. Do not publish a public preview. A private tailnet preview can be set up when requested.
