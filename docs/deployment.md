# Deploying the full stack

This page covers running EverythingApp with Docker Compose on a host you keep running (the stack's defaults are sized for
a Raspberry Pi), reaching it from other devices, letting sandboxes use GitHub, and backups. The quick start in the
[README](../README.md#run-the-full-stack) gets the stack up on one machine; everything here is what you add after that.

## What runs

| Service | Image | Holds | Networks |
|---|---|---|---|
| `everythingapp-web` | `cli/Dockerfile` (built from the repo root, bundles `web/`) | the SQLite database, `KEY_VAULT_SECRET` | `sandbox-internal`, `browser-egress` |
| `sandbox-supervisor` | `sandbox-supervisor/Dockerfile` | `/var/run/docker.sock` (the only service that does) | `sandbox-internal` |
| `sandbox-mcp` | `sandbox-mcp/Dockerfile` | nothing; calls the supervisor | `sandbox-internal` |
| `playwright-mcp` | `playwright-mcp/Dockerfile` | Chromium, ephemeral profiles, no volume | `browser-egress` |
| `git-proxy` | `git-proxy/Dockerfile` | proxy tokens in memory, the GitHub credential while in use | `sandbox-internal` |
| sandboxes (one per project or standalone chat) | `sandbox-supervisor/sandbox-image/Dockerfile`, tagged `SANDBOX_IMAGE` | a named workspace volume each | `ea-sandbox-egress` (bridge `br-ea-sandbox`, container-to-container traffic off) |

Every service port is published on `127.0.0.1` only. Data lives in the `everythingapp_web_data` volume (database,
`policy.json`, artifacts, backups) and in one `everythingapp-*` workspace volume per project.

## Secrets

Every secret in `.env` is generated, not typed: `openssl rand -hex 32`. Each service refuses to start with an empty value,
a placeholder, a value shorter than 24 characters or one with fewer than 8 distinct characters
(`ALLOW_WEAK_SECRETS=true` turns that into a warning, for local development only).

| Variable | Used by | What it protects |
|---|---|---|
| `SERVER_AUTH_TOKEN` | web | the HTTP API (bearer, for scripts) |
| `SERVER_PASSWORD` | web | the login form; falls back to `SERVER_AUTH_TOKEN` when empty |
| `KEY_VAULT_SECRET` | web | provider keys, connector tokens, the GitHub credential and the webhook URL, encrypted in the database. Changing it means entering those again |
| `SUPERVISOR_TOKEN` | supervisor, sandbox-mcp, web | the supervisor API (exec, files and volumes of every sandbox) |
| `MCP_API_KEY` | sandbox-mcp, web | the sandbox MCP endpoint |
| `PLAYWRIGHT_MCP_API_KEY` | playwright-mcp, web | the browser MCP endpoint and live view |
| `GIT_PROXY_ADMIN_TOKEN` | git-proxy, web | git-proxy's admin API and the orchestrator's `/internal/*` routes |

Keep `KEY_VAULT_SECRET` outside the machine as well (a password manager): it is not part of any backup.

## Building or pulling the images

Two ways, with the same compose file:

- **From source:** `docker compose up -d --build`, after building the sandbox image once with
  `docker build -t everything-sandbox:latest ./sandbox-supervisor/sandbox-image/`.
- **Published images:** the `Images` workflow builds every service for `linux/amd64` and `linux/arm64` on each push to
  `main` and publishes them as `ghcr.io/prod-explore/everythingapp-<service>` with the tags `latest` and `sha-<commit>`.
  `deploy/deploy.sh` pulls them (and the sandbox image, which it tags as `SANDBOX_IMAGE`), restarts the services, waits for
  their health checks and, when a service does not become healthy, puts back the image it ran before:

  ```sh
  deploy/deploy.sh                      # latest, every service
  deploy/deploy.sh sha-1a2b3c4          # a given build; also how you roll back by hand
  deploy/deploy.sh latest everythingapp-web
  ```

## Fence the internet-facing containers off your network

The browser container and the sandboxes may reach the public internet. They must not reach your LAN, the Docker host or
cloud-metadata addresses. The application checks this for every browser navigation and every `web_fetch`; the egress
guard does it again at the network layer, for anything that runs in a sandbox as well:

```sh
sudo deploy/egress-guard.sh apply     # DOCKER-USER chain + INPUT rule, idempotent
sudo deploy/egress-guard.sh status
DRY_RUN=1 deploy/egress-guard.sh apply   # print the iptables commands instead
```

It drops new connections from `br-ea-browser` and `br-ea-sandbox` to private and reserved IPv4 ranges and to the host
itself. `EGRESS_ALLOW="IP[:PORT] …"` adds exceptions (a NAS the browser may read, git-proxy, see below). To apply it at
boot, adjust the paths in `deploy/ea-egress-guard.service` and install it as a systemd unit. The guard is IPv4 only; if you
enabled IPv6 on these bridges, mirror the rules with `ip6tables`.

`sandbox-supervisor` creates the `br-ea-sandbox` bridge the first time it starts (Docker keeps it afterwards), so run
`apply` once the stack has been up.

## Let sandboxes use GitHub

Sandboxes are not on any network the other services share, so they reach git-proxy through a port published on the
sandbox bridge's gateway:

```sh
gw=$(docker network inspect ea-sandbox-egress -f '{{(index .IPAM.Config 0).Gateway}}')
# in .env
GIT_PROXY_BIND=$gw
GIT_PROXY_SANDBOX_URL=http://$gw:8080
# for the egress guard
sudo EGRESS_ALLOW="$gw:8080" deploy/egress-guard.sh apply
docker compose up -d git-proxy everythingapp-web
```

Then connect GitHub in *Settings → GitHub*: a GitHub App with device flow (`GITHUB_APP_CLIENT_ID` and
`GITHUB_APP_CLIENT_SECRET`, "Device Flow" enabled in the App) or a fine-grained personal access token. `GITHUB_PAT` in `.env` is
only git-proxy's fallback. The orchestrator gives each sandbox a short-lived proxy token and rewrites `https://github.com/`
(and SSH remotes) to git-proxy inside the sandbox; every push from a sandbox becomes an approval card (a push you
click yourself in Source Control does not ask again). Details: [git-proxy/README.md](../git-proxy/README.md).

## Reach it from other devices

The stack listens on `127.0.0.1:3000`. Put a reverse proxy with TLS in front of it; `deploy/nginx-everythingapp.conf.example`
is a starting config for nginx and certbot. Whatever proxy you use, keep what that file does:

- `/internal/` must not be reachable from outside (it hands out GitHub tokens to git-proxy, guarded by one token);
- the chat stream (`/api/conversations/<id>/stream`) is server-sent events: no buffering, a long read timeout;
- `/api/liveview` is a WebSocket: forward the `Upgrade` headers;
- the body limit must allow image attachments (they travel as base64 in JSON, up to about 8 MB each);
- the app trusts exactly one proxy hop (`X-Forwarded-For`, `X-Forwarded-Proto`) for the login limiter and the `Secure` cookie flag.

Set a `SERVER_PASSWORD` of its own on any host reachable from a network. If the proxy runs in another compose project,
`deploy/docker-compose.override.example.yml` joins the web container to its network.

## Backups and restore

```sh
deploy/backup.sh /srv/backups/everythingapp 14     # online backup, integrity-checked, keeps the newest 14
```

The backup is a consistent copy made with SQLite's online backup API while the server runs. It contains every chat, ghost
chats included, and the provider keys encrypted with `KEY_VAULT_SECRET`, which is not in it. Restore:

```sh
docker compose stop everythingapp-web
docker compose run --rm --no-deps -v "$PWD/backup.db:/restore.db:ro" everythingapp-web \
    node dist/tools/db-backup.js restore /restore.db --yes
docker compose start everythingapp-web
```

`restore` refuses damaged files, files that are not EverythingApp databases and backups from a newer schema, and keeps the
replaced database next to it. Workspace volumes are not part of this backup; back them up with your usual Docker volume
tooling if they hold work that is not pushed anywhere.

Schema changes are numbered migrations stamped in `PRAGMA user_version`; before the first pending migration the server
writes a copy of the database next to it (`*.pre-v<N>.bak`). Usage, approval-audit and replay rows older than
`RETENTION_MONTHS` (default 12) are deleted daily; chats are never deleted automatically. See
[ADR 0014](adr/0014-data-lifecycle.md).

## Sizing

The defaults assume a small machine shared with other services: at most `MAX_RUNNING_SANDBOXES=2` sandboxes run at once
(an idle one is stopped after 30 minutes, never deleted), each with 512 MB and one CPU, a 2 GB workspace quota per
project, and four browser sessions in a container limited to 2 GB. Raise them in `.env`; every variable is listed with its
default in `.env.example` and `docker-compose.yml`.
