/** Helpers for tools and grants that belong to a paired device (connection name `device-<slug>`, tools `device-<slug>__<tool>`). */

/** "pc" → "PC", "my-laptop" → "My laptop". The slug is all the approval gate knows of the device's name. */
export function deviceDisplayName(slug: string): string {
  const words = slug.replace(/-+/g, ' ').trim();
  if (!words) return slug;
  return words.length <= 3 ? words.toUpperCase() : words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Splits `device-<slug>__<tool>` (also `device-<slug>/<tool>`, as approval labels write it) into the device and the tool.
 * null for any other tool.
 */
export function parseDeviceTool(name: string): { slug: string; device: string; tool: string } | null {
  const m = /^device-([a-z0-9-]+?)(?:__|\/)([A-Za-z0-9_]+)$/.exec(name);
  return m ? { slug: m[1]!, device: deviceDisplayName(m[1]!), tool: m[2]! } : null;
}

/** A command grant on a device is stored as `cmd@device-pc:git push`. */
export function parseDeviceGrant(label: string): { device: string; command: string } | null {
  const m = /^cmd@device-([a-z0-9-]+):(.*)$/s.exec(label);
  return m ? { device: deviceDisplayName(m[1]!), command: m[2]! } : null;
}

/** Readable text for a stored grant label: `cmd:git push` → `$ git push`, `cmd@device-pc:git push` → `PC $ git push`. */
export function grantText(label: string): string {
  const d = parseDeviceGrant(label);
  if (d) return `${d.device} $ ${d.command}`;
  return label.replace(/^cmd:/, '$ ');
}

const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/;

/** What the user typed → `XXXX-XXXX` (dash added, look-alikes left alone); null if it cannot be a code. */
export function normalizeCode(raw: string): string | null {
  const c = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (c.length !== 8) return null;
  const code = `${c.slice(0, 4)}-${c.slice(4)}`;
  return CODE_RE.test(code) ? code : null;
}
