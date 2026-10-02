import { resolve } from "node:path";
import { NativeTransferTransport } from "../apps/desktop/src/transfer/transport.ts";

// This optional check uses public Tailcat relays with synthetic payloads.
const transport = new NativeTransferTransport(resolve("apps/desktop/dist/scope-tailcat"));
const request = JSON.stringify({ ciphertext: "synthetic-encrypted-request" });
const response = JSON.stringify({ ciphertext: "a".repeat(1024 * 1024) });
const listener = await transport.listen(async (body) => {
  if (body !== request) throw new Error("Unexpected synthetic request.");
  return response;
});
try {
  if ((await transport.request(listener.address, request)) !== response) {
    throw new Error("The native Scope transfer response did not match.");
  }
  console.log("Native Scope transfer exchanged a synthetic 1 MiB response.");
} finally {
  await listener.close();
}
