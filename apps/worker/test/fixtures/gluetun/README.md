# Gluetun fixtures

What `qmcgaw/gluetun:v3.41.3` answered while its OpenVPN server went away, for `vpnMonitor.test.ts`.

## Recorded

Both files are a client's readings every 5 s, on 2026-11-18, of `GET /v1/vpn/status` (`status`), the health server's `GET /` (`health`, its HTTP status) and `GET /v1/publicip/ip` (`publicIp`, `""` for none). `GET /v1/portforward` answered `0` throughout: the custom provider forwards no port.

The setup, a throwaway compose project on Docker Desktop:

- an OpenVPN 2.6 server (Alpine's `openvpn`, UDP 1194, `keepalive 10 60`, `push "redirect-gateway def1"`, an EC PKI made at start) on gluetun's network and on an internal network behind it;
- on that internal network, a web server answering `/json` in echoip's shape, which gluetun used as its only public-IP API (`PUBLICIP_API=echoip#http://…`) and as its health targets (`HEALTH_TARGET_ADDRESSES`, `HEALTH_ICMP_TARGET_IPS`), as the e2e does; `DNS_SERVER=off`;
- gluetun with `VPN_SERVICE_PROVIDER=custom`, `VPN_TYPE=openvpn` and the server's client config.

The server was made unreachable with `iptables … -j DROP` inside its container.

| File                                   | Client config                                                                                            | Blocked                           | Unblocked | What it shows                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `openvpn-dead-server.json`             | with `tls-exit`, which gluetun adds for every built-in provider (PIA, ProtonVPN), not for the custom one | 21:29:17, both directions         | 21:40:23  | OpenVPN's `ping-restart` fired after 60 s, its new handshake failed 60 s later and `tls-exit` ended it before gluetun's health check had failed. From then on: `running` for 60 s, `crashed` for 15 s, and again; the health server stays at its last result, 200; the public IP is cleared at the first crash and stays empty until the tunnel is up again (2 s after the unblock). |
| `openvpn-dead-server-no-tls-exit.json` | without `tls-exit`                                                                                       | 21:24:19, the server's input only | 21:27:59  | OpenVPN restarts in its own process and never exits, so the status stays `running`; gluetun's health check fails after 2 min 9 s, the health server answers 500 and the public IP is cleared.                                                                                                                                                                                        |

Why, from gluetun's source at `v3.41.3`: the health server's result is set only by the health checker, which runs between "tunnel up" and the VPN process's end (`internal/vpn/tunnelup.go`); a crash stops the checker without clearing the result. A crash or a stop clears the public IP (`internal/vpn/cleanup.go`), which is looked up again only after the next "tunnel up".
