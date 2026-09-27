# Forwarding hub

The hub authenticates and forwards the artifact API to the desktop. It owns
no database, artifact files, retry queue, or model execution. Keep dependencies
on the shared protocol; do not import desktop or CLI internals.

Bind to loopback. Preserve authentication, browser-origin rejection, bounded
requests, streaming, and cancellation when either connection closes. A
desktop outage must fail the request without replay after reconnection.

Verify changes through the forwarding cases in `../../tests/artifacts.test.ts`,
including unavailable desktops and live events. Use the built CLI when a
change affects publication. Launch and environment details are in
[development](../../docs/development.md#remote-access).
