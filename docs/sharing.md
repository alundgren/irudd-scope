# Public tab sharing

Public sharing is an optional, separate installation. Scope sends a frozen
copy of a tab to a paired sharing service after a native confirmation. The
service can run on the Mac or a Linux VM. A VM-hosted copy remains available
when Scope quits or the Mac turns off.

Each copy gets an unguessable public URL and its own Cloudflare Quick Tunnel
hostname. Anyone with the complete link can read and save it. There are no
viewer accounts. A service allows five active copies. Every copy expires
within 24 hours; there is no duration setting or renewal. Quick Tunnels are
experimental and can end earlier.

## Install and pair

Install the [standalone CLI](development.md), Docker 28 or later, and start
the local Docker engine. A Mac uses Docker's Linux VM. Remote Docker contexts
are refused. Installation needs permission to manage containers. VM hosting
also needs Tailscale with MagicDNS and HTTPS, on the same tailnet as the Mac.
The installing user must be allowed to manage Tailscale Serve, or run setup
and removal with the necessary host privileges.

```sh
irudd-scope sharing setup
```

On a Mac, management stays on host loopback. On Linux, setup adds a private
Tailscale Serve route so the Mac can reach the VM's management listener.
`--port` and `--https-port` select unused ports; defaults are 43131 and 8460.
`--name` sets the service's displayed name. `--yes` confirms installation in a
noninteractive shell. `--no-pair` skips printing a pairing URL.

Setup builds a service image, creates its own Docker volume and bridge, and
checks the created container and running restrictions. It refuses to start
when those checks fail. It does not create a public tunnel. Paste the printed,
single-use URL in **Settings → Public sharing**. It expires in ten minutes.
One desktop pairs with each service; a desktop can pair with several services.
Generate another URL with `irudd-scope sharing pair`.

The service installation is independent of the hub, desktop updates, and
ordinary agent publishing. Install the standalone CLI even if the desktop's
local publishing CLI is already available.

## Share and manage copies

After pairing, open **Share tab** in Search and controls. Supported tabs are
HTML, images, Markdown, text, and diagrams. The native confirmation names the
tab and hosting service before uploading any snapshot. The resulting dialog
shows a copyable link and QR code. Fullscreen also has a Share tab button.

HTML bytes are served unchanged. Text and supported images are served
directly. Markdown is rendered on the desktop with the same treatment of raw
HTML, links, and images as its tab view. A diagram becomes a PNG of the canvas,
without conversation or workspace state. Copies are limited to 32 MiB.

Opening Share tab again shows the existing copy. **Refresh shared content**
prepares another frozen snapshot and asks for native confirmation. It keeps
the same URL and original expiry. Viewers reload to see the replacement. A
rejected refresh leaves the previous snapshot in place. If a connection is
lost, Scope cannot claim which revision the service received; it checks the
service again before showing its current state.

Closing the source tab leaves its copy running. **Public shares** in Search
and controls lists copies even after their tabs are gone. Stop sharing closes
the listener and connector and deletes the stored content. If the service is
unreachable, Scope retains a pending stop and retries while open, including
after restart. Removing a service pairing also waits for acknowledgement that
its shares stopped and its credential was revoked. Keep the record until that
operation succeeds.

## Service operations

```sh
irudd-scope sharing status
irudd-scope sharing stop
irudd-scope sharing start
irudd-scope sharing unpair
irudd-scope sharing update
irudd-scope sharing remove
```

Stop, unpair, update, and remove explain that active links end and require a
terminal confirmation or `--yes`. Updates are manual and use the installed
standalone CLI's service code. Update the standalone CLI first to obtain a
new service version. Updates retain pairing and the private database.
Removal deletes the container, database volume, bridge, and its owned private
Serve route. It preserves unrelated Tailscale routes.
Removal stops the container before cleaning up Tailscale. If route cleanup
fails, the stopped installation remains available for another removal attempt.
Start, update, and pairing recheck that Linux management still uses the owned
private route and stop the service if that check fails.

Docker must remain running for the service to be available. A service or
connector restart ends affected links. Startup marks previous copies
interrupted and deletes their bytes; it never recreates public links. A Mac
that sleeps cannot keep forwarding traffic. After resume, expiry is checked
using both wall time and Linux uptime. Backward clock changes end the copy.

The private management listener remains available while idle. There is no
public content listener or Quick Tunnel when no copy is active. An old
Cloudflare hostname can still resolve or display a provider error.

## Access restrictions

The public listeners accept only exact-token GET and HEAD requests. Other
methods, form submissions, request bodies, upgrades, and management paths are
rejected. Responses use `Cache-Control: no-store` and
`Referrer-Policy: no-referrer`. A complete URL is a read capability; do not put
it in logs or publish it accidentally.

Public requests never interpret scripts on the host. Authored HTML still runs
in a viewer's browser and can contact unrelated external servers. A frozen
HTML file does not freeze its external resources. Stopping access cannot
erase content already received or saved by a viewer.
If recording a stop fails, the service still closes the listener and connector.
It rejects new shares and reports the database failure until restart, when
startup recovery reconciles the stored copies.

The container has a read-only runtime, one private SQLite volume, a bounded
temporary directory, and one read-only DNS configuration file. It receives
no Scope database, host home directory, Keychain, or Docker socket mount.
Bootstrap installs default-deny IPv4 and IPv6 rules, then drops to an
unprivileged UID with zero capabilities, no-new-privileges, and seccomp.
The sharing process owns PID 1, so its exit terminates connector processes.

Outbound connections are limited to pinned Cloudflare API IPv4 addresses on
443 and published tunnel edge addresses on TCP 7844. The static local DNS
responder answers only tunnel discovery records and never forwards queries.
Cloudflare API addresses can also host other Cloudflare services; this is an
IP and port restriction, not inspection of encrypted HTTP requests. Address
changes may require a service update. Inbound management is limited to the
container gateway and is published only on host loopback; Tailscale Serve
adds private reachability on a VM. Management also requires a
separate bearer credential and rejects browser Origin headers.

Installation inspects actual container settings and process privileges. A
disposable sibling container must reach a synthetic host listener while the
sharing process must fail to reach it. The sibling must also fail to reach
the management listener. Filesystem and DNS denial probes run before pairing.
Checks run on the installation host, including Docker Desktop; configurations
that cannot demonstrate these restrictions are refused. Host administrators
and Docker administrators remain trusted. Do not manually republish the
management port through Funnel or a public reverse proxy.

Cloudflare documents Quick Tunnels as a development and testing service, with
no uptime guarantee, a limit of 200 concurrent requests, and no server-sent
events. See [Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
and [tunnel firewall requirements](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/).
