# Forwarding hub

The hub authenticates and forwards the artifact API to the desktop. It owns
its configuration and credential hashes in `hub.db`, but no artifacts, retry
queue, or model execution. Keep dependencies on the shared protocol; do not
import desktop or CLI internals.

The Mac opens the relay connection and every transfer. Local publishing and
desktop relay credentials have separate roles. Pairing links expire and can
be used once. Revocation closes the connection and all current requests.

Bind to loopback. Preserve authentication, browser-origin rejection, bounded
requests, streaming, and cancellation when either connection closes. A
desktop outage must fail the request without replay after reconnection.

Verify changes through the forwarding cases in `../../tests/artifacts.test.ts`,
and pairing cases in `../../tests/remotes.test.ts`, including unavailable
desktops and live events. Use the built CLI when a
change affects publication. Launch and environment details are in
[development](../../docs/development.md#remote-access).
