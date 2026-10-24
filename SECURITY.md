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

Out of scope: an operator who deliberately weakens the setup (`ALLOW_WEAK_SECRETS`, ports published beyond
`127.0.0.1`, an egress guard that is not installed), and what a model does inside the limits a person approved. Advisories
in third-party packages are welcome when they are reachable from this code; `npm audit` already runs in CI.
