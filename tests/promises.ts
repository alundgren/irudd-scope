// What Scope promises the people who use it. Every test names at least one
// promise in its own `tags` option, and Vitest rejects unknown names.
// The repository owner decides this list. Agents propose additions, removals,
// or new wording in the pull request description instead of editing it.
export const promises = [
  {
    name: "publish",
    description:
      "An agent can publish every supported artifact kind through the CLI, update it by ID, and see it open in Scope.",
  },
  {
    name: "survives-restart",
    description:
      "Published work, tab state, drafts, and settings come back after a restart, a crash, or a database shrink.",
  },
  {
    name: "no-lost-updates",
    description:
      "A stale, repeated, or competing write never replaces newer content. It fails clearly instead.",
  },
  {
    name: "deletion-is-final",
    description:
      "Work goes away only when someone deletes it or its trash time runs out, and deleted work never comes back by itself.",
  },
  {
    name: "hub-delivers-later",
    description:
      "With the hub, opted-in publications made while the desktop is away arrive later, unchanged and only once.",
  },
  {
    name: "secrets-stay-secret",
    description:
      "Keys, tokens, and pairing secrets never appear in plain files, SQLite, logs, errors, or requests to another endpoint.",
  },
  {
    name: "bad-requests-change-nothing",
    description:
      "Unauthenticated, malformed, or oversized requests are rejected and leave saved data unchanged.",
  },
  {
    name: "pairing-is-explicit",
    description:
      "Only a fresh pairing secret connects a remote or another Scope, and removing or forgetting it cuts access.",
  },
  {
    name: "html-runs-like-a-page",
    description:
      "Published HTML runs like a normal web page: scripts, external resources, and forms work, and links open in the browser.",
  },
  {
    name: "tabs-stay-put",
    description:
      "Tabs keep their order, group, selection, and reading position while someone works, and tabs only talk to their own group.",
  },
  {
    name: "safe-updates",
    description:
      "Installing or updating Scope never leaves a broken app. A failed update keeps the running version, and other apps, commands, and skills stay untouched.",
  },
  {
    name: "memory-syncs",
    description:
      "Memory edits on one machine reach every other machine through GitHub without losing an edit. Conflicts become a pull request.",
  },
  {
    name: "librarian-finds-memory",
    description:
      "The Librarian lets someone search, read, and follow memory notes and the decisions behind them.",
  },
  {
    name: "pr-inbox-keeps-local-work",
    description:
      "The pull request inbox shows GitHub's current state, never a stale approval, and keeps the user's notes, snoozes, drafts, and review baselines.",
  },
  {
    name: "exact-tab-transfer",
    description:
      "Sending a tab copies exactly the reviewed content to the intended receiver only, and the sender keeps its copy.",
  },
  {
    name: "speech-generation",
    description:
      "Speech generation produces playable audio and never pays the provider twice for one request.",
  },
  {
    name: "retro-records-the-review",
    description:
      "A retrospective delivers each request to the agent and saves exactly what was reviewed and decided, only when it finishes.",
  },
  {
    name: "prompts-keep-originals",
    description: "The prompt library keeps original text and images, and exports only the library.",
  },
  {
    name: "folders-stay-inside",
    description:
      "An agent's shared folder shows live files from its machine, never reads or writes outside that folder, and Scope keeps no copy of its files.",
  },
  {
    name: "harnesses-look-dont-touch",
    description:
      "Harnesses reports agent tools on each machine without changing them or revealing secrets, and guests share them only after opting in.",
  },
] as const;

export type PromiseName = (typeof promises)[number]["name"];
