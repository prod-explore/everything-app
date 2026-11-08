# 0020 — Device browser: the user's own profile, driven by the same tools as the server browser

**Status:** accepted

**Context.** The server browser is ephemeral, with no saved logins, because an agent in a logged-in browser turns a prompt injection into an account takeover. Yet the most common real task is exactly that — acting on the user's own accounts. The user already did it daily by pointing Playwright at the profile of a closed Brave. Chromium-family browsers refuse remote debugging of a profile the browser itself is using, and since Chrome 136 refuse `--remote-debugging-port` on the default data directory; driving the profile while the person browses in it would require an extension.

**Decision.** The device's *browser* capability launches the user's browser with `launchPersistentContext` (Playwright) in one of two modes, chosen in the tray:

- **profile** — the user's real profile of Brave, Chrome, Edge or Chromium (auto-detected, overridable), visible on screen. Requires that browser to be closed; the agent checks the profile lock first and says so instead of failing with a Chromium error.
- **dedicated** — a separate, persistent profile in the agent's data directory. Logins made there persist; it can run next to the user's own browser.

The tools are `playwright-mcp`'s six, imported from it as a library (`playwright-mcp/src/lib.ts`), with a device launcher in place of the hardened ephemeral one: the real user agent, the user's extensions, private-network addresses reachable when the device allows it (localhost dev servers are a normal target on a laptop). What stays identical: per-domain approval in the app before a domain is opened, the navigation guard that enforces it, injection detection on observations, downloads blocked unless allowed for the call, `browser_act` gated by the device's `browserAct` level (ADR 0019) and always asking for actions that look irreversible.

A persistent profile is one browser process, so a device serves **one browser session at a time**; a second chat that wants it gets a clear "in use by another chat" error until the first closes it or idles out.

**Consequences.** Agents act in the user's accounts in a visible window, and the person can take over by simply using it. The security of that rests on the domain gate and on `browserAct: ask` as the default; the dedicated profile is the option for running agents next to one's own browsing. Not built: attaching to an already-running browser (would need an extension, see context).
