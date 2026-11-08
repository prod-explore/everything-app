# 0018 — Device pairing: device-code flow, one hashed token per device

**Status:** accepted

**Context.** A device needs a credential for the WebSocket endpoint. Reusing the app's login (password or `SERVER_AUTH_TOKEN`) would put a credential that opens the whole API on every laptop, impossible to revoke for one machine. Typing a long token into a tray app is error-prone, and the device has no browser session of its own.

**Decision.** Pairing follows the OAuth device-authorization pattern (RFC 8628, the flow of `gh auth login`):

1. The device calls `POST /api/devices/pair/start` (unauthenticated) with its name, platform and agent version and gets a `deviceCode` (secret, 32 random bytes) and a `userCode` (`XXXX-XXXX`, 8 characters from an alphabet without look-alikes), valid for 10 minutes.
2. The device opens `<server>/devices/pair?code=XXXX-XXXX` in the user's browser and shows the same code in the tray.
3. The page — behind the normal login — shows the device's name, platform, the IP address that started the pairing and the code in large type, and asks the user to check it matches the one on the device before approving. This is the defence against the known phishing shape of the flow (an attacker starts a pairing and sends the link).
4. The device polls `POST /api/devices/pair/poll` with its `deviceCode`; after approval it receives the **device token** exactly once.

The server stores only `sha256(token)`; tokens are 32 random bytes, so a fast hash is the right one (nothing to brute-force, nothing to stretch). Pending pairings live in memory (a restart cancels them, which is harmless), at most 20 at a time and 10 starts per minute per address. On the device the token goes to the OS credential store (Keychain, Windows Credential Manager, Secret Service) through the tray app; the headless agent (servers, CI) keeps it in a 0600 file in its data directory.

The token authenticates **only** `GET /api/devices/connect`. It is never accepted by the REST API or the event stream. Settings → Devices revokes a device: the row and its token hash are deleted, its socket is closed (4401), its tools leave the registry and its approval grants are removed.

**Consequences.** Pairing a machine is "click Pair in the tray, click Approve in the browser". Each machine can be revoked alone, and a leaked token reaches one device's tool endpoint, not the account. The pairing endpoints are the only unauthenticated writes in the API; they are rate-limited and create nothing until a logged-in user approves.
