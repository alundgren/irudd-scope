# Standalone sharing service

Own the sharing database, private management API, public content listeners,
connector processes, and containment checks. Import shared contracts from
packages/protocol; do not import desktop, hub, or CLI internals.

Public listeners expose GET and HEAD content reads only. They never mount
management routes, interpret documents, proxy arbitrary destinations, or
read host files. All snapshots and pairing state belong in SQLite.

Production startup requires verified containment. Never add an environment
switch that bypasses it. Standard tests use synthetic connectors through the
service's explicit runtime dependencies, without public tunnels or credentials.
