# Forwarding hub

The hub authenticates and forwards the artifact API to the desktop. It owns
its configuration, credential hashes, bounded publication queue, and saved
artifact metadata in `hub.db`.
The queue temporarily owns content and metadata until delivery or expiry;
the desktop owns delivered artifacts. The hub does not execute models. Keep dependencies on the shared protocol; do not
import desktop or CLI internals.

The Mac opens the relay connection and every transfer. Local publishing and
desktop relay credentials have separate roles. Pairing links expire and can
be used once. Revocation closes the connection and all current requests.

Bind to loopback. Preserve authentication, browser-origin rejection, bounded
requests, streaming, and cancellation when either connection closes. Opted-in publications always reserve a buffered tab, regardless of the paired Mac's connection state.
Keep the queue durable, capped at 50 tabs including incomplete uploads, and
expire entries 48 hours after reservation. Attempt complete publications while
connected, preserve revision checks, and recover uncertain acknowledgements
without overwriting newer desktop content. Transient delivery failures back off
from 3 seconds to 5 minutes; new arrivals and ordinary reconnects must respect
the cooldown. Only a successful delivery or an authenticated Mac wake resets it.
Other requests fail during outages.
Retain at most 1,000 recently observed artifact metadata records for 48 hours;
only opted-in update reads can use them offline. Never infer a current desktop
revision from saved metadata. Revocation clears both metadata and the queue
so another Mac cannot receive previous content.

Verify changes through the forwarding cases in `../../tests/artifacts.test.ts`,
and pairing cases in `../../tests/remotes.test.ts`, including unavailable
desktops and live events. Use the built CLI when a
change affects publication. Launch and environment details are in
[development](../../docs/development.md#remote-access).
