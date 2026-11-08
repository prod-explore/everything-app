/**
 * Linear-time string trimming helpers.
 *
 * `s.replace(/\/+$/, '')` looks harmless but is quadratic in V8 on input like "////…/x": every start position
 * scans the whole run of slashes before the `$` fails. On request- or user-supplied strings that is a CPU
 * lever (CodeQL: polynomial regular expression on uncontrolled data), so trimming at the ends of untrusted
 * input goes through these loops, which touch each character at most once.
 */

/** Removes every trailing occurrence of the single character `ch`. */
export function trimTrailingChars(s: string, ch: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === ch) end--;
  return end === s.length ? s : s.slice(0, end);
}

/** Removes every leading occurrence of the single character `ch`. */
export function trimLeadingChars(s: string, ch: string): string {
  let start = 0;
  while (start < s.length && s[start] === ch) start++;
  return start === 0 ? s : s.slice(start);
}

/** `https://x.test/a//` → `https://x.test/a`. */
export const trimTrailingSlashes = (s: string): string => trimTrailingChars(s, '/');

/** `///workspace/a` → `workspace/a`. */
export const trimLeadingSlashes = (s: string): string => trimLeadingChars(s, '/');
