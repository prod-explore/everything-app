# evvapp-device

The EverythingApp device agent. It runs on one of your own computers, dials **out** to your EverythingApp server over a
single WebSocket and serves that machine's **shell**, **folders** and **browser** to the server as an MCP server. Nothing
listens on the machine; what the agent may do is decided by the config file on the machine, and every individual call is
approved in the app. Why it is built this way: `docs/adr/0017` to `0021`. Interfaces: `docs/devices.md`.

The tray app (`device/app`) runs this same program as a child process (`--stdio`). This README is about running it on its
own, e.g. on a server or a build box.

## Run it headless

Needs Node 22 and a system browser if you want the browser tools (Playwright never downloads one).

```sh
cd device/agent
npm ci
npm run build                      # -> dist/main.mjs; ship it together with node_modules

node dist/main.mjs pair --server https://evvapp.example.com --name "Build box"
# prints a code and opens the approval page; check the code matches, click Approve in the app

node dist/main.mjs run             # stays connected, reconnects by itself (1 s .. 60 s backoff)
```

`pair` saves `server` and `deviceName` into `config.json` and the device token into `<data-dir>/token` (mode 0600).
`EVVAPP_DEVICE_TOKEN` overrides the file. `run` exits with 1 when the device is not paired, 2 when the server revoked it
(4401) and 3 when another connection replaced it (4409), so a service manager does not respin a dead device.

```sh
node dist/main.mjs status          # what is configured and what was auto-detected, without connecting
node dist/main.mjs --help
```

Options for all commands: `--config <path>` (default `<data-dir>/config.json`) and `--data-dir <dir>`:
`%APPDATA%\evvapp-device` on Windows, `~/Library/Application Support/evvapp-device` on macOS,
`${XDG_CONFIG_HOME:-~/.config}/evvapp-device` on Linux.

## Config

`config.json` as specified in `docs/devices.md` ("Device config"). A missing file means: shell on, files and browser off.
`null` means auto-detect. Short version:

| Key | Meaning |
|---|---|
| `server`, `deviceName` | where to connect, the name shown in the app (1-40 characters) |
| `shell` | `enabled`, `path` (Windows: Git Bash, else `pwsh`, else `powershell.exe`; macOS/Linux: `$SHELL`, falling back to bash/zsh/sh), `cwd` (default: home) |
| `files` | `enabled`, `roots` (the only folders reachable; `~` allowed), `write` (without it the write tools do not exist) |
| `browser` | `enabled`, `mode` (`profile` = your real profile, needs that browser closed; `dedicated` = own profile in `<data-dir>/browser-profile`), `product` (`brave`/`chrome`/`edge`/`chromium`/`custom`), `executable`, `userDataDir`, `profileDirectory`, `allowPrivateNetwork` |

A capability that is switched on but cannot work (no folders, no browser binary found) is switched off with a warning
(`status` shows it), so the server never sees tools that cannot run. Chrome 136+ refuses automation on its default profile
folder: use `dedicated` there.

## Notes

- Shell sessions use pipes, not a PTY (ADR 0021): `cd` and variables persist, full-screen programs do not work, prompts are
  answered with `shell_send`. A timed-out command is interrupted like Ctrl-C (process group on POSIX, `taskkill /T` on
  Windows) and the session survives.
- File paths are resolved with `realpath` and must stay inside `files.roots`; symlinks that lead out are refused.
- The browser tools are `playwright-mcp`'s, imported as a library (`playwright-mcp/src/lib.ts`); the domain gate, injection
  handling and download rules are shared with the server browser.

## Develop

```sh
npm run typecheck
npm test            # bundles each test like the shipped agent and runs node:test; the browser test uses /usr/bin/google-chrome if present
npm run build
```

The test run sets `EVVAPP_DEVICE_TEST_HEADLESS=1` for the browser test only; a real device always opens a visible window.
