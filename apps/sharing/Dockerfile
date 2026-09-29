FROM cloudflare/cloudflared:2026.9.3@sha256:072c067d25ccbe61d46e18f0d0723255f2bb5304f7317caa95b27031520ff92c AS connector
FROM node:26.10.0-bookworm-slim@sha256:662933cf47f013bc8e4beb31a6116448427a82057ba7c42c97e4c5ba766504c2
RUN apt-get update && apt-get install -y --no-install-recommends iptables iproute2 util-linux ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=connector /usr/local/bin/cloudflared /usr/local/bin/cloudflared
COPY dist/ /app/
WORKDIR /app
ENTRYPOINT ["/usr/local/bin/node", "/app/bootstrap.mjs"]
