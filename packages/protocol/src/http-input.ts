import type { IncomingMessage, ServerResponse } from "node:http";

/** Bounds body receipt independently of socket activity and server-wide timeout settings. */
export function httpInputDeadline(request: IncomingMessage, response: ServerResponse) {
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const clear = () => {
    closed = true;
    clearTimeout(timer);
    request.off("end", clear);
    request.off("close", clear);
    response.off("close", clear);
    response.off("finish", finished);
  };
  const finished = () => {
    clear();
    // An early rejection must not leave an unread body occupying the connection.
    if (!request.complete) request.destroy();
  };
  const limit = (milliseconds: number) => {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(
      () => {
        clear();
        if (request.complete || request.destroyed) return;
        if (response.headersSent) request.destroy();
        else
          response
            .writeHead(408, {
              "Content-Type": "application/json",
              "Cache-Control": "no-store",
              Connection: "close",
            })
            .end(JSON.stringify({ error: "Request body deadline exceeded." }), () =>
              request.destroy(),
            );
      },
      Math.max(0, milliseconds - (performance.now() - started)),
    );
    timer.unref();
  };
  request.once("end", clear);
  request.once("close", clear);
  response.once("close", clear);
  response.once("finish", finished);
  limit(30_000);
  return limit;
}
