# 0017 — Device bridge: the user's own machines as MCP servers, reached through a reverse tunnel

**Status:** accepted

**Context.** Agents worked only inside the sandbox and the server-side browser. Much of the real work happens elsewhere: in the user's daily browser profile (logged-in accounts), in a terminal on the desktop PC, in folders on the laptop. Getting there had three obvious shapes, each with a cost:

- a **browser extension** reaches only the browser, needs a store listing or developer mode on every machine, and still leaves the terminal and files out;
- **opening a port** on each machine (or a VPN such as Tailscale) adds a network dependency and an inbound attack surface on the machines that matter most;
- a **separate protocol** for each capability would grow its own approval path next to the existing one.

**Decision.** A small app on each machine (*device agent*, `device/`) dials **out** to the server over one WebSocket (`wss://<host>/api/devices/connect`) and speaks **MCP** over it: the device is an MCP *server*, the orchestrator its *client* — the usual direction of MCP, only the TCP connection is opened by the other side. Each JSON-RPC message is one text frame (`cli/src/devices/ws-transport.ts` on the server, `device/agent/src/ws-transport.ts` on the device; two mirror implementations, no shared package between two deployables).

- A connected device is a `DeviceConnection`, an ordinary `McpConnectionLike` named `device-<slug>`. The tool registry, the approval gate, the audit log, the use of tools by subagents and the chat UI need no new paths: a device tool is `device-pc__shell_run` like a sandbox tool is `sandbox__run_bash`.
- **Tools appear and disappear with the connection.** On connect the server reads the device's `evvapp://device/info` resource, then loads its tools into the registry; on disconnect they are removed, so a model never sees a tool it cannot reach. A config change on the device (a capability switched off) reconnects the session instead of patching tool lists in place.
- Names chosen to fit the existing gates: the browser tools carry the same names and schemas as `playwright-mcp` (`browser_open`, `browser_act`, …), so the per-domain web gate, injection handling and hidden `_policy` arguments apply to them unchanged; the shell tools are recognised by the command policy (`shell_run`, `shell_send`) and get `_conversation_id` so each chat has its own shell sessions on the device.
- Liveness: the server pings every 25 s and drops a socket that has not answered within 60 s; the device reconnects with jittered backoff (1 s → 60 s). One live connection per device: a second one replaces the first, which is closed with code 4409 and does not reconnect. A revoked token is closed with 4401 and the device stops retrying.

**Consequences.** No inbound ports, no VPN, no browser store: one outbound HTTPS connection through the existing nginx. The server gains a WebSocket endpoint authenticated by a device token (ADR 0018) — the only credential that endpoint accepts. Everything a device can do passes through the same approval gate as the sandbox (ADR 0019). Cost: the device must be online for its tools to exist; a turn that loses its device mid-call gets an error result, never a silent retry, because the call may have run. Not built: computer-use (screenshots and synthetic mouse/keyboard) — the transport and permission model admit it as one more capability.
