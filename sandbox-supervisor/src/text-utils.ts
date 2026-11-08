/**
 * Linear-time trimming of trailing slashes. `s.replace(/\/+$/, '')` is quadratic in V8 on "////…/x"; tar entry
 * names come out of the (untrusted) sandbox container, so they must not be fed to it.
 */
export function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47) end--;
  return end === s.length ? s : s.slice(0, end);
}
