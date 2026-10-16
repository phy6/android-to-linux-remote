#!/usr/bin/env bash
# Generate the TLS material the daemon uses for the hotspot route.
#
# A browser only hands over the microphone in a secure context, and http:// on a
# LAN address is not one. Serving the app over https fixes that. Two levels are
# created:
#
#   ca.crt      a small local root CA (its key stays on this laptop)
#   taildeck.crt  the server certificate, signed by that CA
#
# The owner can tap through the https warning as before. The point of the CA is
# guests: iOS Safari will not open a wss:// socket to a *self-signed* cert even
# after the warning, but it will once the CA is installed and fully trusted.
# Export ca.crt to the guest (@see the /taildeck-ca.crt route the daemon serves).
#
# Regenerate whenever the laptop's hotspot address changes, since the address is
# baked into the certificate.

set -euo pipefail

OUT_DIR="${1:-$HOME/.config/taildeck/tls}"
DAYS="${TAILDECK_CERT_DAYS:-825}"
CA_DAYS="${TAILDECK_CA_DAYS:-3650}"

mkdir -p "$OUT_DIR"

# --- Collect names/addresses for the server SAN ---
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

# --- Root CA (reused if it already exists, so existing installs stay valid) ---
if [ ! -f "$OUT_DIR/ca.crt" ] || [ ! -f "$OUT_DIR/ca.key" ]; then
  openssl req -x509 -newkey rsa:4096 -sha256 -days "$CA_DAYS" -nodes \
    -keyout "$OUT_DIR/ca.key" \
    -out "$OUT_DIR/ca.crt" \
    -subj "/CN=TailDeck Local CA" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    2>/dev/null
  echo "Created a local CA at $OUT_DIR/ca.crt"
fi

# --- Server certificate signed by the CA ---
openssl genrsa -out "$OUT_DIR/taildeck.key" 2048 2>/dev/null
openssl req -new -key "$OUT_DIR/taildeck.key" -out "$OUT_DIR/taildeck.csr" -subj "/CN=TailDeck"

cat > "$OUT_DIR/san.ext" <<EXT
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=$san
EXT

openssl x509 -req -in "$OUT_DIR/taildeck.csr" \
  -CA "$OUT_DIR/ca.crt" -CAkey "$OUT_DIR/ca.key" -CAcreateserial \
  -out "$OUT_DIR/taildeck.crt" \
  -days "$DAYS" -sha256 -extfile "$OUT_DIR/san.ext" 2>/dev/null

rm -f "$OUT_DIR/taildeck.csr" "$OUT_DIR/san.ext"

chmod 600 "$OUT_DIR/taildeck.key" "$OUT_DIR/ca.key"
chmod 644 "$OUT_DIR/taildeck.crt" "$OUT_DIR/ca.crt"

echo "Certificate written to $OUT_DIR"
echo "  server valid for $DAYS days, CA for $CA_DAYS days"
echo "  names: $san"
echo
echo "Restart the daemon to pick it up:  systemctl --user restart taildeck.service"
echo "Owner: open  https://<laptop-ip>:8443/  and tap through the warning."
echo "Guest (iPhone): open  https://<laptop-ip>:8443/taildeck-ca.crt  to install the CA,"
echo "  then Settings > General > About > Certificate Trust Settings > enable full trust."
