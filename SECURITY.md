# Security policy

## Supported versions

Only `main`. There are no tagged releases; fixes land on `main` and nothing is backported.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting instead:
**Security → Report a vulnerability** on <https://github.com/prod-explore/everything-app>.

Include what you found, how to reproduce it (a request, a command, a compose file) and the commit you tested. This is a
one-person project: reports are handled on a best-effort basis and normally acknowledged within a week.

## Scope

The project's security claims are listed in the [README](README.md#security-model). A report is in scope when it breaks one
of them:

- **Sandbox escape.** Code running in a sandbox reaches the host, the Docker socket, the supervisor, another sandbox,
  another service's network or the app's database.
- **Key exposure.** A provider API key, `KEY_VAULT_SECRET`, a service token, a session cookie or a GitHub credential
  reaches a sandbox, the browser agent, the model, a log, an API response or the page.
- **SSRF.** `web_fetch` or the browser agent can be made to reach a private, link-local or metadata
  address, or a URL the model composed itself is fetched without the approval it needs.
- **Authentication.** Reaching the HTTP API, `/internal/*`, the supervisor, `sandbox-mcp` or `playwright-mcp` without the
  required password, session or token.
- **Approval gate.** A tool call with a side effect, or a push to a protected branch, that runs without the approval the
  policy asks for.
- **Devices.** A paired computer's tools reached without its device token, a capability the device has switched off made
  available, a file path outside its shared folders opened, or a device call run without the approval its level asks for
  (ADR 0017–0019).

Out of scope: an operator who deliberately weakens the setup (`ALLOW_WEAK_SECRETS`, ports published beyond
`127.0.0.1`, an egress guard that is not installed), and what a model does inside the limits a person approved. Advisories
in third-party packages are welcome when they are reachable from this code; `npm audit` already runs in CI.

## Accepted advisories

Advisories that cannot be fixed by an update without replacing a framework, kept here with the reason and the condition
that ends them.

| Advisory | Where | Why it stays | Ends when |
|---|---|---|---|
| [GHSA-wrw7-89jp-8q8g](https://github.com/advisories/GHSA-wrw7-89jp-8q8g) — `glib` < 0.20, unsound `VariantStrIter` | `device/app` (tray app), Linux build only | Tauri 2's Linux webview is built on gtk-rs 0.18 (GTK 3, webkit2gtk); `glib` 0.20 belongs to the GTK 4 line and cannot be swapped in alone. The app's own code does not use `GVariant` (the affected iterator is reached only through `GVariant` string arrays); the server and the Windows/macOS builds do not contain `glib` at all. | Tauri moves its Linux webview to GTK 4 (Tauri 3) |

