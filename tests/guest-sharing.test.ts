import { test } from "vite-plus/test";
import { guestShutdownChecks } from "./guest-shutdown-fixture.ts";
import { guestPlanChecks } from "./guest-plan-checks.ts";
import { guestMutationChecks } from "./guest-mutation-checks.ts";
import { guestConnectionChecks } from "./guest-connection-fixture.ts";

test(
  "Other Scopes pairs explicitly, protects guest catalogs and owner reads, reconnects and forgets",
  {
    tags: [
      "pairing-is-explicit",
      "secrets-stay-secret",
      "survives-restart",
      "publish",
      "no-lost-updates",
      "deletion-is-final",
    ],
    timeout: 600_000,
  },
  async () => {
    await guestShutdownChecks();
    await guestConnectionChecks();
    await guestMutationChecks();
    await guestPlanChecks();
  },
);
