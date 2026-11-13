# ghcr.io/beamhop/agent — the beamhop daemon image used by the PaaS deployers (Fly.io, Render,
# Railway). Build context: packages/deploy
#
#   docker build --build-arg BEAMHOP_VERSION=1.2.3 \
#     --build-arg HARNESS_PACKAGES="@anthropic-ai/claude-code @openai/codex" \
#     -t ghcr.io/beamhop/agent:1.2.3 packages/deploy
#
# No secrets are baked in or passed as env: the daemon starts "awaiting provisioning" and receives
# secrets over the encrypted Nostr control channel (§8). No ports are exposed.
# Releases pin the base image by digest and sign the result with cosign (§12).
FROM node:22-slim

ARG BEAMHOP_VERSION
ARG HARNESS_PACKAGES=""

ENV DEBIAN_FRONTEND=noninteractive
# srt prerequisites on Linux (§7): bubblewrap, socat, ripgrep. tini reaps zombies as PID 1.
RUN apt-get update \
  && apt-get install -y --no-install-recommends bubblewrap socat ripgrep git ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*

RUN test -n "$BEAMHOP_VERSION" || (echo "BEAMHOP_VERSION build arg is required" >&2; exit 1) \
  && npm install --global --no-fund --no-audit "beamhop@${BEAMHOP_VERSION}" ${HARNESS_PACKAGES} \
  && npm cache clean --force

RUN groupadd --system --gid 10001 beamhop \
  && useradd --system --uid 10001 --gid beamhop --create-home --home-dir /home/beamhop --shell /usr/sbin/nologin beamhop \
  && install -d -o beamhop -g beamhop -m 0700 /home/beamhop/.beamhop

COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/beamhop-entrypoint

ENV HOME=/home/beamhop \
  BEAMHOP_HOME=/home/beamhop/.beamhop \
  NODE_ENV=production

USER 10001:10001
WORKDIR /home/beamhop
VOLUME ["/home/beamhop/.beamhop"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD ["/usr/local/bin/beamhop-entrypoint", "healthcheck"]

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/beamhop-entrypoint"]
CMD ["daemon"]
