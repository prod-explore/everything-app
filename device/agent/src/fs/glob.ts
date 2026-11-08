/**
 * A small glob: `*` (within one path segment), `**` (across segments), `?`, `[abc]`, `{a,b}`. A pattern without a `/`
 * matches the file name at any depth (`*.ts`, as ripgrep's -g does); one with a `/` matches the path relative to the search root.
 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let braces = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    switch (c) {
      case '*':
        if (glob[i + 1] === '*') {
          i++;
          if (glob[i + 1] === '/') {
            i++;
            re += '(?:.*/)?';
          } else re += '.*';
        } else re += '[^/]*';
        break;
      case '?':
        re += '[^/]';
        break;
      case '[': {
        const end = glob.indexOf(']', i + 2);
        if (end === -1) re += '\\[';
        else {
          const body = glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\');
          re += `[${body}]`;
          i = end;
        }
        break;
      }
      case '{':
        braces++;
        re += '(?:';
        break;
      case '}':
        if (braces > 0) {
          braces--;
          re += ')';
        } else re += '\\}';
        break;
      case ',':
        re += braces > 0 ? '|' : ',';
        break;
      default:
        re += c.replace(/[.+^$()|\\]/g, '\\$&');
    }
  }
  while (braces-- > 0) re += ')';
  return new RegExp(`^${re}$`);
}

export function matchesGlob(glob: string, relPath: string): boolean {
  const posix = relPath.replace(/\\/g, '/');
  const re = globToRegExp(glob);
  return glob.includes('/') ? re.test(posix) : re.test(posix.split('/').pop()!);
}
