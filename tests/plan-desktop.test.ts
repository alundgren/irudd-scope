import { expect, test } from "vite-plus/test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { desktopFixture } from "./desktop-fixture.ts";

const html = `<!doctype html><html><head><title>Checkout page</title><style>body{margin:0;padding:40px;font:18px system-ui;background:#f3f8f1;color:#182a21}button{font:inherit;padding:12px}section{height:1600px}input{font:inherit}</style></head><body><h1>Interactive checkout</h1><button id="next" onclick="document.querySelector('h1').textContent='Payment details';this.hidden=true">Next step</button><input aria-label="Order reference"><section>Keep this authored page interactive.</section><p>End of plan</p></body></html>`;
const evidence = "/tmp/scope-plan-ui-evidence";

test("a plan shows interactive HTML without feedback controls and follows updated content", async () => {
  const { directory, launch, cli } = await desktopFixture({ hideInitialPrompts: true });
  const application = await launch();
  try {
    await mkdir(evidence, { recursive: true });
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const file = join(directory, "checkout.html");
    await writeFile(file, html);
    await cli("add", file, "--plan", "--name", "plan-checkout", "--title", "Checkout plan");
    const panel = page.getByRole("tabpanel", { name: "Checkout plan" });
    const frame = page.frameLocator('iframe[title="Checkout plan"]');
    await frame.getByRole("heading", { name: "Interactive checkout" }).waitFor();
    for (const name of ["Comment", "Feedback", "Approve version"])
      expect(await panel.getByRole("button", { name, exact: true }).count()).toBe(0);
    expect(await panel.getByRole("complementary").count()).toBe(0);
    await frame.getByRole("button", { name: "Next step" }).click();
    await frame.getByRole("textbox", { name: "Order reference" }).fill("order-123");
    await frame.getByText("End of plan").scrollIntoViewIfNeeded();
    const scrolled = await frame.locator("html").evaluate(() => window.scrollY);
    expect(scrolled).toBeGreaterThan(0);
    await page.screenshot({ path: join(evidence, "plan-reading.png") });

    const other = join(directory, "other.html");
    await writeFile(other, "<h1>Other plan</h1>");
    await cli("add", other, "--plan", "--name", "plan-other", "--title", "Other plan");
    await page.getByRole("tab", { name: "Other plan", exact: true }).click();
    await page
      .frameLocator('iframe[title="Other plan"]')
      .getByRole("heading", { name: "Other plan" })
      .waitFor();
    await page.getByRole("tab", { name: "Checkout plan", exact: true }).click();
    await frame.getByRole("heading", { name: "Payment details" }).waitFor();
    expect(await frame.getByRole("textbox", { name: "Order reference" }).inputValue()).toBe(
      "order-123",
    );
    expect(await frame.locator("html").evaluate(() => window.scrollY)).toBe(scrolled);

    await writeFile(file, html.replace("Interactive checkout", "Revised checkout"));
    await cli("update", "plan-checkout", file);
    await frame.getByRole("heading", { name: "Revised checkout" }).waitFor();
    expect(await page.locator(".plan-document").count()).toBe(2);
    expect(errors).toEqual([]);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
