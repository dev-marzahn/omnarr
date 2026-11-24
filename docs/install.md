# Installing omnarr

**Your install's state lives in Docker volumes, not in the install folder.** The folder holds only the compose files, `.env`, `vpn/`, `definitions/`, `backups/` and, by default, `data/`. Copying the folder doesn't back up your library, your accounts or the clients' settings. See [Backups](#backups) for what to copy and how.

## Requirements

- Docker Engine and Docker Compose 2.24 or later.
- For the VPN layout: `/dev/net/tun` on the host.
- One filesystem for all media (`OMNARR_DATA_DIR`), so imports can hard-link and rename instead of copying.

## First start

1. Put `compose.yml` and `compose.vpn.yml` from a release into an empty folder.
2. Run `docker compose up -d`. The `setup` container runs first on every `up`, generates the secrets it needs once, creates the media tree, and exits.
3. Get the setup password: `docker compose logs setup` shows it once, in the line `[setup] Setup password (needed once, to create the admin account): …`. If the logs are gone, `docker compose run --rm setup show-setup-password` prints it again. To choose it yourself, set `OMNARR_SETUP_PASSWORD` in `.env` before the first start.
4. Open `http://<this host>:3000`. First run asks for the setup password, creates the admin account (you sign in to omnarr and to Jellyfin with it), and walks you through the indexer, the Usenet provider, torrents, your devices and the metadata key. The setup password stops working once the admin exists.

## Configuration

Every setting is optional. Save the release's `env.example` in the install folder as `.env` and uncomment what you change, then run `docker compose up -d`. An empty value counts as unset.

| Variable | Default | What it does |
| --- | --- | --- |
| `OMNARR_WEB_URL`, `OMNARR_CONVEX_URL`, `OMNARR_CONVEX_SITE_URL` | unset | The public URLs, behind your HTTPS proxy. Set all three or none. |
| `OMNARR_WEB_PORT`, `OMNARR_CONVEX_PORT`, `OMNARR_CONVEX_SITE_PORT`, `OMNARR_JELLYFIN_PORT` | 3000, 3210, 3211, 8096 | The published ports. |
| `OMNARR_JELLYFIN_URL` | unset | Jellyfin as your devices reach it, for "Open in Jellyfin". |
| `OMNARR_BIND_ADDRESS` | `0.0.0.0` | Where the web, Convex and Jellyfin ports listen; `127.0.0.1` behind a proxy on the same host. |
| `OMNARR_PEER_PORT` | 6881 | qBittorrent's peer port (direct layout). |
| `OMNARR_SETUP_PASSWORD` | unset: generated | The setup password first run asks for. |
| `OMNARR_DATA_DIR` | `./data` | The media folder. |
| `PUID`, `PGID` | 1000, 1000 | The owner of the media folder, and the user the worker, the clients and Jellyfin run as. |
| `OMNARR_UPDATE_CHECK` | `on` | The daily release check. |
| `TMDB_API_TOKEN` | unset: built-in | Your own TMDB Read Access Token. |
| `COMPOSE_FILE` | unset | `compose.yml:compose.vpn.yml` for the VPN layout. |
| `OMNARR_DEFINITIONS_URL` | `https://indexers.prowlarr.com/master` | Where the worker downloads Prowlarr's site definitions, once a day (`<url>/12/package.zip`). Another server with the same layout works too. |
| `CONVEX_RELEASE_SNAPSHOT` | unset | Restore and downgrade only. |

**A configuration error** keeps the backend from starting, and the web app and the worker wait for it. `docker compose logs backend` names the variable and the rule, for example `[omnarr] pre-push failed: OMNARR_CONVEX_URL is not an http(s) URL without a path`. An `OMNARR_CONVEX_URL` or `OMNARR_CONVEX_SITE_URL` that isn't `http(s)` is refused by the Convex backend itself, whose line reads `Origin url should start with https:// or http://`. Fix `.env` and run `docker compose up -d`.

**Existing media** goes under `library/series` (series and anime) and `library/movies` in the media folder, readable and writable by `PUID:PGID`. `setup` gives only the tree's folders that owner, never your files. If the owner is wrong, omnarr raises "A storage folder can't be used" with the folder; `ls -ln <folder>` shows the owner.

