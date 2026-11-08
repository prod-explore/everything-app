# Devices — contract

The interfaces between the three parts of the device bridge: the orchestrator (`cli/`), the device agent (`device/agent/`) and the tray app (`device/app/`). Decisions and their reasons: ADR 0017–0021. This file is the reference both sides are built and tested against.

## Names

| Thing | Format |
|---|---|
| device id | 16 lowercase hex |
| slug | from the name: lowercase, `[a-z0-9-]`, 1–24 chars, unique (suffix `-2`, `-3`…) |
| connection name | `device-<slug>` (so tools are `device-<slug>__<tool>`) |
| user code | `XXXX-XXXX`, alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` |
| device code / device token | 32 random bytes, base64url (43 chars) |

## REST (orchestrator)

Unauthenticated (rate-limited: 10 starts/min/IP, ≤ 20 pending pairings):

```
POST /api/devices/pair/start   { name: string(1..40), platform: "windows"|"macos"|"linux", agentVersion: string(1..32) }
  200 { deviceCode, userCode, verificationPath: "/devices/pair?code=XXXX-XXXX", expiresIn: 600, interval: 2 }
POST /api/devices/pair/poll    { deviceCode }
  200 { status: "pending" }
  200 { status: "approved", deviceId, deviceToken, connectionName }      ← exactly once; the pairing is then gone
  410 { status: "denied" | "expired" }
```

Authenticated (session cookie or bearer, like the rest of `/api`):

```
GET    /api/devices/pair/:userCode          200 { userCode, name, platform, agentVersion, ip, createdAt, expiresAt } | 404
POST   /api/devices/pair/:userCode/approve  { name?: string }  200 { deviceId }
POST   /api/devices/pair/:userCode/deny     200 {}
GET    /api/devices                         200 { devices: DeviceInfo[] }
PATCH  /api/devices/:id                     { name?, policy?: Partial<DevicePolicy> }  200 DeviceInfo
DELETE /api/devices/:id                     200 {}   (revoke: socket closed 4401, tools removed, grants deleted)
```

```ts
type DevicePolicy = { shell: 'allowlist' | 'strict' | 'auto'; filesWrite: 'ask' | 'auto'; browserAct: 'ask' | 'auto' };
// defaults: { shell: 'allowlist', filesWrite: 'ask', browserAct: 'ask' }

type DeviceInfo = {
  id: string; name: string; connectionName: string;
  platform: 'windows' | 'macos' | 'linux'; agentVersion: string;
  online: boolean; connectedAt: string | null; lastSeenAt: string | null; createdAt: string;
  policy: DevicePolicy;
  report: DeviceReport | null;   // last evvapp://device/info, null before first connect
  tools: string[];               // real tool names currently exposed (empty when offline)
};
```

## WebSocket

`GET /api/devices/connect` with `Authorization: Bearer <deviceToken>`; anything else is refused before the upgrade (401). Text frames only, one JSON-RPC 2.0 message per frame, max 16 MiB. The server is the MCP **client**: it sends `initialize` first.

Close codes: `4401` token revoked/invalid (device stops retrying, state `revoked`), `4409` replaced by a newer connection of the same device (stops retrying, state `replaced`), `1001` server shutting down (retry). Server pings every 25 s, terminates after 60 s without a pong. Device reconnect: 1 s doubling to 60 s, ±20 % jitter, reset after 60 s connected.

### Device info resource

`evvapp://device/info` (`application/json`), read by the server after `initialize`:

```ts
type DeviceReport = {
  name: string; platform: 'windows' | 'macos' | 'linux'; arch: string; hostname: string; agentVersion: string;
  shell:   { enabled: boolean; kind: 'posix' | 'powershell'; path: string } ;
  files:   { enabled: boolean; roots: string[]; write: boolean };
  browser: { enabled: boolean; mode: 'profile' | 'dedicated'; product: 'brave' | 'chrome' | 'edge' | 'chromium' | 'custom'; executable: string | null };
};
```

## Device tools

Exposed only when their capability is on. Tools whose name starts with `_` are internal: the server calls them, `DeviceConnection.listTools()` hides them from models. `_conversation_id` is injected by the orchestrator into every `shell_*` and `browser_*` call (never offered to the model).

