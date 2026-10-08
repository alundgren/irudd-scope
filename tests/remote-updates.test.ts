import { expect, test } from "vite-plus/test";
import {
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { remoteUpdateFixture } from "./remote-update-fixture.ts";
import { createServer } from "node:http";
import { once } from "node:events";
import { synchronizeRemote } from "../apps/desktop/src/remote-updates.ts";
import type { HubUpdateStatus } from "@irudd-scope/protocol/remote";

test("an older hub explains its manual upgrade without sending an update request", async () => {
  const methods: string[] = [];
  const server = createServer((request, response) => {
    methods.push(request.method!);
    response.writeHead(404).end("Endpoint not found.");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const statuses: HubUpdateStatus[] = [];
  try {
    await synchronizeRemote(
      `http://127.0.0.1:${port}`,
      "synthetic-token",
      "a".repeat(40),
      new AbortController().signal,
      (status) => statuses.push(status),
    );
    expect(methods).toEqual(["GET"]);
    expect(statuses).toHaveLength(1);
    expect(statuses[0].supported).toBe(false);
    expect(statuses[0].message).toContain("irudd-scope setup once");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test.skipIf(process.platform !== "linux")(
  "the running Mac updates remote tools together, catches up after reconnect, and retries without losing pairing",
  async () => {
    const f = await remoteUpdateFixture();
    try {
      const original = await readlink(join(f.root, "current"));
      const pairedMac = f.state.status().pairedMac;
      const next = await f.commitSkill("Updated publishing skill");
      expect(f.launches()).toBe(0);
      await writeFile(join(f.directory, "unmanaged-service"), "0");
      // The hub may still be closing the old relay; the Mac retries after three seconds.
      await f.openMac(next);
      await expect
        .poll(() => f.status()?.update?.message, { timeout: 15_000 })
        .toContain("managed hub service");
      expect(f.launches()).toBe(0);
      await rm(join(f.directory, "unmanaged-service"));
      await f.openMac(undefined);
      await expect.poll(() => f.status()?.connection, { timeout: 15_000 }).toBe("connected");
      expect(f.launches()).toBe(0);
      await f.openMac(f.initialCommit);
      await expect
        .poll(() => f.status()?.update?.currentCommit, { timeout: 15_000 })
        .toBe(f.initialCommit);
      expect(f.launches()).toBe(0);
      await f.enable(false);
      await f.openMac(next);
      expect(f.status()?.connection).toBe("disconnected");
      expect(f.launches()).toBe(0);
      await writeFile(join(f.directory, "hold-build"), "wait");
      await f.enable(true);
      await expect.poll(() => f.status()?.update?.phase, { timeout: 15_000 }).toBe("building");
      await f.cli("text", "Publication while remote tools build", "--id", "during-update");
      await Promise.all(
        Array.from({ length: 3 }, () =>
          fetch(`${f.endpoint}/v1/relay/update`, {
            method: "POST",
            headers: { Authorization: `Bearer ${f.token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ commit: next }),
          }).then(async (response) => {
            expect(response.status).toBe(202);
            expect((await response.json()).phase).toBe("building");
          }),
        ),
      );
      expect(f.launches()).toBe(1);
      await rm(join(f.directory, "hold-build"));
      await expect.poll(() => f.status()?.update?.currentCommit, { timeout: 30_000 }).toBe(next);
      await expect.poll(() => f.state.updateStatus()?.phase).toBe("idle");
      expect(f.launches()).toBe(1);
      expect(await readlink(join(f.root, "previous"))).toBe(original);
      expect(
        await readFile(join(f.directory, "user/.claude/skills/irudd-scope/SKILL.md"), "utf8"),
      ).toBe("Updated publishing skill");
      expect(JSON.parse((await f.cli("hub", "status")).stdout).commit).toBe(next);
      expect(f.state.status().pairedMac).toBe(pairedMac);
      await f.cli("text", "Publication after automatic update", "--id", "after-update");

      const later = await f.commitSkill("Publishing skill after retry");
      await writeFile(join(f.directory, "fail-build"), "fail");
      await f.openMac(later);
      await expect.poll(() => f.status()?.update?.phase, { timeout: 30_000 }).toBe("error");
      expect(f.status()?.update?.output).toContain("Synthetic build failure");
      expect(JSON.parse((await f.cli("hub", "status")).stdout).commit).toBe(next);
      await f.cli("text", "Publication after failed update", "--id", "failed-update");
      const attempts = f.launches();
      await f.openMac(later);
      await expect
        .poll(() => f.status(), { timeout: 15_000 })
        .toMatchObject({
          connection: "connected",
          update: { phase: "error", targetCommit: later },
        });
      expect(f.launches()).toBe(attempts);
      await rm(join(f.directory, "fail-build"));
      await f.retry();
      await expect.poll(() => f.status()?.update?.currentCommit, { timeout: 30_000 }).toBe(later);
      await expect.poll(() => f.state.updateStatus()?.phase).toBe("idle");
      expect(f.launches()).toBe(attempts + 1);
      const active = await readlink(join(f.root, "current"));
      const previous = await readlink(join(f.root, "previous"));
      expect((await readdir(join(f.root, "builds"))).sort()).toEqual(
        [active, previous].map((build) => build.slice(build.lastIndexOf("/") + 1)).sort(),
      );
      expect(f.state.status().pairedMac).toBe(pairedMac);
      await f.openMac(next);
      await expect.poll(() => f.status()?.update?.phase, { timeout: 15_000 }).toBe("error");
      expect(f.status()?.update?.message).toContain("Update the Mac first");
      expect(JSON.parse((await f.cli("hub", "status")).stdout).commit).toBe(later);
    } catch (error) {
      console.error(f.diagnostics());
      throw error;
    } finally {
      await f.close();
    }
  },
  120_000,
);

test.skipIf(process.platform !== "linux")(
  "an updated CLI cannot hide a copied agent skill, and retry fixes it without rebuilding",
  async () => {
    const f = await remoteUpdateFixture();
    try {
      const agentSkill = join(f.directory, "user/.agents/skills/irudd-scope");
      await rm(agentSkill);
      await mkdir(agentSkill);
      await writeFile(join(agentSkill, "SKILL.md"), "Old independent skill");
      const next = await f.commitSkill("Skill with plan support");
      await f.openMac(next);
      await expect.poll(() => f.status()?.update?.currentCommit, { timeout: 30_000 }).toBe(next);
      await expect.poll(() => f.state.updateStatus()?.phase).toBe("error");
      await expect.poll(() => f.status()?.update?.phase, { timeout: 15_000 }).toBe("error");
      expect(f.status()?.update?.output).toContain(agentSkill);
      expect(f.status()?.update?.output).toContain("irudd-scope skill install");
      expect((await f.cli("--help")).stdout).toContain("--plan");
      expect(await readFile(join(f.root, "current/skill/SKILL.md"), "utf8")).toBe(
        "Skill with plan support",
      );
      expect(await readFile(join(agentSkill, "SKILL.md"), "utf8")).toBe("Old independent skill");
      const build = await readlink(join(f.root, "current"));
      const attempts = f.launches();
      await f.openMac(next);
      await expect.poll(() => f.status()?.update?.phase, { timeout: 15_000 }).toBe("error");
      expect(f.launches()).toBe(attempts);
      await expect(f.cli("skill", "sync")).rejects.toMatchObject({
        stderr: expect.stringContaining(agentSkill),
      });
      await rename(agentSkill, `${agentSkill}.saved`);
      await f.cli("skill", "install");
      await f.retry();
      await expect.poll(() => f.state.updateStatus()?.phase, { timeout: 15_000 }).toBe("idle");
      await expect.poll(() => f.status()?.update?.phase, { timeout: 15_000 }).toBe("idle");
      expect(f.launches()).toBe(attempts + 1);
      expect(await readlink(join(f.root, "current"))).toBe(build);
      expect(await readFile(join(agentSkill, "SKILL.md"), "utf8")).toBe("Skill with plan support");
      expect(await readFile(join(`${agentSkill}.saved`, "SKILL.md"), "utf8")).toBe(
        "Old independent skill",
      );
      expect(f.status()?.update?.message).toContain("new agent session");
    } finally {
      await f.close();
    }
  },
  60_000,
);

test.skipIf(process.platform !== "linux")(
  "updates repair Scope links pinned to an old build and preserve an explicit skill removal",
  async () => {
    const f = await remoteUpdateFixture();
    try {
      const original = await readlink(join(f.root, "current"));
      const shared = join(f.directory, "user/.agents/skills/irudd-scope");
      const claude = join(f.directory, "user/.claude/skills/irudd-scope");
      const codex = join(f.directory, "user/.codex/skills/irudd-scope");
      await rm(shared);
      await symlink(join(original, "skill"), shared);
      await rm(claude);
      await mkdir(join(f.directory, "user/.codex/skills"), { recursive: true });
      await symlink(join(original, "skill"), codex);
      const next = await f.commitSkill("Current planning skill");
      await f.openMac(next);
      await expect.poll(() => f.status()?.update?.currentCommit, { timeout: 30_000 }).toBe(next);
      await expect.poll(() => f.state.updateStatus()?.phase, { timeout: 15_000 }).toBe("idle");
      for (const path of [shared, claude, codex])
        expect(await readFile(join(path, "SKILL.md"), "utf8")).toBe("Current planning skill");
      expect(JSON.parse((await f.cli("skill", "check")).stdout)).toEqual({ installed: true });
      const build = await readlink(join(f.root, "current"));
      await rm(shared);
      await symlink(join(original, "skill"), shared);
      await f.openMac(next);
      await expect.poll(() => f.launches(), { timeout: 15_000 }).toBe(2);
      await expect.poll(() => f.state.updateStatus()?.phase, { timeout: 15_000 }).toBe("idle");
      expect(await readlink(join(f.root, "current"))).toBe(build);
      expect(await readFile(join(shared, "SKILL.md"), "utf8")).toBe("Current planning skill");
      await expect.poll(() => f.status()?.update?.phase, { timeout: 15_000 }).toBe("idle");
      await f.cli("skill", "remove");
      await f.retry();
      await expect.poll(() => f.launches(), { timeout: 15_000 }).toBe(3);
      await expect.poll(() => f.state.updateStatus()?.phase, { timeout: 15_000 }).toBe("idle");
      await expect.poll(() => f.status()?.update?.phase, { timeout: 15_000 }).toBe("idle");
      expect(JSON.parse((await f.cli("skill", "check")).stdout)).toEqual({ installed: false });
      expect(f.state.updateStatus()?.message).toContain("not installed");
    } finally {
      await f.close();
    }
  },
  60_000,
);

test.skipIf(process.platform !== "linux")(
  "a separate Codex skill is reported even when the remote already matches the Mac",
  async () => {
    const f = await remoteUpdateFixture();
    try {
      const codex = join(f.directory, "user/.codex/skills/irudd-scope");
      await mkdir(codex, { recursive: true });
      await writeFile(join(codex, "SKILL.md"), "Old Codex skill");
      await f.openMac(f.initialCommit);
      await expect.poll(() => f.state.updateStatus()?.phase, { timeout: 15_000 }).toBe("error");
      await expect.poll(() => f.status()?.update?.phase, { timeout: 15_000 }).toBe("error");
      expect(f.status()?.update?.output).toContain(codex);
      expect(await readFile(join(codex, "SKILL.md"), "utf8")).toBe("Old Codex skill");
      await rename(codex, `${codex}.saved`);
      await f.retry();
      await expect.poll(() => f.state.updateStatus()?.phase, { timeout: 15_000 }).toBe("idle");
      await expect.poll(() => f.status()?.update?.phase, { timeout: 15_000 }).toBe("idle");
      expect(await readFile(join(`${codex}.saved`, "SKILL.md"), "utf8")).toBe("Old Codex skill");
    } finally {
      await f.close();
    }
  },
  60_000,
);

test.skipIf(process.platform !== "linux")(
  "remote update requests require the paired Mac, reject invalid commits, and restore a hub that fails to start",
  async () => {
    const f = await remoteUpdateFixture();
    try {
      const request = (token: string, value: unknown, origin?: string) =>
        fetch(`${f.endpoint}/v1/relay/update`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            ...(origin ? { Origin: origin } : {}),
          },
          body: JSON.stringify(value),
        });
      expect((await request(f.localToken, { commit: f.initialCommit })).status).toBe(401);
      expect(
        (await request(f.token, { commit: f.initialCommit }, "https://example.invalid")).status,
      ).toBe(403);
      expect((await request(f.token, { commit: "main; touch /tmp/no" })).status).toBe(400);
      expect(f.launches()).toBe(0);
      const original = await readlink(join(f.root, "current"));
      await writeFile(
        join(f.upstream, "apps/hub/dist/main.mjs"),
        "throw new Error('Synthetic hub startup failure');\n",
      );
      const broken = await f.commitSkill("Skill from a broken build");
      await f.openMac(broken);
      await expect.poll(() => f.state.updateStatus()?.phase, { timeout: 45_000 }).toBe("error");
      await expect.poll(() => f.status()?.update?.phase, { timeout: 15_000 }).toBe("error");
      expect(f.status()?.update?.message).toContain("previous remote tools were restored");
      expect(await readlink(join(f.root, "current"))).toBe(original);
      expect(JSON.parse((await f.cli("hub", "status")).stdout).commit).toBe(f.initialCommit);
      expect(
        await readFile(join(f.directory, "user/.agents/skills/irudd-scope/SKILL.md"), "utf8"),
      ).toBe("Initial publishing skill");
      await f.cli("text", "Publication after rollback", "--id", "rollback");
      await request(f.token, { commit: "f".repeat(40) });
      await expect
        .poll(() => f.state.updateStatus()?.output, { timeout: 15_000 })
        .toContain("not on Scope's main branch");
    } catch (error) {
      console.error(f.diagnostics());
      throw error;
    } finally {
      await f.close();
    }
  },
  120_000,
);
