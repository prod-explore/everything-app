/**
 * remark-math takes any pair of single dollar signs as a formula, so "it costs $5 and $10" would turn into one. This
 * escapes the dollar signs that cannot be a formula by the usual rule (as in Pandoc): an opening `$` needs a non-space
 * right after it, a closing `$` a non-space right before it and no digit right after it. `$$…$$` blocks, code spans and
 * fenced code are left alone.
 */
export function escapeCurrencyDollars(text: string): string {
  if (!text.includes('$')) return text;
  let out = '';
  let i = 0;
  const n = text.length;
  let lineStart = true;
  let fence: string | null = null; // the fence marker while inside a fenced block

  while (i < n) {
    if (lineStart) {
      const line = /^ {0,3}(`{3,}|~{3,})/.exec(text.slice(i, i + 200));
      if (fence === null && line) fence = line[1]!;
      else if (fence !== null && new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*(\\n|$)`).test(text.slice(i, i + 200))) {
        const end = text.indexOf('\n', i);
        const stop = end === -1 ? n : end + 1;
        out += text.slice(i, stop);
        i = stop;
        fence = null;
        continue;
      }
    }
    if (fence !== null) {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? n : end + 1;
      out += text.slice(i, stop);
      i = stop;
      lineStart = true;
      continue;
    }
    const ch = text[i]!;
    lineStart = ch === '\n';
    if (ch === '\\') { out += text.slice(i, i + 2); i += 2; continue; }
    if (ch === '`') {
      // an inline code span: as many backticks to open as to close
      const run = /^`+/.exec(text.slice(i))![0];
      const close = text.indexOf(run, i + run.length);
      const stop = close === -1 ? i + run.length : close + run.length;
      out += text.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === '$') {
      if (text[i + 1] === '$') {
        // display math: up to the closing $$ (may span lines)
        const close = text.indexOf('$$', i + 2);
        const stop = close === -1 ? i + 2 : close + 2;
        out += text.slice(i, stop);
        i = stop;
        continue;
      }
      const close = closingDollar(text, i);
      if (close === -1) { out += '\\$'; i += 1; continue; }
      out += text.slice(i, close + 1);
      i = close + 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Index of the `$` that closes the inline formula opened at `open`, or -1 when it is not one. */
function closingDollar(text: string, open: number): number {
  const next = text[open + 1];
  if (next === undefined || /\s/.test(next)) return -1;
  for (let j = open + 1; j < text.length; j++) {
    const c = text[j]!;
    if (c === '\n') return -1; // a formula between single dollars stays on one line
    if (c === '\\') { j += 1; continue; }
    if (c !== '$') continue;
    const before = text[j - 1]!;
    const after = text[j + 1];
    if (/\s/.test(before)) return -1;
    if (after !== undefined && /\d/.test(after)) return -1;
    return j;
  }
  return -1;
}
