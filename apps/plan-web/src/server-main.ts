import { fileURLToPath } from "node:url";
import { startPlanWebServer } from "./backend/server.ts";

// Bundled entry is in dist/server; source development entry is in src.
const assets = new URL(
  import.meta.url.includes("/dist/server/") ? "../client/" : "../dist/client/",
  import.meta.url,
);
const server = await startPlanWebServer({
  databasePath: process.env.PLAN_WEB_DB ?? "./plan-web.sqlite",
  port: Number(process.env.PORT ?? 43130),
  host: process.env.HOST ?? "127.0.0.1",
  assetsDirectory: fileURLToPath(assets),
});
console.log(server.url);
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void server.close();
  });
}
