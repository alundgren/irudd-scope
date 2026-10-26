import { test } from "vite-plus/test";
import { guestShutdownChecks } from "./guest-shutdown-fixture.ts";
import { guestPlanChecks } from "./guest-plan-checks.ts";
import { guestMutationChecks } from "./guest-mutation-checks.ts";
import { guestConnectionChecks } from "./guest-connection-fixture.ts";

// Each journey launches its own Scopes, so `-t` can run one alone while debugging.
test(
  "Guest sharing quits cleanly while an invitation is starting or stalled",
  { tags: ["survives-restart"], timeout: 120_000 },
  guestShutdownChecks,
);

test(
  "Other Scopes pairs explicitly, protects guest catalogs and owner reads, reconnects and forgets",
  {
    tags: ["pairing-is-explicit", "secrets-stay-secret", "deletion-is-final"],
    timeout: 300_000,
  },
  guestConnectionChecks,
);

test(
  "Guest edits keep newer content, recover drafts, and survive restarts",
  { tags: ["no-lost-updates", "publish", "survives-restart"], timeout: 300_000 },
  guestMutationChecks,
);

test(
  "Guest plans keep owner secrets private, reject stale bases, and survive restarts",
  {
    tags: ["pairing-is-explicit", "secrets-stay-secret", "no-lost-updates", "survives-restart"],
    timeout: 600_000,
  },
  guestPlanChecks,
);
