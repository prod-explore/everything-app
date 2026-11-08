# EverythingApp Device (tray app)

Tauri v2 tray app that hosts the device agent (`device/agent`) as a sidecar. It owns everything native: tray menu, settings window, autostart, single instance, the device token in the OS credential store, opening the pairing page. All tool work happens in the Node agent. Design: [ADR 0021](../../docs/adr/0021-device-app.md); wire protocol: [docs/devices.md](../../docs/devices.md) ("Device config", "Tray <-> agent").

```
device/app/
  src-tauri/   Rust: tray, supervision of the agent, config, credential store, Tauri commands
  ui/          settings window: plain HTML/CSS/JS, no framework, no build step (withGlobalTauri)
  icons/       source.png (the logo), app/ (generated app icons), tray/ (generated tray icons)
  scripts/     fetch-node.mjs, stage-agent.mjs, gen-tray-icons.py
```

## How it works

- The app starts with no window. Its menu shows the state, the last activity, Pair / Pause / Resume, the Terminal / Files / Browser switches (they edit `config.json` and send `config-changed`), Settings, Open EverythingApp, Start at login and Quit.
- It runs `evvapp-node <resources>/agent/dist/main.mjs --stdio`, writes the `start` line (config path, data dir, token from the credential store) and reads JSON lines from stdout. Stderr goes to `agent.log` in the app log dir (rotated at 1 MiB, 3 files kept).
- A crashed agent is restarted after 1 s, 2 s, 4 s ... up to 30 s; five crashes within two minutes put the tray in the `error` state (Settings and Quit still work; saving the server URL starts it again). On Quit the app sends `shutdown`, waits 5 s and kills the process.
- The agent is not started while `server` is empty (the tray says "Set the server URL in Settings"; the settings window opens on first run).
- The token lives in the credential store under service `everythingapp-device`, account = server `host[:port]`. It is stored on `paired`, deleted on `unpaired` and `revoked`, and passed to the agent only on stdin. Changing the server restarts the agent so a token is never sent to another host.
- The pairing URL from the agent is opened only if it is on the configured server's host.
- Files (per user): config `config.json` in the app config dir, agent data (token file for headless use, browser profile) in the app data dir, logs in the app log dir. Identifier: `app.everythingapp.device`.
  - Windows: `%APPDATA%\app.everythingapp.device`, logs under `%LOCALAPPDATA%\app.everythingapp.device\logs`
  - macOS: `~/Library/Application Support/app.everythingapp.device`, logs in `~/Library/Logs/app.everythingapp.device`
  - Linux: `~/.config/app.everythingapp.device`, `~/.local/share/app.everythingapp.device`

## Build prerequisites

All platforms: Rust (stable, >= 1.82), Node 22 (also used to run the helper scripts), `npm ci` in this folder (installs the Tauri CLI).

| OS | Also needed |
|---|---|
| Linux (Debian/Ubuntu) | `sudo apt-get install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev libdbus-1-dev pkg-config build-essential` (the tray needs a desktop with an appindicator/StatusNotifier host; GNOME needs the AppIndicator extension) |
| macOS | Xcode command line tools (`xcode-select --install`) |
| Windows | Visual Studio Build Tools (C++ workload) and the WebView2 runtime (preinstalled on Windows 11) |

Python 3 with Pillow is needed only to regenerate the tray icons.

## Run in development

```sh
cd device/app
npm ci
node scripts/fetch-node.mjs          # once per target; dev falls back to `node` on the PATH if the file is missing,
                                     # but the build still requires the file to exist (see below)
(cd ../agent && npm ci && npm run build)
npm run dev                          # tauri dev; uses ../agent/dist/main.mjs in debug builds
```

Overrides: `EVVAPP_NODE=<path to node>` and `EVVAPP_AGENT_MAIN=<path to main.mjs>`. To only compile-check without the real runtime: `touch src-tauri/binaries/evvapp-node-$(rustc -vV | sed -n 's/host: //p')` (add `.exe` on Windows).

Checks (also run in CI): from `src-tauri/`: `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`.

## The Node runtime: `scripts/fetch-node.mjs`

```sh
node scripts/fetch-node.mjs [--target <triple>] [--version 22|22.x.y] [--force]
```

Downloads the official Node 22 LTS binary for the target triple (default: the host's) from nodejs.org, verifies its SHA-256 against `SHASUMS256.txt` of that release and writes `src-tauri/binaries/evvapp-node-<triple>[.exe]`. Supported triples: `x86_64-pc-windows-msvc`, `aarch64-pc-windows-msvc`, `aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`. Windows takes the bare `node.exe`; macOS and Linux extract `bin/node` from the `.tar.gz` (needs `tar`).

The sidecar is called `evvapp-node`, not `node`: Tauri installs `externalBin` next to the app binary without the triple, and a `.deb` would otherwise put a second `/usr/bin/node` on the system.

## The agent: `scripts/stage-agent.mjs`

```sh
node scripts/stage-agent.mjs [--skip-build]
```

Runs `npm ci` in `playwright-mcp` (the agent bundles its sources) and in `device/agent`, builds the agent, then copies `dist/` and `package.json` / `package-lock.json` to `src-tauri/resources/agent/` and runs `npm ci --omit=dev` there, so only production dependencies are shipped. `tauri.conf.json` maps that folder to the `agent` resource.

## Build an installer

```sh
node scripts/fetch-node.mjs
node scripts/stage-agent.mjs
npm run build -- --bundles deb,appimage      # Linux; macOS: dmg; Windows: msi,nsis (or no flag for all)
```

CI does the same for every platform on a tag `device-vX.Y.Z` (`.github/workflows/device.yml`) and attaches the installers to a draft GitHub release. Builds are unsigned until signing credentials are added to that workflow: expect SmartScreen (Windows) and Gatekeeper (macOS) warnings.

## Icons

`icons/source.png` is the logo (1024x1024, white mark on black). To regenerate everything after replacing it:

```sh
npm run icons
```

which runs:

1. `python3 scripts/gen-tray-icons.py` -> `icons/tray/`: the mark alone on a transparent background (brightness becomes alpha, so the shaded crossing is kept), trimmed with a little padding, at 16/32/64 px and @2x, in four variants: `tray-*` (white), `tray-dim-*` (40 % opacity, used for offline / paused / unpaired / error), `tray-template-*` (black, macOS template image) and `tray-template-dim-*`. The app embeds `tray-32@2x` (64 px) variants; macOS uses the template ones with `icon_as_template`.
2. `npx tauri icon icons/source.png -o icons/app` -> `icons/app/`: the PNGs, `icon.icns` and `icon.ico` that `tauri.conf.json` lists (the Android and iOS sets are deleted).

The white tray mark is meant for dark panels; on a light Windows taskbar or light Linux panel it has low contrast. Switching to the black variant there is a one-line change in `src-tauri/src/tray.rs`.

## Test by hand (not covered by CI)

- Windows: pairing end to end, token in Credential Manager (`everythingapp-device`), autostart entry (Task Manager > Startup), tray menu on Windows 11, MSI and NSIS installers, SmartScreen, no console window flashes when the agent starts.
- macOS: no Dock icon, template icon in light and dark menu bars, Keychain prompt on first token write, Login Item, notarisation when signing is added.
- Linux: the tray on GNOME (needs the AppIndicator extension), Secret Service (gnome-keyring/KWallet) present; without one the token cannot be stored and the device must be paired again after each restart (logged as "credential store").
