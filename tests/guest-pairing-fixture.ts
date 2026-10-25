import { createHmac } from "node:crypto";
import type { ElectronApplication, Page } from "@playwright/test";
import { expect } from "vite-plus/test";
import type { GuestInvitation, GuestClaim } from "@irudd-scope/protocol/guest";

export async function pairGuests(
  left: ElectronApplication,
  right: ElectronApplication,
  pageA: Page,
  pageB: Page,
  names = ["Source Scope", "Guest Scope"],
  beforeApprove?: (invitation: GuestInvitation) => Promise<void>,
  approve?: (page: Page, peerName: string) => Promise<void>,
) {
  for (const page of [pageA, pageB])
    for (const peer of (await page.evaluate(() => window.scope.guestDevices())).peers)
      await page.evaluate((id) => window.scope.forgetGuest(id), peer.id);
  const created = await pageA.evaluate(
    (name) => window.scope.createGuestInvitation(name),
    names[0]!,
  );
  await pageA.evaluate((id) => window.scope.copyGuestInvitation(id), created.id);
  const link = await left.evaluate(({ clipboard }) => clipboard.readText());
  const invitation: GuestInvitation = JSON.parse(
    Buffer.from(link.split("#")[1]!, "base64url").toString(),
  );
  await beforeApprove?.(invitation);
  await right.evaluate(({ clipboard }, link) => clipboard.writeText(link), link);
  const review = await pageB.evaluate(
    (name) => window.scope.inspectGuestInvitation(name),
    names[1]!,
  );
  expect(review).toMatchObject({ state: "review", peerName: names[0] });
  expect((await pageB.evaluate(() => window.scope.guestDevices())).peers).toHaveLength(0);
  if (approve) await approve(pageB, names[0]!);
  else await pageB.evaluate((id) => window.scope.approveGuestPairing(id), created.id);
  await expect
    .poll(() => pageA.evaluate(() => window.scope.guestPairingStatus()).then((s) => s?.state))
    .toBe("review");
  expect((await pageA.evaluate(() => window.scope.guestDevices())).peers).toHaveLength(0);
  if (approve) await approve(pageA, names[1]!);
  else await pageA.evaluate((id) => window.scope.approveGuestPairing(id), created.id);
  await expect
    .poll(() => pageB.evaluate(() => window.scope.guestPairingStatus()).then((s) => s?.state), {
      timeout: 25000,
    })
    .toBe("complete");
  const claim = await right.evaluate(
    () => (globalThis as unknown as { scopeGuestClaim: GuestClaim }).scopeGuestClaim,
  );
  const { secret, ...publicInvitation } = invitation;
  const key = createHmac("sha256", Buffer.from(secret, "base64url"))
    .update(
      "scope-guest:pair-key:" + JSON.stringify({ invitation: publicInvitation, value: claim }),
    )
    .digest("base64url");
  return { id: created.id, invitation, link, claim, key };
}