**Weak hardware.** The backend allows each function 5 seconds instead of Convex's 1 second (`DATABASE_UDF_USER_TIMEOUT_SECONDS=5` in `compose.yml`), so a NAS or a busy host doesn't fail functions that are merely slow. A still slower host can raise it there.

**Site definitions.** Settings › Indexers › Add indexer › Site › Other site lists the sites of Prowlarr's definitions, which the worker downloads at its first start and once a day; System › Site definitions shows the last download and has "Check for definition updates". omnarr ships no definition file. omnarr runs the public sites that need no FlareSolverr; the others are listed with the reason it can't run them. **Your own definitions** go in the `definitions` folder of the install, as Cardigann `.yml` files; a file with the `id` of one of Prowlarr's replaces it. `setup` creates the folder, empty and owned by `PUID:PGID`, and leaves its files alone. The worker reads the folder at each definitions download.

**The VPN layout.** Choose a VPN in Settings › Downloads, add `COMPOSE_FILE=compose.yml:compose.vpn.yml` to `.env`, and run `docker compose up -d`. To recreate gluetun, recreate qBittorrent with it, or qBittorrent keeps a dead network:

```sh
docker compose up -d --force-recreate gluetun qbittorrent
```

## Remote access

omnarr supports a public URL only behind your own HTTPS reverse proxy. The platform doesn't obtain certificates.

