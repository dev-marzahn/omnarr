# The vpn scenario's OpenVPN PKI: a CA, a server and a
# client certificate (P-256, 30 days), and the client config the test saves as
# an OpenVPN file. Runs once per volume, in a throwaway container of the pinned
# NZBGet image, the only image the e2e pins that ships `openssl`.
#
#   OVPN_SERVER_IP   the server's address on gluetun's network
set -eu
cd /ovpn
[ -f client.ovpn ] && exit 0
ec() { openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes "$@"; }
ec -x509 -keyout ca.key -out ca.crt -days 30 -subj /CN=omnarr-e2e-ca
ec -keyout server.key -out server.csr -subj /CN=server
printf 'extendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyAgreement\n' > server.ext
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 30 -extfile server.ext
ec -keyout client.key -out client.csr -subj /CN=client
printf 'extendedKeyUsage=clientAuth\n' > client.ext
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out client.crt -days 30 -extfile client.ext
# `tls-exit`, as gluetun adds for its built-in providers (PIA, ProtonVPN), but not to a custom file: a
# handshake that fails ends OpenVPN, as recorded in apps/worker/test/fixtures/gluetun/.
# `hand-window 10` (the default is 60 s) and the server's `keepalive 2 10` make that end come about 20 s
# after the block instead of about 2 minutes; the sequence is the recorded one.
{
  printf 'client\ndev tun\nproto udp\nremote %s 1194\nnobind\ntls-exit\nhand-window 10\nremote-cert-tls server\ncipher AES-256-GCM\n' "$OVPN_SERVER_IP"
  printf '<ca>\n'; cat ca.crt; printf '</ca>\n<cert>\n'; cat client.crt; printf '</cert>\n<key>\n'; cat client.key; printf '</key>\n'
} > client.ovpn.part
chmod 644 ./*
mv client.ovpn.part client.ovpn
