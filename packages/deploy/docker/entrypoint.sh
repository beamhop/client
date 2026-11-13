#!/bin/sh
# Entrypoint for ghcr.io/beamhop/agent.
#   beamhop-entrypoint daemon        start beamhopd in the foreground (default)
#   beamhop-entrypoint healthcheck   exit 0 when the daemon's local socket is up
#   beamhop-entrypoint <cmd...>      run any other command
set -eu

BEAMHOP_HOME="${BEAMHOP_HOME:-$HOME/.beamhop}"
export BEAMHOP_HOME

log() { printf '[beamhop-entrypoint] %s\n' "$*" >&2; }

healthcheck() {
  [ -S "$BEAMHOP_HOME/beamhop.sock" ] || { log "daemon socket missing"; exit 1; }
  exit 0
}

# Secrets must arrive over the Nostr control channel, never as container env (§8).
# Drop anything secret-looking and report only its name.
scrub_env() {
  for name in $(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p'); do
    case "$name" in
      BEAMHOP_DAEMON_NSEC_REF|BEAMHOP_PROVISIONING_PUBKEY) ;;
      *TOKEN*|*SECRET*|*PASSWORD*|*NSEC*|*API_KEY*|*APIKEY*|*PRIVATE*)
        log "ignoring secret-looking env var $name (secrets are provisioned over Nostr)"
        unset "$name"
        ;;
    esac
  done
}

# PaaS containers may not allow user namespaces (§7). Detect it so the daemon can fall back to
# the container boundary while srt's network proxy and the broker still apply.
probe_sandbox() {
  if bwrap --unshare-user --unshare-pid --die-with-parent --ro-bind / / --proc /proc --dev /dev true >/dev/null 2>&1; then
    BEAMHOP_SANDBOX_FS=srt
  else
    BEAMHOP_SANDBOX_FS=container
    log "user namespaces unavailable: bubblewrap disabled; container boundary + broker egress proxy apply"
  fi
  export BEAMHOP_SANDBOX_FS
}

# Install harness CLIs selected at deploy time that are not baked into the image. They go to the
# persistent volume so restarts are fast.
install_harnesses() {
  pkgs="${BEAMHOP_HARNESS_PACKAGES:-}"
  [ -n "$pkgs" ] || return 0
  prefix="$BEAMHOP_HOME/npm-global"
  PATH="$prefix/bin:$PATH"
  export PATH
  stamp="$prefix/.installed"
  if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$pkgs" ]; then return 0; fi
  for p in $pkgs; do
    case "$p" in
      *[!A-Za-z0-9@/._~^=+-]*|-*) log "refusing invalid package spec"; exit 64 ;;
    esac
  done
  mkdir -p "$prefix"
  # shellcheck disable=SC2086 # word splitting is intended; specs are validated above
  npm install --global --prefix "$prefix" --no-fund --no-audit $pkgs
  printf '%s' "$pkgs" > "$stamp"
}

cmd="${1:-daemon}"
case "$cmd" in
  healthcheck) healthcheck ;;
  daemon)
    shift || true
    if [ "$(id -u)" = "0" ]; then log "refusing to run the daemon as root"; exit 1; fi
    umask 077
    mkdir -p "$BEAMHOP_HOME"
    chmod 700 "$BEAMHOP_HOME"
    scrub_env
    probe_sandbox
    install_harnesses
    exec beamhop daemon --foreground "$@"
    ;;
  *) exec "$@" ;;
esac
