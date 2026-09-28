import type { LintException } from "./lint-report.ts";

export const lintExceptions: readonly LintException[] = [
  {
    file: "apps/desktop/src/desktop-store.ts",
    at: "async load(): Promise<void> {",
    limits: { complexity: 11 },
    reason:
      "Database opening, legacy preference migration, and disposal on failure share the same runtime. Keep their order visible so failed imports leave the old preferences recoverable.",
  },
  {
    file: "apps/desktop/src/desktop-store.ts",
    at: "return this.enqueue(async () => {\nconst input = decodeSettingsUpdate(value);",
    limits: { complexity: 14 },
    reason:
      "This queued settings write validates key replacement or removal, writes Keychain before preferences, and clears cached key status when generation is disabled. These branches belong to one serialized update.",
  },
  {
    file: "apps/desktop/src/installation-files.ts",
    at: "export async function activateBuild(root: string, build: string, application?: string) {",
    limits: { complexity: 24 },
    reason:
      "Bundle replacement tracks the previous app and changed links for rollback. Keep validation, installation, rollback, and conditional cleanup together so failures never delete the only recoverable app.",
  },
  {
    file: "apps/desktop/src/ipc.ts",
    at: "export function registerDesktopIpc({",
    limits: { "max-lines-per-function": 156 },
    reason:
      "Named desktop operations share caller validation, service instances, and plugin cancellation. Keep the registration list and its cleanup together so every renderer operation uses the same caller checks.",
  },
  {
    file: "apps/desktop/src/library/server.ts",
    at: "async function handle(request: IncomingMessage, response: ServerResponse) {",
    limits: { complexity: 17 },
    reason:
      "Dispatch checks the supported method, path, query, and artifact ID combinations. Authentication, uploads, maintenance execution, and event stream lifetime have separate helpers; the remaining branches describe the HTTP routes.",
  },
  {
    file: "apps/desktop/src/library/server.ts",
    at: "async function handleArtifact(",
    limits: { complexity: 14 },
    reason:
      "Four HTTP methods have distinct suffix and query restrictions, status codes, and storage operations. Keep the method dispatch explicit; content streaming has its own handler.",
  },
  {
    file: "apps/desktop/src/library/server.ts",
    at: "export async function startArtifactServer(options: {",
    limits: { "max-lines-per-function": 223 },
    reason:
      "The listener owns its store, active uploads, event streams, pending requests, and shutdown. Local handlers share those resources without exposing mutable server state.",
  },
  {
    file: "apps/desktop/src/library/store.ts",
    at: "Effect.gen(function* () {\nconst imported = yield* sql`SELECT 1 FROM lifecycle WHERE name = 'workspace_imported'`;",
    limits: { complexity: 15 },
    reason:
      "The legacy import must transfer tab ownership, content references, drafts, and deletion revision limits in one transaction. Keeping the conditional writes together makes rollback and the completion marker auditable.",
  },
  {
    file: "apps/desktop/src/main.ts",
    at: "async function main() {",
    limits: { complexity: 15, "max-lines-per-function": 183 },
    reason:
      "Electron startup registers services and their matching shutdown callbacks around the same window and databases. Keep resource initialization and cleanup order together instead of passing a mutable service collection between modules.",
  },
  {
    file: "apps/desktop/src/plugins/diagram/canvas.ts",
    at: "export function renderScene(",
    limits: { "max-lines-per-function": 152 },
    reason:
      "Rendering measures native text before placing group borders and connections. The ordered conversion and its element data stay together so labels, bounds, and stable IDs remain consistent.",
  },
  {
    file: "apps/desktop/src/plugins/diagram/chat.tsx",
    at: "export function DiagramChat({",
    limits: { complexity: 11 },
    reason:
      "One chat panel renders empty history, generation progress, opt-in recovery, and send or cancel controls. Its short conditional JSX keeps each action beside the state that enables it.",
  },
  {
    file: "apps/desktop/src/plugins/diagram/openrouter.ts",
    at: "generateDiagram: async (input, signal) => {",
    limits: { complexity: 13 },
    reason:
      "A single provider request translates transport failures, validates bounded model output and operations, and reads optional usage. Keeping this sequence together preserves the rule that invalid output never reaches the canvas.",
  },
  {
    file: "apps/desktop/src/plugins/diagram/scene.ts",
    at: "export function applyOperations(",
    limits: { complexity: 24 },
    reason:
      "The switch implements the finite diagram operation contract on a cloned scene, then validates the complete batch. Separate handlers would share mutable scene state and obscure atomic batch validation.",
  },
  {
    file: "apps/desktop/src/plugins/diagram/view.tsx",
    at: "export function DiagramView({",
    limits: { "max-lines-per-function": 380 },
    reason:
      "The editor owns the canvas API, revision and dirty refs, draft autosave, and active generation request. Those callbacks share state to preserve edits during publication conflicts, cancellation, and restart.",
  },
  {
    file: "apps/desktop/src/plugins/diagram/view.tsx",
    at: "useEffect(() => {\nif (!api) return;",
    limits: { complexity: 12 },
    reason:
      "Initial canvas loading chooses a compatible saved draft and restores its viewport. Its cleanup cancels the request owned by this mounted editor; the fallback checks are one restoration decision.",
  },
  {
    file: "apps/desktop/src/renderer/agent-tool-settings.tsx",
    at: "export function AgentToolSettings({",
    limits: { complexity: 13 },
    reason:
      "The CLI and skill each expose installed, pending, and removable states in one settings section. Conditional labels and actions remain adjacent to their installation status.",
  },
  {
    file: "apps/desktop/src/renderer/installation-settings.tsx",
    at: "export function InstallationSettings({ query }: { query: string }) {",
    limits: { complexity: 20 },
    reason:
      "This component coordinates update, signing, and tool busy states while composing their separate settings components. Keeping the availability checks together prevents conflicting installation actions.",
  },
  {
    file: "apps/desktop/src/renderer/installation-settings.tsx",
    at: "function BuildProgress({",
    limits: { complexity: 23 },
    reason:
      "Update and signing progress share the same build phases. The conditional JSX directly expresses which retry, cancel, and restart actions are available for each phase.",
  },
  {
    file: "apps/desktop/src/renderer/model-settings.tsx",
    at: "export function ModelSettings({",
    limits: { complexity: 26, "max-lines-per-function": 160 },
    reason:
      "The opt-in switch, lazy key-status request, replacement form, and key-access retry form one settings task. Keep key access dependent on both visibility and opt-in, with status and recovery beside the form.",
  },
  {
    file: "apps/desktop/src/renderer/signing-settings.tsx",
    at: "export function SigningSettings({",
    limits: { complexity: 22, "max-lines-per-function": 172 },
    reason:
      "Certificate lookup, current identity, instructions, and replacement controls form one settings task. The branches expose missing certificates and pending changes while keeping unavailable actions disabled.",
  },
  {
    file: "apps/desktop/src/workspace/contract.ts",
    at: "export function importWorkspace(value: unknown): Workspace {",
    limits: { complexity: 13 },
    reason:
      "Supported workspace versions have distinct validation and selection conversion rules. Keep the short migration sequence together so legacy tab IDs and invalid selections are handled before decoding the current contract.",
  },
  {
    file: "apps/desktop/src/workspace/search.tsx",
    at: "export function WorkspaceSearch({",
    limits: { complexity: 18, "max-lines-per-function": 160 },
    reason:
      "Search composes workspace actions, current-tab actions, settings matches, and artifacts into one keyboard-navigable result list. The conditional sections preserve their distinct labels and shared query.",
  },
  {
    file: "apps/desktop/src/workspace/search.tsx",
    at: "function navigateResults(event: ReactKeyboardEvent) {",
    limits: { complexity: 16 },
    reason:
      "This short keyboard handler covers entry from the search input, wrapping in both directions, and Enter activation only for a nonempty query. Keeping those focus rules together avoids splitting one navigation decision.",
  },
  {
    file: "apps/desktop/src/workspace/use-workspace.ts",
    at: "const task = opening.current.then(async () => {",
    limits: { complexity: 14 },
    reason:
      "The serialized open loop distinguishes handled requests from opened tabs and checks close notifications both before and after IPC. Keeping those guards together prevents delayed opens from restoring closed tabs.",
  },
  {
    file: "apps/desktop/src/workspace/use-workspace.ts",
    at: "export function useWorkspace(onError: (message: string) => void) {",
    limits: { "max-lines-per-function": 191 },
    reason:
      "Tab mutations share a current-state ref, an opening queue, and one autosave lifecycle. Keep restoration, serialized opens, deletion handling, and state updates in the same hook to avoid stale membership writes.",
  },
  {
    file: "apps/desktop/src/workspace/workspace.tsx",
    limits: { "max-lines": 565 },
    reason:
      "This file composes one workspace window from existing tab, search, and settings components. Its local callbacks coordinate the same selection, arrival queue, and dialog state; keep that window ownership in one place.",
  },
  {
    file: "apps/desktop/src/workspace/workspace.tsx",
    at: "const keyboard = (event: KeyboardEvent) => {",
    limits: { complexity: 23 },
    reason:
      "Shortcut precedence must honor prevented events, open dialogs, the tab picker, and focus mode before closing tabs. Keeping the shortcuts in one ordered handler makes that priority visible.",
  },
  {
    file: "apps/desktop/src/workspace/workspace.tsx",
    at: "export function App({ initialSettings }: { initialSettings: SettingsView | undefined }) {",
    limits: { complexity: 51, "max-lines-per-function": 540 },
    reason:
      "One window owns selection, publication arrivals, focus, and dialog coordination. TabBar, TabHost, search, and settings already own their views; keep the connecting callbacks with their shared state so navigation preserves mounted tabs.",
  },
  {
    file: "apps/desktop/src/workspace/tab-bar.tsx",
    at: "export function TabBar({",
    limits: { "max-lines-per-function": 165 },
    reason:
      "The strip measures available space, keeps the selected tab visible, and composes the picker and tab controls. These decisions share the same tab order and focus references; extracting the short layout calculation would add another interface without a separate responsibility.",
  },
  {
    file: "apps/desktop/src/workspace/tab-overflow.tsx",
    at: "export function TabOverflow({",
    limits: { "max-lines-per-function": 162 },
    reason:
      "The picker shares its query, chosen tab, and focus targets between the trigger, search field, and results. Keeping this small popup together makes dismissal and focus restoration visible beside selection.",
  },
  {
    file: "apps/desktop/src/workspace/tab-overflow.tsx",
    at: "function navigate(event: KeyboardEvent) {",
    limits: { complexity: 13 },
    reason:
      "The keyboard handler distinguishes entry from the search field, wrapping through results in either direction, and Enter activation. These short branches implement one focus movement and exclude unrelated controls.",
  },
  {
    file: "tests/tab-overflow.test.ts",
    at: 'test("150 tabs use a searchable overflow picker, move to the right, and survive restart", async () => {',
    limits: { complexity: 12 },
    reason:
      "One Electron scenario checks publication, keyboard selection, both appearances, restart, and deletion against the same 150-tab workspace. Conditional fixture titles and optional screenshot capture belong with the complete user flow.",
  },
  {
    file: "apps/hub/src/paired-server.ts",
    at: "async function handleHub(",
    limits: { complexity: 17 },
    reason:
      "The five local management routes have explicit authentication, method, and query checks. Keep the small route dispatch together with its status responses and pairing errors.",
  },
  {
    file: "apps/hub/src/paired-server.ts",
    at: "async function handleRelay(",
    limits: { complexity: 23 },
    reason:
      "Relay routes coordinate event connection ownership and single-use body or response transfers. The guards and pipeline completion paths must agree on the same pending request and cancellation state.",
  },
  {
    file: "apps/hub/src/paired-server.ts",
    at: "export async function startPairedHub(state: HubState, port = state.configuration().port) {",
    limits: { "max-lines-per-function": 296 },
    reason:
      "The paired listener owns a desktop connection and bounded pending transfers. Local handlers share disconnect, cancellation, timers, and shutdown; moving them out would require exposing that mutable request state.",
  },
  {
    file: "apps/hub/src/paired-server.ts",
    at: "function forwardArtifact(request: IncomingMessage, response: ServerResponse, token: string) {",
    limits: { complexity: 11 },
    reason:
      "The short admission sequence rejects unauthenticated, invalid, offline, oversized, and excess requests before registering cancellation and timeout handlers. Each branch protects the same forwarded request.",
  },
  {
    file: "apps/hub/src/server.ts",
    at: "(request, response) => {",
    limits: { complexity: 15 },
    reason:
      "Direct forwarding checks credentials and allowed routes before opening an upstream request. Its response, timeout, and disconnect handlers share that request and must close it together.",
  },
  {
    file: "packages/cli/src/main.ts",
    at: "async function main() {",
    limits: { complexity: 19 },
    reason:
      "The finite command dispatch keeps each public command visible and shares one deadline across publication reads and writes. Its timeout message depends on whether publication may already have committed.",
  },
  {
    file: "packages/cli/src/main.ts",
    at: "async function preparePublication(",
    limits: { complexity: 12 },
    reason:
      "Creation and update share parallel content, provenance, and revision reads. Optional title and ID fallbacks are part of constructing one publication, rather than separate processing stages.",
  },
  {
    file: "packages/cli/src/main.ts",
    at: "function validateArtifactCommand(",
    limits: { complexity: 12 },
    reason:
      "Argument requirements differ across the fixed public commands. These short guards report command-specific errors before reading credentials or connecting.",
  },
  {
    file: "packages/cli/src/setup.ts",
    at: "export async function manageHub(",
    limits: { complexity: 12 },
    reason:
      "The fixed management commands have distinct credential and service requirements. Explicit dispatch keeps status and maintenance independent of local service-file checks.",
  },
  {
    file: "packages/cli/src/setup.ts",
    at: "export async function setup(options: SetupOptions) {",
    limits: { complexity: 14 },
    reason:
      "Remote setup validates ownership before confirmation, then installs the service, skill, and Serve route in order. Conditional reuse preserves existing installations and pairing.",
  },
  {
    file: "packages/cli/src/setup.ts",
    at: "function selectHttpsPort(",
    limits: { complexity: 11 },
    reason:
      "The HTTPS port prefers explicit or installed configuration, otherwise scans unused Serve ports. The short fallback and bounded scan describe one port selection policy.",
  },
  {
    file: "packages/protocol/src/remote.ts",
    at: "export function artifactRequest(method: string, path: string): boolean {",
    limits: { complexity: 18 },
    reason:
      "This compact allowlist validates method, path, suffix, and query combinations before forwarding. Explicit predicates make the accepted public routes inspectable without a second routing abstraction.",
  },
  {
    file: "packages/sqlite/src/maintenance.ts",
    at: "private async perform(manual: boolean, timeoutMs: number): Promise<DatabaseShrink> {",
    limits: { complexity: 18 },
    reason:
      "Maintenance holds one write barrier through cleanup, disk checks, vacuum, and receipt persistence. Keep completion and failure handling with the final barrier release so a failed receipt cannot leave database writers blocked.",
  },
  {
    file: "tests/artifacts.test.ts",
    limits: { "max-lines": 502 },
    reason:
      "These publication tests share real CLI, HTTP server, and isolated library fixtures. The file groups successful publication with authentication, forwarding, deadlines, and provenance failures at the same public entry points.",
  },
  {
    file: "tests/desktop.test.ts",
    at: 'test("the diagram tool creates an editable Excalidraw artifact in desktop storage", async () => {',
    limits: { "max-lines-per-function": 311 },
    reason:
      "This complete editor journey carries one artifact and its draft through generation, editing, cancellation, failed writes, conflicts, restart, copy, and permanent close. Splitting it would lose the continuity the assertions verify.",
  },
  {
    file: "tests/installation.test.ts",
    limits: { "max-lines": 635 },
    reason:
      "Installer, activation, update, and signing tests share synthetic app bundles and process fixtures. Keeping those installation lifecycle cases together avoids duplicating fixture setup across files.",
  },
  {
    file: "tests/lifecycle-pressure.test.ts",
    at: "async () => {\nconst f = await desktopFixture();",
    limits: { complexity: 12, "max-lines-per-function": 273 },
    reason:
      "The pressure journey carries local and relayed publications through overflow, restart, queued-tab draining, repeated updates, deletion, and shrinking. The same session and baseline are needed to verify eventual reclamation and preserve diagnostic samples on failure.",
  },
  {
    file: "tests/lifecycle.test.ts",
    limits: { "max-lines": 561 },
    reason:
      "The tab-owned storage tests share database inspection and child-process helpers across deletion races, staging expiry, import crashes, and cache recovery. File length alone does not justify splitting that fixture ownership.",
  },
  {
    file: "tests/remote-installation.test.ts",
    at: 'test("the standalone installer and CLI setup preserve existing Serve routes and can revoke and remove the hub", async () => {',
    limits: { "max-lines-per-function": 160 },
    reason:
      "One standalone installation is set up, retried, paired, revoked, and removed while preserving an unrelated Serve route. The synthetic service processes and cleanup belong to that complete journey.",
  },
  {
    file: "tests/tab-types.test.ts",
    at: 'test("the built CLI publishes every tab view through appearance, focus, restart, trash, and explicit deletion", async () => {',
    limits: { complexity: 15 },
    reason:
      "The viewer matrix covers all artifact kinds in both appearances, focus mode, restart, and permanent close. Branches select kind-specific observable checks while reusing the real desktop session.",
  },
  {
    file: "tests/workspace.test.ts",
    at: 'test("the compact workspace preserves reading position, supports overflowing tabs, and searches settings", async () => {',
    limits: { "max-lines-per-function": 173 },
    reason:
      "The journey retains the same mounted reading pane through overflowing tabs, focus, settings search, background updates, deletion, and restart. Shared session state is the behavior under test.",
  },
  {
    file: "tools/benchmark.ts",
    limits: { "max-lines": 609 },
    reason:
      "This standalone measurement tool keeps synthetic content, process sampling, CLI timings, and report definitions beside its ordered desktop experiment. It has no application callers requiring separate modules.",
  },
  {
    file: "tools/benchmark.ts",
    at: "async function main() {",
    limits: { complexity: 24, "max-lines-per-function": 286 },
    reason:
      "The benchmark intentionally measures an ordered progression from empty startup through publication, large content, many tabs, and restart. One resource owner writes partial results on failure and closes the active Electron process.",
  },
];
