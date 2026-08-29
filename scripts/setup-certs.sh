#!/usr/bin/env bash
#
# Generates the local development certificate used by all three PhoneMote
# processes, and publishes the root CA so the phone can fetch it.
#
#   pnpm setup:certs
#
# Run it once per machine, and again whenever your LAN IP changes.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cert_dir="$repo_root/certs"

if ! command -v mkcert >/dev/null 2>&1; then
  cat >&2 <<'MSG'
mkcert is not on PATH.

  Windows : winget install FiloSottile.mkcert
  macOS   : brew install mkcert
  Linux   : see https://github.com/FiloSottile/mkcert#installation

Then open a new shell and run "pnpm setup:certs" again.
MSG
  exit 1
fi

# Idempotent: installs the local CA into the system trust store the first time.
mkcert -install

# The server owns the LAN IP rule; ask it rather than duplicating the logic.
hosts=$(pnpm --filter @phonemote/server run --silent cert-hosts)
if [ -z "$hosts" ]; then
  echo "Could not determine any host name for the certificate." >&2
  exit 1
fi

mkdir -p "$cert_dir"

# shellcheck disable=SC2086 # word splitting is what turns the list into args
mkcert \
  -cert-file "$cert_dir/dev-cert.pem" \
  -key-file "$cert_dir/dev-key.pem" \
  $hosts

# Publish the *public* root CA through the controller dev server, so the phone
# can download it from the address it already browses to instead of needing a
# cable or a messenger app. The private key is deliberately never copied.
caroot=$(mkcert -CAROOT)
# Git Bash reports a Windows path here; cygpath makes it usable by cp.
caroot=$(cygpath -u "$caroot" 2>/dev/null || printf %s "$caroot")
public_dir="$repo_root/apps/controller/public"
mkdir -p "$public_dir"
cp "$caroot/rootCA.pem" "$public_dir/rootCA.crt"

lan_ip=$(printf '%s\n' "$hosts" | grep -E '^(10\.|192\.168\.|172\.)' | head -n 1 || true)
lan_ip=${lan_ip:-<LAN-IP>}

echo
echo "Certificate written to certs/ for:"
printf '%s\n' "$hosts" | sed 's/^/  /'
echo
echo "Root CA for the phone:"
echo "  on this PC : $caroot/rootCA.pem"
echo "  on the phone: https://$lan_ip:5174/rootCA.crt"
echo
echo "Download that URL on the phone, then install it from"
echo "Settings > Security > Encryption & credentials > Install a certificate > CA certificate."
