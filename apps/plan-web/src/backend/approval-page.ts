import { fakeIdentities, type Grant } from "./auth-store.ts";

function escape(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
}
export function approvalPage(grant: Grant, csrf: string) {
  const pending = grant.status === "pending";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Approve plan agent</title>
<style>body{margin:0;background:#fff;color:#1b1b1f;font:16px/1.6 system-ui,sans-serif}main{max-width:640px;margin:8vh auto;padding:24px}h1{font-size:28px;font-weight:600}code{overflow-wrap:anywhere}fieldset{border:0;padding:0;margin:24px 0}legend{margin-bottom:12px}label{display:block;padding:8px}button{font:inherit;padding:10px 16px;border:1px solid #767680;border-radius:6px;background:#fff;cursor:pointer;margin:8px 8px 0 0}button[value=approve]{background:#6965db;color:#fff;border-color:#6965db}button[value=deny]{color:#b42335}small{display:block;color:#535360;margin-top:24px}</style></head><body><main>
<p>Scope plans · development identities</p><h1>${pending ? "Approve this agent?" : `Authorization ${escape(grant.status)}`}</h1>
<p><strong>${escape(grant.agent)}</strong> wants to read and change HTML plans, add comments and replies, and resolve discussions.</p>
<p>Server<br><code>${escape(grant.audience)}</code></p>
<p>Approval code<br><code>${escape(grant.id)}</code></p>
${pending ? `<form method="post" action="/auth/approve/${escape(grant.id)}"><input type="hidden" name="csrf" value="${escape(csrf)}"><fieldset><legend>Choose the identity this agent will act for</legend>${fakeIdentities.map((name, index) => `<label><input type="radio" name="identity" value="${name}" ${index === 0 ? "checked" : ""}> ${name}</label>`).join("")}</fieldset><button name="action" value="approve">Approve agent</button><button name="action" value="deny">Deny</button><button name="action" value="cancel">Cancel</button></form>` : "<p>You can close this page and return to your agent.</p>"}
<small>Alex, Blair and Casey are fake identities for this exploration. This grant covers every plan on this server. MCP credentials expire after eight hours and can be revoked with the CLI logout command. The v1 browser and REST API remain open.</small>
</main></body></html>`;
}
