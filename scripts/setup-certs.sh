#!/usr/bin/env bash
#
# Generates the local development certificate used by all three PhoneMote
# processes. Run it once per machine, and again whenever your LAN IP changes.
#
#   pnpm setup:certs
#
# The phone must trust mkcert's root CA as well — see README.md.
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

echo
echo "Certificate written to certs/ for:"
echo "$hosts" | sed 's/^/  /'
echo
echo "Root CA for the phone (copy this file to the phone and install it as a CA certificate):"
echo "  $(mkcert -CAROOT)/rootCA.pem"