1. Set all three platform URLs, all `https`. An https page can't open `ws://` or call `http://`.
2. Forward WebSocket upgrades (`Upgrade`, `Connection`) on the Convex URL, with no idle timeout under 60 seconds.
3. Pass the `Authorization`, `Better-Auth-Cookie` and `Set-Better-Auth-Cookie` headers unchanged, and don't add your own CORS headers on the auth URL.
4. With the proxy on the same host, set `OMNARR_BIND_ADDRESS=127.0.0.1`, so the bare ports aren't on your LAN. With a web URL set, sign-in works only at that URL.
5. Get the setup password before the first sign-in (see [First start](#first-start)).
6. Jellyfin's remote access stays on. To reach Jellyfin from outside, give it its own proxy route and set `OMNARR_JELLYFIN_URL`. Add that route only after first run shows "Setup complete": until then Jellyfin's own start-up wizard is open.

Without a web URL, omnarr accepts sign-in from any address on the web port, which is right for a LAN.

### Coolify and other compose front ends

- Coolify deploys with `docker compose`, so the start order holds. Mark `setup` with `exclude_from_hc: true`, so the exited container doesn't count against the stack's health.
- Coolify's log view shows `setup`'s output, including the generated setup password.
- If a front end doesn't wait for `setup` to finish, start it first: `docker compose up -d setup`, then `docker compose up -d`.
- Coolify prefixes volume names with the resource's UUID, so they aren't `omnarr_<name>`. Find them with `docker volume ls` or Coolify's "Show Deployable Compose", and use them in the commands below. Run the commands on the Coolify server. `./backups` is relative to the folder Coolify deploys from.

## Upgrades

1. Read the release notes. If their first line asks for it, back up Jellyfin's config volume first ([Backups](#backups)).
2. Replace `compose.yml` and `compose.vpn.yml` with the new release's. Keep `.env`.
3. Run `docker compose pull && docker compose up -d`.

The web app is unreachable until the backend has applied the release; there is no maintenance page. Any v1.x release upgrades to the latest. The files' pins are the tested set: you may pin other versions, at your own risk. A downgrade is a restore of the backup taken before the upgrade.

## Backups

| What | Where | Back up | Why |
| --- | --- | --- | --- |
| Compose files and `.env` | the install folder | yes | The pins and your settings. |
| Convex data | `omnarr_convex-data` | yes | The library, settings, accounts and the backend's credentials. |
| Backend secrets | `omnarr_backend-secrets` | yes, always with the Convex data | They encrypt Better Auth's keys, and hold the worker token and the generated setup password. |
| Client secrets | `omnarr_secrets` | yes | They must match the clients' config files. |
| NZBGet, qBittorrent config | `omnarr_nzbget-config`, `omnarr_qbittorrent-config` | yes | qBittorrent's resume data for seeding torrents. |
| Gluetun | `omnarr_gluetun-data`, `omnarr_gluetun-auth` | optional | The forwarded port and the server list. |
| VPN files | `./vpn` | yes | Written from omnarr, but needed until the worker's next pass. |
| Your definitions | `./definitions` | yes, if you added any | The downloaded ones are in the Convex data. |
| Jellyfin | `omnarr_jellyfin-config` | yes, and always before a Jellyfin major upgrade | Users, play state and the API key. `omnarr_jellyfin-cache` isn't needed. |
| Media | `OMNARR_DATA_DIR` | your choice | Large. The library can be downloaded again; kept originals can't. |
| Exports | `./backups` | copy off the host, encrypted | They hold secrets in plain text. |

**Backing up**, in the install folder:

```sh
docker compose stop
for v in convex-data backend-secrets secrets nzbget-config qbittorrent-config gluetun-data gluetun-auth jellyfin-config; do
  docker run --rm -v omnarr_$v:/v:ro -v "$PWD/volume-backups":/out <the pinned omnarr-worker image> tar -C /v -czf /out/$v.tgz .
done
docker compose up -d
```

Stopping first keeps the Convex and client files consistent.

**Restoring on a new host:** copy the install folder, the media and `volume-backups/`, then:

```sh
for v in convex-data backend-secrets secrets nzbget-config qbittorrent-config gluetun-data gluetun-auth jellyfin-config; do
  docker volume create omnarr_$v
  docker run --rm -v omnarr_$v:/v -v "$PWD/volume-backups":/in <the pinned omnarr-worker image> tar -C /v -xzf /in/$v.tgz
done
docker compose up -d
```

**Restoring Convex from an export** in `./backups`, for a downgrade or a lost Convex volume:

1. `docker compose down`
2. Copy the current data aside: `docker volume create omnarr_convex-data-before-restore`, then `docker run --rm -v omnarr_convex-data:/from:ro -v omnarr_convex-data-before-restore:/to <the pinned omnarr-worker image> cp -a /from/. /to/`
3. `docker volume rm omnarr_convex-data`
4. Put back the compose files of the export's release, if it differs. If that crosses a Jellyfin major version, restore `omnarr_jellyfin-config` from the backup taken before that upgrade too.
5. Set `CONVEX_RELEASE_SNAPSHOT=/backups/<file>.zip` in `.env`, run `docker compose up -d`, then remove the line.
6. Once the install works, `docker volume rm omnarr_convex-data-before-restore`.

After a restore, files imported after the export are still in the media folder, and the next scan lists them as untracked. Client items added after it are cleaned up as orphans.

## Forgotten password

On the host, in the install folder:

```sh
docker compose exec backend reset-admin-password
```

It asks for the new password twice, signs out every omnarr session, and gives Jellyfin the same password. For scripts: `docker compose exec -T backend reset-admin-password --password-stdin`. Changing the password in the app (user menu › Password) also signs out your other sessions, and Jellyfin signs you out on every device.

## Outside calls

The backend calls TMDB, thexem.info, raw.githubusercontent.com (Anime-Lists) and your indexers; once a day it checks GitHub for a new release, which `OMNARR_UPDATE_CHECK=off` turns off. NZBGet, qBittorrent and gluetun connect to your providers; gluetun refreshes its providers' server lists daily. None of these calls sends an instance identifier, and no image sends telemetry.

## Accepted risks

- Before the admin exists, someone who repeats wrong setup passwords can keep admin creation locked for 15 minutes at a time. Take the proxy route away until the admin exists.
- Until first run's Jellyfin steps are done, Jellyfin's start-up wizard is open on its port. Add Jellyfin's proxy route only after "Setup complete".
- Without `OMNARR_WEB_URL`, a page served from another host on the web port could sign your browser into an account of its choosing. There is only one account; setting the URL removes the risk.
- Exports in `./backups` hold your secrets in plain text. Keep copies encrypted.
- Codec patents (H.264, HEVC, AAC) aren't a copyright question. You are responsible for any patent licensing your jurisdiction requires.
