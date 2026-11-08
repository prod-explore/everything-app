# 0019 — Device permissions: the device sets the ceiling, the app's approval gate decides each call

**Status:** accepted

**Context.** A device is not a sandbox. A command on the desktop PC can delete real files, a click in the daily browser profile acts on real accounts. Two failure modes had to be avoided: a compromised or confused server switching on access the owner of the machine never gave, and approvals scattered between the tray and the web app, so that nobody knows which click allowed what.

**Decision.** Two layers with separate jobs.

**The ceiling lives on the device.** Each capability — *shell*, *files*, *browser* — is switched on or off in the tray app, with its scope (folders for files, read-only or read-write; which browser and which profile). A capability that is off exposes no tools at all; the server cannot ask for it. File paths are resolved (`realpath`) and refused outside the configured folders, symlinks included. *Pause* in the tray disconnects the device, ends its shell sessions and closes its browser.

**Every approval lives in the app.** No prompts on the device. Per device, Settings → Devices sets three levels:

| Level | Values (default first) | Applies to |
|---|---|---|
| `shell` | `allowlist` · `strict` · `auto` | `shell_run`, `shell_send` — the command policy (ADR 0002), evaluated per sub-command |
| `filesWrite` | `ask` · `auto` | `fs_write`, `fs_edit`, `fs_mkdir`, file transfers onto the device |
| `browserAct` | `ask` · `auto` | `browser_act` (opening a page is the per-domain web gate, as for the server browser) |

Reading (listing and reading files, shell output, observing a page, screenshots) needs no approval once the capability is on. The modes are evaluated by the same command policy as in the sandbox — `allowlist`: read-only commands and policy.json's allow list run, the rest asks. `auto` keeps the sandbox's boundary checks too — a `git push`, network access to a domain outside policy.json's list, a write outside `/workspace` and `/tmp` — so on a device it still asks for those: stricter than its name suggests, never looser. One deliberate difference: **command grants are scoped to the device.** A grant is stored as `cmd@device-pc:git push`, so "always allow `npm install`" given in the sandbox never covers the PC, and a grant on the laptop never covers the PC either. The built-in destructive patterns and policy.json's block list apply everywhere and cannot be loosened from the UI.

PowerShell is not parsed by the command policy, which reads POSIX shell. A device that reports a PowerShell shell is treated as `strict` when its level is `allowlist` (only policy.json allow-list prefixes and grants run unasked); `auto` stays available as an explicit choice. Windows devices with Git Bash default to it.

**Consequences.** The person at the machine decides what *can* happen there; the person in the app decides what *does*, one card at a time, in the same queue (chat and Gazeta) as every other approval. A level is a click in Settings, like the project command mode; lists of prefixes and domains stay in policy.json. The shell on a device is as powerful as its user — the gate, not the shell, is the boundary, which is why its default asks for anything that is not read-only.
