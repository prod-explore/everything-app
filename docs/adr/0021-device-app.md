# 0021 — Device app: Tauri tray shell, Node agent as a sidecar, shells without a PTY

**Status:** accepted

**Context.** The device app has to run on Windows, macOS and Linux, live in the system tray, start with the system, keep a secret in the OS credential store, and host the browser tools — which exist only in Node (Playwright, and `playwright-mcp` to reuse). Electron would make all of it one Node process at the cost of ~150 MB and a full Chromium per install; a Go or Rust rewrite of the tools would fork them from the server browser.

**Decision.**

- **Tauri v2 (Rust)** owns everything native: the tray menu, autostart, single instance, the token in the credential store (`keyring`), the settings window and opening the pairing page. It is small and does no tool work.
- **The agent is a Node program** (`device/agent`) run by the tray app as a sidecar: Tauri bundles the official Node runtime for the target and the agent's built files as resources. They talk over the child's stdin/stdout, one JSON object per line; the token is passed on stdin, never in argv or the environment. The tray restarts a crashed agent with backoff.
- The same agent runs **headless** without the tray (`evvapp-device pair` / `evvapp-device run`) for servers and for tests; there the token is a 0600 file.
- **Shell sessions use pipes, not a PTY** — the way Claude Code's own shell tool works. A session is a long-lived shell process; each command is written to its stdin followed by a sentinel that prints a nonce and the exit status, so output, exit code and the end of a command are known exactly while the working directory and variables persist. No native module (node-pty) means no per-platform build of the agent and no ABI breakage on Node updates. Interactive full-screen programs are not supported, which agents do not need; prompts are answered with `shell_send`. On POSIX a timed-out command is interrupted through its process group; on Windows through `taskkill /T`.
- Releases: a GitHub Actions matrix (Windows x64, macOS arm64/x64, Linux x64) builds the installers on tags `device-v*`; CI type-checks and tests the agent and runs `cargo check` on every push.

**Consequences.** One codebase for the tools on the server and on the device. Installers are larger than a pure-Rust app (the Node runtime, ~40 MB compressed) and much smaller than Electron. Unsigned builds trigger SmartScreen/Gatekeeper warnings until signing certificates are configured in the release workflow.
