#!/usr/bin/env bash
# Generate the self-signed certificate the daemon uses for the hotspot route.
#
# A browser only hands over the microphone when the page is a secure context,
# and http:// on a LAN address is not one. Serving the same app over https on
# the hotspot turns that on. The certificate is self-signed, so the phone shows
# a warning once: Advanced, then Proceed. Chrome remembers it per host:port.
#
# Regenerate whenever the laptop's hotspot address changes, since the address
# is baked into the certificate.

set -euo pipefail

OUT_DIR="${1:-$HOME/.config/taildeck/tls}"
DAYS="${TAILDECK_CERT_DAYS:-3650}"

mkdir -p "$OUT_DIR"

names=()
ts_name="$(tailscale status --json 2>/dev/null \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)"
[ -n "$ts_name" ] && names+=("DNS:$ts_name")
names+=("DNS:localhost" "DNS:taildeck.local")

ips=()
ips+=("IP:127.0.0.1")
while read -r ip; do
  [ -n "$ip" ] && ips+=("IP:$ip")
done < <(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' || true)

san="$(IFS=,; echo "${names[*]},${ips[*]}")"

openssl req -x509 -newkey rsa:2048 -sha256 -days "$DAYS" -nodes \
  -keyout "$OUT_DIR/taildeck.key" \
  -out "$OUT_DIR/taildeck.crt" \
  -subj "/CN=TailDeck" \
  -addext "subjectAltName=$san" \
  -addext "keyUsage=digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=serverAuth" \
  2>/dev/null

chmod 600 "$OUT_DIR/taildeck.key"
chmod 644 "$OUT_DIR/taildeck.crt"

echo "Certificate written to $OUT_DIR"
echo "  valid for $DAYS days"
echo "  names: $san"
echo
echo "Restart the daemon to pick it up:  systemctl --user restart taildeck.service"
echo "Then open on the phone:  https://<laptop-ip>:8443/  and tap through the warning."
