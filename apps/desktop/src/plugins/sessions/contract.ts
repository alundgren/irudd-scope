import { Schema } from "effect";
import { SESSION_DAYS } from "@irudd-scope/sessions/contract";

export const SessionsTabState = Schema.Struct({
  version: Schema.Literal(1),
  data: Schema.Struct({}),
});
export const sessionsTabContract = {
  type: "sessions",
  category: "builtin" as const,
  version: 1,
  state: SessionsTabState,
};
export const sessionsTabState = () => ({ version: 1, data: {} });

export const SessionsReadRequest = Schema.Struct({ days: Schema.Literals(SESSION_DAYS) });
export type SessionsReadRequest = typeof SessionsReadRequest.Type;
