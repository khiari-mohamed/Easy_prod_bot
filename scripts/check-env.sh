#!/bin/sh
# Pre-flight check for .env.prod. Run from the repo root:  sh scripts/check-env.sh [file]
# Fixes nothing silently: it tells you exactly what to change. Never prints secret values.
F="${1:-.env.prod}"
fail=0
[ -f "$F" ] || { echo "ERROR: $F not found (cp .env.prod.example .env.prod)"; exit 1; }

if grep -q "$(printf '\r')" "$F"; then
  echo "ERROR: $F has Windows line endings (CRLF). Fix with:  sed -i 's/\r$//' $F"
  fail=1
fi

get() { grep -E "^$1=" "$F" | tail -n1 | cut -d= -f2- | tr -d '\r'; }

for k in DOMAIN POSTGRES_PASSWORD JWT_SECRET TOKEN_ENCRYPTION_KEY ADMIN_EMAIL ADMIN_PASSWORD META_APP_ID META_APP_SECRET; do
  [ -n "$(get $k)" ] || { echo "ERROR: $k is empty"; fail=1; }
done

[ "$(get JWT_SECRET | wc -c)" -ge 33 ] || { echo "ERROR: JWT_SECRET must be at least 32 characters"; fail=1; }
get TOKEN_ENCRYPTION_KEY | grep -Eq '^[0-9a-fA-F]{64}$' || { echo "ERROR: TOKEN_ENCRYPTION_KEY must be exactly 64 hex characters (openssl rand -hex 32)"; fail=1; }
[ "$(get ADMIN_PASSWORD | wc -c)" -ge 13 ] || { echo "ERROR: ADMIN_PASSWORD must be at least 12 characters"; fail=1; }
case "$(get DOMAIN)" in http*|*/*) echo "ERROR: DOMAIN must be a bare host name (no https://, no path)"; fail=1;; esac

[ "$fail" = 0 ] && echo "OK: $F looks valid" || exit 1
