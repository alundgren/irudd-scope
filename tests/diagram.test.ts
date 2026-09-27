import { expect, test } from "vite-plus/test";
import { readFile } from "node:fs/promises";
import { openRouterProvider } from "../apps/desktop/src/diagram/openrouter.ts";
import { emptyScene } from "../apps/desktop/src/diagram/contract.ts";
import { applyOperations } from "../apps/desktop/src/diagram/scene.ts";

const fixture = await readFile(
  new URL("./fixtures/diagram-response.json", import.meta.url),
  "utf8",
);
test("the provider requests the selected model with a strict schema and validates operations before returning usage", async () => {
  let body: Record<string, unknown> = {};
  const provider = openRouterProvider("synthetic-api-key", async (_url, init) => {
    if (typeof init?.body !== "string") throw new Error("Expected a JSON request body.");
    body = JSON.parse(init.body);
    return Response.json({
      choices: [{ message: { content: fixture }, finish_reason: "stop" }],
      usage: { prompt_tokens: 123, completion_tokens: 45, cost: 0.001 },
    });
  });
  const result = await provider.generateDiagram(
    { intent: "Draw a browser talking to an API.", scene: emptyScene() },
    new AbortController().signal,
  );
  expect(body).toMatchObject({
    model: "google/gemini-3.8-flash",
    response_format: { type: "json_schema", json_schema: { strict: true } },
  });
  expect(JSON.stringify(body)).not.toContain("synthetic-api-key");
  expect(result.metrics).toMatchObject({ inputTokens: 123, outputTokens: 45, cost: 0.001 });
  const scene = applyOperations(emptyScene(), result.operations);
  expect(scene.nodes.map((node) => node.label)).toEqual(["Browser", "API"]);
  expect(scene.connections).toMatchObject([{ from: "browser", to: "api" }]);
  expect(() =>
    applyOperations(scene, [
      { type: "move", id: "browser", x: 99, y: 99 },
      { type: "delete", ids: ["missing"] },
    ]),
  ).toThrow();
  expect(scene.nodes[0].x).toBe(100);
});

test("malformed or unresolved operations fail without returning a usable response", async () => {
  const provider = openRouterProvider("synthetic-api-key", async () =>
    Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              message: "Wrong",
              operations: [
                {
                  type: "connect",
                  id: "bad",
                  from: "missing",
                  to: "also-missing",
                  label: null,
                  style: null,
                },
              ],
            }),
          },
          finish_reason: "stop",
        },
      ],
    }),
  );
  await expect(
    provider.generateDiagram(
      { intent: "Draw something.", scene: emptyScene() },
      new AbortController().signal,
    ),
  ).rejects.toThrow("invalid diagram");
});