| Tool | Input | Approval (ADR 0019) |
|---|---|---|
| `shell_run` | `command`, `session?` (`[A-Za-z0-9_-]{1,32}`, default `main`), `cwd?` (new session only), `timeout_s?` (1–600, default 120), `background?` | command policy, device mode |
| `shell_send` | `session`, `input` (written to stdin + `\n`) | command policy on `input` |
| `shell_read` | `session`, `max_chars?` | none |
| `shell_list` | — | none |
| `shell_close` | `session`, `interrupt_only?` | none |
| `fs_list` | `path`, `depth?` (1–4) | none |
| `fs_read` | `path`, `offset?` (line), `limit?` (lines); images (png/jpeg/gif/webp ≤ 5 MB) come back as image content | none |
| `fs_search` | `path`, `glob?`, `contains?`, `max_results?` | none |
| `fs_write` | `path`, `content` | `filesWrite` |
| `fs_edit` | `path`, `old_string`, `new_string`, `replace_all?` | `filesWrite` |
| `fs_mkdir` | `path` | `filesWrite` |
| `_fs_read_b64` | `path` → `{ name, size, base64 }` (≤ 12 MB: base64 must fit one 16 MiB frame) | internal |
| `_fs_write_b64` | `path`, `base64`, `overwrite` (always sent; refuse an existing file unless true) | internal |
| `browser_open` … `browser_close` | as in playwright-mcp | domain gate; `browser_act` → `browserAct` |

Shell sessions are per `(conversation, session)`: at most 8 per device, closed after 30 min idle. Output per call is capped at 30 000 chars (head and tail kept). A command that times out is interrupted; the session survives. `background: true` starts the command in its own session (named by `session`) and returns at once; `shell_read` collects its output.

The server-side virtual tool `device_transfer` (`from`, `to`, each `device-<slug>:<path>` or `workspace:<path>`) copies a file between a device and the chat's sandbox workspace through `_fs_read_b64` / `_fs_write_b64` and the workspace write path. Approval: `filesWrite` of the target device; into the workspace needs none (ADR 0010). A copy the device's own settings rule out (files off, or read-only as a target) is refused before any card is shown.

## Device config (`config.json` in the app's config dir)

```json
{
  "server": "https://evvapp.example.com",
  "deviceName": "PC",
  "shell":   { "enabled": true, "path": null, "cwd": null },
  "files":   { "enabled": false, "roots": [], "write": false },
  "browser": { "enabled": false, "mode": "profile", "product": "brave", "executable": null,
               "userDataDir": null, "profileDirectory": "Default", "allowPrivateNetwork": true }
}
```

`null` = auto-detect. Windows: `shell.path` prefers Git Bash, then `pwsh`, then `powershell.exe`; macOS `$SHELL` or `/bin/zsh`; Linux `$SHELL` or `/bin/bash`. Browser user-data dirs default to the product's standard location; `dedicated` mode uses `<dataDir>/browser-profile`.

## Tray ↔ agent (stdio, one JSON object per line)

Tray → agent:
```
{"type":"start","configPath":"…","dataDir":"…","token":"…"|null}   first line, always
{"type":"config-changed"}       re-read config, reconnect
{"type":"pair"}                 start pairing with config.server / config.deviceName
{"type":"pause"} {"type":"resume"} {"type":"unpair"} {"type":"shutdown"}
```

Agent → tray:
```
{"type":"status","state":"unpaired"|"pairing"|"connecting"|"online"|"offline"|"paused"|"revoked"|"replaced"|"error","detail"?:string}
{"type":"pairing","userCode":"XXXX-XXXX","url":"https://…/devices/pair?code=XXXX-XXXX"}   tray opens the URL
{"type":"paired","token":"…","deviceId":"…"}   tray stores the token in the credential store
{"type":"unpaired"}                            tray deletes the stored token
{"type":"activity","tool":"shell_run","summary":"git status"}
{"type":"log","level":"info"|"warn"|"error","message":"…"}
```

Headless: `evvapp-device pair --server <url> --name <name> [--config <path>] [--data-dir <dir>]`, `evvapp-device run [--config …] [--data-dir …]`, `evvapp-device status`. Token file: `<dataDir>/token` (mode 0600).
