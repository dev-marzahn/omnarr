# The vpn scenario's OpenVPN server, in the pinned gluetun
# image, which ships OpenVPN 2.6 and iptables. UDP 1194, `keepalive 2 10` (it
# pushes `ping 2` and `ping-restart 10`, where PIA pushes 60: the e2e sees a
# blocked server in about 10 s instead of a minute), the PKI from pki.sh. Its
# peers' traffic is forwarded, masqueraded, to the web seed's network only
# (OVPN_FAR_SUBNET), as the WireGuard server's is, so nothing in the tunnel
# reaches the internet. e2e/stack.ts blocks and unblocks the server with
# iptables, as blocking PIA's servers did on a real install.
set -eu
mkdir -p /dev/net
[ -c /dev/net/tun ] || mknod /dev/net/tun c 10 200
iptables -A FORWARD -i tun0 -d "$OVPN_FAR_SUBNET" -j ACCEPT
iptables -A FORWARD -o tun0 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A FORWARD -j DROP
iptables -t nat -A POSTROUTING -s 10.8.0.0/24 -d "$OVPN_FAR_SUBNET" -j MASQUERADE
exec openvpn2.6 --port 1194 --proto udp --dev tun --topology subnet --server 10.8.0.0 255.255.255.0 \
  --ca /ovpn/ca.crt --cert /ovpn/server.crt --key /ovpn/server.key --dh none \
  --keepalive 2 10 --data-ciphers AES-256-GCM --push 'redirect-gateway def1' --verb 3
