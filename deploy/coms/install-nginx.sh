#!/usr/bin/env bash
# Adds https://coms.kw.ac.kr/phonemote/ to nginx, and nothing else.
#
#   sudo bash ~/apps/phonemote/deploy/coms/install-nginx.sh
#
# Backs up coms.conf the way this server always has (coms.conf.bak-<what>-<when>),
# installs the snippet, adds one include line beside the existing coms-companion
# include, and reloads only if `nginx -t` passes. If it does not, the backup is
# put back and nginx is left exactly as it was.
set -euo pipefail

CONF=/etc/nginx/conf.d/coms.conf
SNIPPET=/etc/nginx/snippets/phonemote.conf
ANCHOR='include /etc/nginx/snippets/coms-companion.conf;'
HERE="$(cd "$(dirname "$0")" && pwd)"

[ "$(id -u)" -eq 0 ] || { echo "Run it with sudo." >&2; exit 1; }
grep -qF "$ANCHOR" "$CONF" || { echo "Could not find the coms-companion include in $CONF; nothing changed." >&2; exit 1; }

backup="$CONF.bak-phonemote-$(date +%Y%m%d%H%M%S)"
cp -p "$CONF" "$backup"
install -m 644 "$HERE/nginx-phonemote.conf" "$SNIPPET"

if ! grep -qF "include $SNIPPET;" "$CONF"; then
  awk -v anchor="$ANCHOR" -v line="    include $SNIPPET;" \
    '{ print } index($0, anchor) { print line }' "$CONF" > "$CONF.phonemote-tmp"
  cat "$CONF.phonemote-tmp" > "$CONF"
  rm -f "$CONF.phonemote-tmp"
fi

if nginx -t; then
  systemctl reload nginx
  echo "Done: https://coms.kw.ac.kr/phonemote/  (backup: $backup)"
else
  cp -p "$backup" "$CONF"
  rm -f "$SNIPPET"
  nginx -t && echo "nginx -t failed, so everything was put back as it was." >&2
  exit 1
fi
