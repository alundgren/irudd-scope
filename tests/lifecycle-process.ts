import { join } from "node:path";
import { ArtifactStore } from "../apps/desktop/src/library/store.ts";
import { DesktopStore } from "../apps/desktop/src/desktop-store.ts";
import { DesktopLifecycle } from "../apps/desktop/src/lifecycle.ts";

const [directory, stopAt] = process.argv.slice(2);
const checkpoint = async (point: string) => {
  if (point !== stopAt) return;
  process.send?.({ point });
  await new Promise<void>(() => {});
};
const desktop = new DesktopStore(directory);
await desktop.load();
const artifacts = await ArtifactStore.open(join(directory, "artifacts"), checkpoint);
const lifecycle = new DesktopLifecycle(artifacts, desktop, checkpoint);
await lifecycle.recover();
await lifecycle.deleteArtifact("crash-test");
await artifacts.close();
await desktop.close();
