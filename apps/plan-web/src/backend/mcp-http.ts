import type { IncomingMessage, ServerResponse } from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { authScope } from "./auth-store.ts";
import { AuthorizationRoutes } from "./authorization.ts";
import { authJson } from "./auth-http.ts";
import { createPlanMcpServer } from "./mcp-tools.ts";
import type { PlanStore } from "./store.ts";

export function createMcpRoutes(path: string, plans: PlanStore, origin: () => string) {
  const auth = new AuthorizationRoutes(path, origin);
  const handler = createMcpHandler(
    ({ authInfo }) => {
      const credential = auth.store.verify(authInfo?.token ?? "", auth.resource());
      if (!credential) throw new Error("Authorization expired. Log in again.");
      return createPlanMcpServer(plans, credential.actor);
    },
    { legacy: "reject", maxRequestBodySize: 2 * 1024 * 1024 },
  );
  const nodeHandler = toNodeHandler(handler, { maxRequestBodySize: 2 * 1024 * 1024 });
  async function mcp(request: IncomingMessage, response: ServerResponse) {
    if (request.method !== "POST") {
      authJson(response, 405, { error: "MCP accepts POST requests." });
      return;
    }
    const token = /^Bearer ([A-Za-z0-9_-]+)$/.exec(request.headers.authorization ?? "")?.[1];
    if (!token || !auth.store.verify(token, auth.resource())) {
      auth.unauthorized(response);
      return;
    }
    await nodeHandler(
      Object.assign(request, {
        auth: { token, clientId: "plan-web", scopes: authScope.split(" ") },
      }),
      response,
    );
  }
  async function route(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", origin());
    if (
      !(
        url.pathname === "/mcp" ||
        url.pathname.startsWith("/auth/") ||
        url.pathname.startsWith("/.well-known/oauth-")
      )
    )
      return false;
    // Do not derive the issuer or audience from untrusted forwarded headers.
    if (
      request.headers.host !== new URL(origin()).host ||
      (request.headers.origin && request.headers.origin !== origin())
    ) {
      authJson(response, 403, { error: "Forbidden origin or host." });
      return true;
    }
    if (url.pathname === "/mcp") await mcp(request, response);
    else await auth.route(request, response, url);
    return true;
  }
  return {
    route,
    async close() {
      await handler.close();
      auth.store.close();
    },
  };
}
