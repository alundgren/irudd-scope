import type { IncomingMessage, ServerResponse } from "node:http";
import { AuthStore, authScope, digest, grantLifetime, secret, type Grant } from "./auth-store.ts";
import { approvalPage } from "./approval-page.ts";
import {
  authJson as json,
  authBody as body,
  authText as text,
  validRedirect,
  approvalCookie,
} from "./auth-http.ts";

export class AuthorizationRoutes {
  readonly store: AuthStore;
  private origin: () => string;
  constructor(path: string, origin: () => string) {
    this.origin = origin;
    this.store = new AuthStore(path);
  }
  resource() {
    return `${this.origin()}/mcp`;
  }
  unauthorized(response: ServerResponse) {
    response.setHeader(
      "WWW-Authenticate",
      `Bearer resource_metadata="${this.origin()}/.well-known/oauth-protected-resource/mcp", scope="${authScope}"`,
    );
    json(response, 401, { error: "invalid_token" });
  }
  async route(request: IncomingMessage, response: ServerResponse, url: URL) {
    const approval = /^\/auth\/approve\/([A-Z0-9_-]{12})$/.exec(url.pathname);
    try {
      if (approval && request.method === "GET") {
        this.browser(response, approval[1]);
        return;
      }
      if (approval && request.method === "POST") {
        await this.decide(request, response, approval[1]);
        return;
      }
      const routes: Record<string, () => void | Promise<void>> = {
        "GET /.well-known/oauth-protected-resource": () => this.protectedMetadata(response),
        "GET /.well-known/oauth-protected-resource/mcp": () => this.protectedMetadata(response),
        "GET /.well-known/oauth-authorization-server": () => this.serverMetadata(response),
        "POST /auth/register": () => this.register(request, response),
        "GET /auth/authorize": () => this.authorize(response, url.searchParams),
        "POST /auth/pairing": () => this.pairing(request, response),
        "POST /auth/pairing/poll": () => this.poll(request, response),
        "POST /auth/pairing/cancel": () => this.cancel(request, response),
        "POST /auth/token": () => this.token(request, response),
        "GET /auth/whoami": () => this.whoami(request, response),
        "POST /auth/revoke": () => this.revoke(request, response),
      };
      const route = routes[`${request.method} ${url.pathname}`];
      if (route) await route();
      else json(response, 404, { error: "Authorization endpoint not found." });
    } catch (error) {
      json(response, 400, {
        error: "invalid_request",
        error_description:
          error instanceof Error ? error.message : "Invalid authorization request.",
      });
    }
  }
  private protectedMetadata(response: ServerResponse) {
    json(response, 200, {
      resource: this.resource(),
      authorization_servers: [this.origin()],
      scopes_supported: authScope.split(" "),
      bearer_methods_supported: ["header"],
    });
  }
  private serverMetadata(response: ServerResponse) {
    const origin = this.origin();
    json(response, 200, {
      issuer: origin,
      authorization_endpoint: `${origin}/auth/authorize`,
      token_endpoint: `${origin}/auth/token`,
      registration_endpoint: `${origin}/auth/register`,
      revocation_endpoint: `${origin}/auth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: authScope.split(" "),
      authorization_response_iss_parameter_supported: true,
    });
  }
  private newGrant(agent: string, kind: Grant["kind"]): Grant {
    return {
      id: secret().slice(0, 12).toUpperCase(),
      kind,
      agent,
      audience: this.resource(),
      expires: Date.now() + grantLifetime,
      status: "pending",
      redeemed: false,
      interval: 2000,
      nextPoll: 0,
    };
  }
  private browser(response: ServerResponse, id: string) {
    const browser = this.store.browser(id);
    if (!browser) {
      json(response, 404, { error: "Authorization not found." });
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "same-origin",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      "Set-Cookie": `plan_approval=${browser.csrf}; Path=/auth/approve/${id}; HttpOnly; SameSite=Strict${this.origin().startsWith("https:") ? "; Secure" : ""}`,
    });
    response.end(approvalPage(browser.grant, browser.csrf));
  }
  private async decide(request: IncomingMessage, response: ServerResponse, id: string) {
    const input = new URLSearchParams(await body(request));
    const csrf = input.get("csrf") ?? "";
    if (!csrf || csrf !== approvalCookie(request) || request.headers.origin !== this.origin()) {
      json(response, 403, { error: "Approval form expired. Reload this page." });
      return;
    }
    const decision = this.store.decide(
      id,
      csrf,
      input.get("action") ?? "",
      input.get("identity") ?? "",
    );
    if (!decision) {
      json(response, 409, { error: "Authorization is no longer pending." });
      return;
    }
    if (decision.grant.kind === "oauth") {
      this.redirect(response, decision.grant, decision.code);
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "same-origin",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    });
    response.end(approvalPage(decision.grant, ""));
  }
  private redirect(response: ServerResponse, grant: Grant, code?: string) {
    const callback = new URL(grant.redirectUri!);
    if (code) callback.searchParams.set("code", code);
    else callback.searchParams.set("error", "access_denied");
    if (grant.state !== undefined) callback.searchParams.set("state", grant.state);
    callback.searchParams.set("iss", this.origin());
    response.writeHead(302, {
      Location: callback.href,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    });
    response.end();
  }
  private async register(request: IncomingMessage, response: ServerResponse) {
    const input = JSON.parse(await body(request)) as Record<string, unknown>;
    if (
      !Array.isArray(input.redirect_uris) ||
      !input.redirect_uris.length ||
      input.redirect_uris.length > 5 ||
      (input.token_endpoint_auth_method !== undefined &&
        input.token_endpoint_auth_method !== "none")
    )
      throw new Error("Register a public client with one to five redirect URIs.");
    for (const [field, supported] of [
      ["grant_types", "authorization_code"],
      ["response_types", "code"],
    ]) {
      const declared = input[field];
      if (
        declared !== undefined &&
        (!Array.isArray(declared) || declared.length !== 1 || declared[0] !== supported)
      )
        throw new Error(`Unsupported ${field}.`);
    }
    json(
      response,
      201,
      this.store.register(
        text(input.client_name ?? "MCP client"),
        input.redirect_uris.map((uri) => validRedirect(text(uri, 2048))),
      ),
    );
  }
  private authorize(response: ServerResponse, input: URLSearchParams) {
    const client = this.store.client(input.get("client_id") ?? "");
    if (!client || !client.redirect_uris.includes(input.get("redirect_uri") ?? ""))
      throw new Error("Unknown client or redirect URI.");
    if (
      input.get("response_type") !== "code" ||
      input.get("resource") !== this.resource() ||
      input.get("code_challenge_method") !== "S256" ||
      !/^[A-Za-z0-9_-]{43}$/.test(input.get("code_challenge") ?? "")
    )
      throw new Error("Use authorization code with S256 PKCE and the MCP resource.");
    const scope = input.get("scope");
    if (scope !== null && new Set(scope.split(" ").filter(Boolean)).size !== 2)
      throw new Error("Request both supported plan scopes.");
    if (
      scope !== null &&
      scope.split(" ").some((entry) => entry && !authScope.split(" ").includes(entry))
    )
      throw new Error("Unknown authorization scope.");
    const grant = this.newGrant(client.client_name, "oauth");
    grant.clientId = client.client_id;
    grant.redirectUri = input.get("redirect_uri")!;
    grant.challenge = input.get("code_challenge")!;
    grant.state = input.get("state") ?? undefined;
    if (grant.state && grant.state.length > 2048) throw new Error("State exceeds 2048 characters.");
    this.store.create(grant);
    response.writeHead(302, { Location: `/auth/approve/${grant.id}`, "Cache-Control": "no-store" });
    response.end();
  }
  private async pairing(request: IncomingMessage, response: ServerResponse) {
    const input = JSON.parse(await body(request)) as Record<string, unknown>;
    if (input.resource !== this.resource())
      throw new Error("Pairing resource does not match this MCP endpoint.");
    const grant = this.newGrant(text(input.agent), "pairing");
    const device = secret();
    grant.deviceHash = digest(device);
    this.store.create(grant);
    json(response, 200, {
      pairing_id: grant.id,
      pairing_secret: device,
      user_code: grant.id,
      verification_uri: `${this.origin()}/auth/approve/${grant.id}`,
      expires_in: grantLifetime / 1000,
      interval: grant.interval / 1000,
    });
  }
  private async poll(request: IncomingMessage, response: ServerResponse) {
    const input = JSON.parse(await body(request)) as Record<string, unknown>;
    const outcome = this.store.poll(
      text(input.pairing_id),
      text(input.pairing_secret),
      this.resource(),
    );
    json(response, "error" in outcome ? 400 : 200, outcome);
  }
  private async cancel(request: IncomingMessage, response: ServerResponse) {
    const input = JSON.parse(await body(request)) as Record<string, unknown>;
    json(
      response,
      this.store.cancel(text(input.pairing_id), text(input.pairing_secret)) ? 200 : 400,
      {},
    );
  }
  private async token(request: IncomingMessage, response: ServerResponse) {
    const input = new URLSearchParams(await body(request));
    if (input.get("grant_type") !== "authorization_code") {
      json(response, 400, { error: "unsupported_grant_type" });
      return;
    }
    const outcome = this.store.redeem(input, this.resource());
    json(response, "error" in outcome ? 400 : 200, outcome);
  }
  private whoami(request: IncomingMessage, response: ServerResponse) {
    const token = /^Bearer ([A-Za-z0-9_-]+)$/.exec(request.headers.authorization ?? "")?.[1];
    const credential = token && this.store.verify(token, this.resource());
    if (!credential) {
      this.unauthorized(response);
      return;
    }
    json(response, 200, {
      actor: credential.actor,
      agent: credential.agent,
      endpoint: this.resource(),
      expiresAt: new Date(credential.expires).toISOString(),
    });
  }
  private async revoke(request: IncomingMessage, response: ServerResponse) {
    const input = new URLSearchParams(await body(request));
    this.store.revoke(input.get("token") ?? "");
    json(response, 200, {});
  }
}
