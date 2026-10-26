/**
 * Command policy engine: shell commands are approved per command, not per tool (an "always" on run_bash would let
 * every command through).
 *
 * A command is split into its sub-commands (`a && b | c; $(d)`), each one is classified
 * allow / ask / deny against the project policy and the persisted prefix grants, and the whole
 * command is only as permissive as its least permissive part. An allow on `ls` therefore never
 * lets `ls && rm -rf ~` through.
 *
 * This is a gate on what runs inside the sandbox — the sandbox itself is still the boundary.
 */

export type CommandMode = 'strict' | 'auto' | 'allowlist';
export type CommandDecision = 'allow' | 'ask' | 'deny';

export interface CommandPolicy {
  /** strict: ask for every command (unless granted); auto: ask only when crossing a boundary; allowlist: allow prefixes, ask the rest. */
  mode: CommandMode;
  /** Extra allowed prefixes (on top of the read-only commands in allowlist mode). */
  allow: string[];
  /** Always-blocked prefixes / patterns (on top of DENY_PATTERNS). */
  deny: string[];
  /** Domains network commands may reach without asking in auto mode (glob: `*.npmjs.org`). */
  domains: string[];
}

export const DEFAULT_COMMAND_POLICY: CommandPolicy = { mode: 'strict', allow: [], deny: [], domains: [] };

// ─── Read-only commands (allowlist mode) ────────────────────────────────────

/**
 * Checks the arguments of a read-only command; returns why this use is NOT read-only, or null. `args` are the shell
 * words after the command words, quotes removed.
 */
type ArgCheck = (args: string[]) => string | null;

/** Options that make an otherwise read-only command write, run something or change state. */
interface OptionSet {
  /** Long option names without the dashes. Unambiguous abbreviations (`--out` for `--output`) count too. */
  long?: string[];
  /** Short option letters; matched anywhere in a cluster (`-uo file`), which may over-ask but never under-asks. */
  short?: string;
}

const anyArgs: ArgCheck = () => null;
const noArgs: ArgCheck = args => (args.length ? `takes no arguments here (${args.join(' ')})` : null);

/** The long option a word names, if any: `--output=x` → `output`. */
const longName = (w: string): string | null => (/^--[^-=]/.test(w) ? w.slice(2).split('=')[0]! : null);
/** Short option letters of a cluster: `-uo` → `uo`. */
const shortLetters = (w: string): string => (/^-[^-]/.test(w) ? w.slice(1) : '');

/** Index of the first `--` (end of options), or the length. */
const optionsEnd = (args: string[]) => (args.indexOf('--') === -1 ? args.length : args.indexOf('--'));

function hasOption(args: string[], set: OptionSet): string | null {
  for (const w of args.slice(0, optionsEnd(args))) {
    const name = longName(w);
    // getopt_long and git accept any unambiguous prefix of a long option, so `--out` is `--output`.
    const hit = name !== null && set.long?.find(l => l.startsWith(name));
    if (hit) return `--${hit}`;
    const letter = [...shortLetters(w)].find(c => set.short?.includes(c));
    if (letter) return `-${letter}`;
  }
  return null;
}

/** Read-only unless one of these options is used. */
const without = (set: OptionSet, why: string): ArgCheck => args => {
  const opt = hasOption(args, set);
  return opt ? `${opt} ${why}` : null;
};

/** Operands (non-option words), skipping the values of options that take one as the next word. */
function operands(args: string[], valueOptions: OptionSet = {}): string[] {
  const out: string[] = [];
  const end = optionsEnd(args);
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!;
    if (i >= end) { if (i > end) out.push(w); continue; }
    if (w === '-' || !w.startsWith('-')) { out.push(w); continue; }
    const name = longName(w);
    if (name !== null) { if (!w.includes('=') && valueOptions.long?.includes(name)) i++; continue; }
    const letters = shortLetters(w);
    // A value option ends its cluster; its value is the rest of the word or, if that is empty, the next word.
    const at = [...letters].findIndex(c => valueOptions.short?.includes(c));
    if (at !== -1 && at === letters.length - 1) i++;
  }
  return out;
}

/** `git branch` lists branches only with these options; anything else (or a branch name) creates, renames or deletes. */
const GIT_BRANCH_LIST: Required<OptionSet> & { value: string[] } = {
  long: ['all', 'remotes', 'list', 'verbose', 'show-current', 'contains', 'no-contains', 'merged', 'no-merged', 'points-at',
    'sort', 'format', 'color', 'no-color', 'column', 'no-column', 'ignore-case', 'omit-empty', 'abbrev', 'no-abbrev'],
  short: 'arlvi',
  /** Take a value as the next word. */
  value: ['contains', 'no-contains', 'merged', 'no-merged', 'points-at', 'sort', 'format'],
};

const gitBranchListOnly: ArgCheck = args => {
  let listing = false;
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!;
    const name = longName(w);
    if (name !== null) {
      // Exact names only: an abbreviation could just as well be --delete, --move or --copy.
      if (!GIT_BRANCH_LIST.long.includes(name)) return `${w.split('=')[0]} changes branches`;
      if (name === 'list') listing = true;
      if (!w.includes('=') && GIT_BRANCH_LIST.value.includes(name) && i + 1 < args.length) i++;
      continue;
    }
    if (w.startsWith('-') && w.length > 1) {
      const bad = [...shortLetters(w)].find(c => !GIT_BRANCH_LIST.short.includes(c));
      if (bad) return `-${bad} changes branches`;
      if (shortLetters(w).includes('l')) listing = true;
      continue;
    }
    // A plain word is a pattern under --list, and otherwise the name of a branch to create.
    if (!listing) return `"${w}" would create a branch`;
  }
  return null;
};

/**
 * Commands that only read, and how their arguments are checked — allowed without asking in allowlist mode. The check
 * matters as much as the name: `sort -o`, `git diff --output`, `tree -o` write files, `rg --pre` runs a program,
 * `git branch x` creates a branch.
 */
const READ_ONLY: Record<string, ArgCheck> = {
  ls: anyArgs,
  pwd: anyArgs,
  cat: anyArgs,
  head: anyArgs,
  tail: anyArgs,
  wc: anyArgs,
  echo: anyArgs,
  printf: anyArgs,
  grep: anyArgs,
  rg: without({ long: ['pre'] }, 'runs a program on every file'),
  which: anyArgs,
  whoami: anyArgs,
  date: without({ long: ['set'], short: 's' }, 'sets the clock'),
  tree: without({ short: 'oR' }, 'writes output files'),
  stat: anyArgs,
  file: without({ long: ['compile'], short: 'C' }, 'writes a compiled magic file'),
  du: anyArgs,
  df: anyArgs,
  // With an operand, `env` runs it as a command; the operand form is unwrapped and judged on its own before this.
  env: args => (args.every(a => a === '-0' || a === '--null') ? null : 'env runs a command'),
  printenv: anyArgs,
  sort: without({ long: ['output', 'compress-program'], short: 'o' }, 'writes a file or runs a program'),
  // `uniq IN OUT` writes OUT.
  uniq: args => (operands(args, { long: ['skip-fields', 'skip-chars', 'check-chars'], short: 'fsw' }).length > 1 ? 'a second operand is an output file' : null),
  diff: anyArgs,
  true: anyArgs,
  false: anyArgs,
  test: anyArgs,
  'git status': anyArgs,
  'git diff': without({ long: ['output', 'ext-diff'] }, 'writes a file or runs an external diff'),
  'git log': without({ long: ['output', 'ext-diff'] }, 'writes a file or runs an external diff'),
  'git show': without({ long: ['output', 'ext-diff'] }, 'writes a file or runs an external diff'),
  'git branch': gitBranchListOnly,
  // `git remote -v add …` is still `git remote add`.
  'git remote -v': noArgs,
  'git rev-parse': anyArgs,
  'git blame': anyArgs,
  // `--version` with anything after it may run that instead.
  'node --version': noArgs,
  'npm --version': noArgs,
  'npm ls': anyArgs,
  'python --version': noArgs,
  'python3 --version': noArgs,
};

/** Output redirections to anything but /dev/null or another descriptor (`> f`, `>> f`, `&> f`, `2>f`, `>| f`). */
function writesByRedirection(sub: string): string | null {
  // Quoted text cannot redirect; drop it before looking.
  const bare = sub.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''");
  for (const m of bare.matchAll(/(?:^|[^<>&\\])(?:\d*|&)>>?\|?\s*(\S*)/g)) {
    const target = m[1]!;
    if (target.startsWith('&') || /^\/dev\/(null|stdout|stderr)$/.test(target)) continue;
    return `writes to ${target || 'a file'}`;
  }
  return null;
}

/**
 * Why `sub` is not a read-only command, or null when it is. `prefixed`: it ran behind variable assignments or a wrapper
 * (`PAGER=… git log`, `GIT_EXTERNAL_DIFF=… git diff`, `nohup …`), which can make any of them run or write something.
 */
export function notReadOnly(sub: string, prefixed = false): string | null {
  const words = shellWords(sub);
  if (words.length === 0) return 'empty command';
  words[0] = words[0]!.replace(/^.*\//, '');
  const key = Object.keys(READ_ONLY)
    .filter(k => { const kw = k.split(' '); return kw.every((w, i) => words[i] === w); })
    .sort((a, b) => b.length - a.length)[0];
  if (!key) return 'not a read-only command';
  if (prefixed) return 'runs with changed variables or under a wrapper';
  return writesByRedirection(sub) ?? READ_ONLY[key]!(words.slice(key.split(' ').length));
}

/**
 * The words of a command as the shell passes them: split on unquoted whitespace, quotes removed, backslash escapes
 * resolved. Substitutions are left as text (they are classified separately). Enough to read options reliably, so
 * `sort "-o" f` and `sort -\o f` are seen as `sort -o f`.
 */
export function shellWords(sub: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inWord = false;
  for (let i = 0; i < sub.length; i++) {
    const c = sub[i]!;
    if (c === "'") {
      const end = sub.indexOf("'", i + 1);
      const stop = end === -1 ? sub.length : end;
      cur += sub.slice(i + 1, stop); i = stop; inWord = true; continue;
    }
    if (c === '$' && sub[i + 1] === "'") {
      let j = i + 2;
      while (j < sub.length && sub[j] !== "'") { cur += sub[j] === '\\' && j + 1 < sub.length ? sub[++j] : sub[j]; j++; }
      i = j; inWord = true; continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < sub.length && sub[j] !== '"') {
        if (sub[j] === '\\' && /["\\$`]/.test(sub[j + 1] ?? '')) j++;
        cur += sub[j]; j++;
      }
      i = j; inWord = true; continue;
    }
    if (c === '\\' && i + 1 < sub.length) { cur += sub[++i]; inWord = true; continue; }
    if (/\s/.test(c)) { if (inWord) out.push(cur); cur = ''; inWord = false; continue; }
    cur += c; inWord = true;
  }
  if (inWord) out.push(cur);
  return out;
}

/** Always blocked, regardless of mode or grants. */
const DENY_PATTERNS: RegExp[] = [
  /^rm\s+(-[\w-]+\s+)*(\/|\/\*|~|~\/|\$HOME)(\s|$)/,
  /^(mkfs|mkfs\.\w+|fdisk|parted|wipefs)\b/,
  /^dd\b.*\bof=\/dev\//,
  /^(shutdown|reboot|halt|poweroff)\b/,
  /^:\(\)\s*\{/, // fork bomb
  /^chmod\s+(-[\w-]+\s+)*[0-7]*777\s+\/(\s|$)/,
];

/** Commands with a meaningful sub-command: grant prefixes use two words (`git commit`, `npm install`). */
const TWO_WORD = new Set(['git', 'npm', 'npx', 'pnpm', 'yarn', 'docker', 'cargo', 'go', 'pip', 'pip3', 'apt', 'apt-get', 'kubectl', 'gh', 'make', 'python', 'python3', 'node', 'uv', 'poetry']);

/** Stands in for text that is nested too deeply to analyse — never classified as safe, always asks. */
const TOO_DEEP = '__TOO_DEEP__';

const NETWORK_TOOLS = new Set(['curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync', 'nc', 'ncat', 'telnet', 'ftp']);

export function parseCommandPolicy(raw: unknown): CommandPolicy {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map(s => s.trim()) : []);
  const mode = p['mode'] === 'auto' || p['mode'] === 'allowlist' || p['mode'] === 'strict' ? p['mode'] : 'strict';
  return { mode, allow: strings(p['allow']), deny: strings(p['deny']), domains: strings(p['domains']) };
}

// ─── Shell splitting ────────────────────────────────────────────────────────

/**
 * Splits a shell command into sub-commands: on `;`, `&&`, `||`, `|`, `&`, newlines, and recursively
 * into `$(…)`, `` `…` ``, `<(…)`/`>(…)` and `( … )` subshells. Quotes are respected (single quotes
 * are literal; double quotes still expand `$(…)`). Not a full bash parser — the goal is that no
 * executable part of the string escapes classification; an over-split only costs an extra prompt.
 */
export function splitShellCommand(command: string): string[] {
  return splitDetailed(command).map(s => s.command);
}

/** A sub-command, and whether variable assignments or a wrapper (`sudo`, `env`, `nohup`…) were stripped from its front. */
interface SplitPart { command: string; prefixed: boolean }

function splitDetailed(command: string, depth = 0): SplitPart[] {
  const out: string[] = [];
  splitInto(command, out, 0);
  return out.map(normalize).filter(p => p.command !== '').flatMap((part): SplitPart[] => {
    const sub = part.command;
    // `bash -c "…"`, `sh -c '…'`, `eval "…"`: the quoted string is itself a command line.
    const m = /^(?:(?:ba|z|da|k)?sh(?:\s+-\w+)*\s+-\w*c|eval)\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(.+))/.exec(sub);
    if (!m) return [part];
    if (depth > 4) return [{ command: `${TOO_DEEP} ${sub}`, prefixed: part.prefixed }];
    // Inside double quotes the shell removes backslashes before " \ $ ` — do the same so a nested `bash -c \"…\"` is read as the command it is.
    const inner = m[1] !== undefined ? m[1].replace(/\\(["\\$`])/g, '$1') : (m[2] ?? m[3] ?? '');
    return [{ command: sub.split(' ')[0]!, prefixed: part.prefixed }, ...splitDetailed(inner, depth + 1).map(p => ({ ...p, prefixed: p.prefixed || part.prefixed }))];
  });
}

function splitInto(src: string, out: string[], depth: number): void {
  if (depth > 8) { out.push(`${TOO_DEEP} ${src}`); return; }
  let cur = '';
  let i = 0;
  const flush = () => { out.push(cur); cur = ''; };
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === '\\' && next !== undefined) { cur += c + next; i += 2; continue; }
    if (c === '$' && next === "'") {
      // ANSI-C quoting: unlike '…', a backslash escapes here (`$'\''` is one apostrophe), so the closing quote is the first unescaped one.
      let j = i + 2;
      while (j < src.length && src[j] !== "'") j += src[j] === '\\' ? 2 : 1;
      const stop = Math.min(j + 1, src.length);
      cur += src.slice(i, stop); i = stop; continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      const stop = end === -1 ? src.length : end + 1;
      cur += src.slice(i, stop); i = stop; continue;
    }
    if (c === '"') {
      // Double quotes: keep the text, but executable substitutions inside still count.
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '$' && src[j + 1] === '(') {
          const end = matchParen(src, j + 1);
          splitInto(src.slice(j + 2, end), out, depth + 1);
          j = end + 1; continue;
        }
        if (src[j] === '`') {
          const end = src.indexOf('`', j + 1);
          const stop = end === -1 ? src.length : end;
          splitInto(src.slice(j + 1, stop), out, depth + 1);
          j = stop + 1; continue;
        }
        j++;
      }
      cur += src.slice(i, Math.min(j + 1, src.length)); i = j + 1; continue;
    }
    if ((c === '$' || c === '<' || c === '>') && next === '(') {
      const end = matchParen(src, i + 1);
      splitInto(src.slice(i + 2, end), out, depth + 1);
      cur += ' __SUBST__ '; i = end + 1; continue;
    }
    if (c === '`') {
      const end = src.indexOf('`', i + 1);
      const stop = end === -1 ? src.length : end;
      splitInto(src.slice(i + 1, stop), out, depth + 1);
      cur += ' __SUBST__ '; i = stop + 1; continue;
    }
    if (c === '(' && cur.trim() === '') {
      const end = matchParen(src, i);
      splitInto(src.slice(i + 1, end), out, depth + 1);
      i = end + 1; continue;
    }
    if (c === '{' && cur.trim() === '' && (next === ' ' || next === '\n')) { i++; continue; }
    if (c === '}' && cur.trim() === '') { i++; continue; }
    if (c === '#' && (cur === '' || /\s$/.test(cur))) {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl; continue;
    }
    if (c === ';' || c === '\n' || c === '|' || c === '&') {
      // `2>&1`, `&>file`, `>&2` are redirections, not separators.
      if (c === '&' && (src[i - 1] === '>' || src[i - 1] === '<' || next === '>')) { cur += c; i++; continue; }
      if (c === '|' && src[i - 1] === '>') { cur += c; i++; continue; } // `>|` clobber
      flush();
      i += (c === '&' && next === '&') || (c === '|' && (next === '|' || next === '&')) || (c === ';' && next === ';') ? 2 : 1;
      continue;
    }
    cur += c; i++;
  }
  flush();
}

function matchParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (c === '$' && src[i + 1] === "'") {
      let j = i + 2;
      while (j < src.length && src[j] !== "'") j += src[j] === '\\' ? 2 : 1;
      i = j; continue;
    }
    if (c === "'") { const e = src.indexOf("'", i + 1); i = e === -1 ? src.length : e; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
  }
  return src.length;
}

/** Trim, collapse whitespace, drop leading `VAR=value` assignments and wrappers like `sudo`/`env`/`time`. */
function normalize(sub: string): SplitPart {
  let s = sub.replace(/\s+/g, ' ').trim().replace(/^(then|do|else|elif|if|while|until|!)\s+/, '');
  const start = s;
  for (;;) {
    const before = s;
    s = s.replace(/^[A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|\S*)\s*/, '');
    s = s.replace(/^(sudo|env|time|nohup|nice|command|exec|builtin)(\s+-\S+)*\s+/, '');
    if (s === before) break;
  }
  return { command: s.replace(/^(then|do|else|elif|if|while|until|!)\s+/, '').replace(/^(fi|done|esac|then|do|else)$/, ''), prefixed: s !== start };
}

// ─── Classification ─────────────────────────────────────────────────────────

/** The prefix a grant for this sub-command would cover: `git commit`, `npm install`, `python3 script.py`→`python3`. */
export function grantPrefix(sub: string): string {
  const words = sub.split(' ').filter(Boolean);
  const first = (words[0] ?? '').replace(/^.*\//, ''); // /usr/bin/git → git
  if (!first) return '';
  const second = words[1];
  if (TWO_WORD.has(first) && second && /^[a-z][\w-]*$/.test(second)) return `${first} ${second}`;
  return first;
}

/** Word-boundary prefix match: `git status` matches `git status -s`, not `git statusx`; `ls` doesn't match `lsblk`. */
export function matchesPrefix(sub: string, prefix: string): boolean {
  const s = sub.replace(/^\S*\//, ''); // tolerate absolute binary paths
  return s === prefix || s.startsWith(prefix + ' ');
}

function hostMatches(host: string, pattern: string): boolean {
  const p = pattern.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const h = host.toLowerCase();
  if (p.startsWith('*.')) return h === p.slice(2) || h.endsWith(p.slice(1));
  return h === p;
}

/** Boundary checks for auto mode: push, network to an unlisted domain, writes outside /workspace and /tmp. */
function crossesBoundary(sub: string, policy: CommandPolicy): string | null {
  const first = sub.split(' ')[0]!.replace(/^.*\//, '');
  if (/^git (push|remote (add|set-url))\b/.test(sub)) return 'pushes to or changes a remote';
  if (NETWORK_TOOLS.has(first)) {
    const hosts = [...sub.matchAll(/(?:https?|ftp|ssh):\/\/(?:[^@\s/]+@)?([^/\s:'"]+)/g)].map(m => m[1]!);
    if (first === 'ssh' || first === 'scp' || first === 'sftp' || first === 'rsync' || first === 'nc' || first === 'ncat' || first === 'telnet') {
      return `opens a ${first} connection`;
    }
    if (hosts.length === 0) return `network command without a recognisable URL`;
    const unknown = hosts.filter(h => !policy.domains.some(d => hostMatches(h, d)));
    if (unknown.length) return `reaches a new domain: ${unknown.join(', ')}`;
  }
  // Writes outside the workspace: redirections and write-ish commands targeting absolute paths.
  const writeTargets = [...sub.matchAll(/(?:>>?|\btee\s+(?:-a\s+)?)\s*(\/[^\s;|&]+)/g)].map(m => m[1]!);
  if (/^(rm|mv|cp|chmod|chown|ln|mkdir|touch|truncate|install)\b/.test(first)) {
    writeTargets.push(...sub.split(' ').slice(1).filter(w => w.startsWith('/')));
  }
  const outside = writeTargets.filter(p => !/^\/(workspace|tmp|dev\/null|dev\/stdout|dev\/stderr)(\/|$)/.test(p));
  if (outside.length) return `writes outside /workspace: ${outside.join(', ')}`;
  return null;
}

export interface SubcommandVerdict {
  command: string;
  prefix: string;
  decision: CommandDecision;
  reason: string;
}

export interface CommandVerdict {
  decision: CommandDecision;
  subcommands: SubcommandVerdict[];
}

/**
 * Classifies a full command line. `granted(prefix)` reports whether a persisted grant covers a
 * prefix in the current context (chat/project/always, model/skill scoped).
 */
export function evaluateCommand(command: string, policy: CommandPolicy, granted: (prefix: string) => boolean): CommandVerdict {
  const parts = splitDetailed(command);
  if (parts.length === 0) return { decision: 'ask', subcommands: [] };

  const subcommands = parts.map(({ command: sub, prefixed }): SubcommandVerdict => {
    const prefix = grantPrefix(sub);
    // Also look at the command as the shell will run it: quotes and backslashes removed, binary path stripped (`'rm' -rf "/"`, `/bin/rm -rf /`).
    const plain = sub.replace(/["'\\]/g, '').replace(/^\S*\//, '');
    if (DENY_PATTERNS.some(re => re.test(sub) || re.test(plain)) || policy.deny.some(d => matchesPrefix(sub, d) || matchesPrefix(plain, d))) {
      return { command: sub, prefix, decision: 'deny', reason: 'blocked by policy' };
    }
    if (sub.startsWith(TOO_DEEP)) {
      return { command: sub, prefix, decision: 'ask', reason: 'nested too deeply to analyse' };
    }
    if (sub.includes('__SUBST__') && prefix === '__SUBST__') {
      return { command: sub, prefix, decision: 'ask', reason: 'command name comes from a substitution' };
    }
    // A boundary crossing always asks — even with a grant, in every mode.
    const boundary = crossesBoundary(sub, policy);
    if (boundary) return { command: sub, prefix, decision: 'ask', reason: boundary };
    if (granted(prefix)) return { command: sub, prefix, decision: 'allow', reason: 'granted' };
    if (policy.allow.some(a => matchesPrefix(sub, a))) return { command: sub, prefix, decision: 'allow', reason: 'project allowlist' };
    if (policy.mode === 'auto') return { command: sub, prefix, decision: 'allow', reason: 'auto mode (inside sandbox)' };
    if (policy.mode === 'strict') return { command: sub, prefix, decision: 'ask', reason: 'strict mode' };
    const why = notReadOnly(sub, prefixed);
    if (why === null) return { command: sub, prefix, decision: 'allow', reason: 'safe read-only command' };
    return { command: sub, prefix, decision: 'ask', reason: why === 'not a read-only command' ? 'not on the allowlist' : `not read-only: ${why}` };
  });

  const decision: CommandDecision = subcommands.some(s => s.decision === 'deny')
    ? 'deny'
    : subcommands.every(s => s.decision === 'allow') ? 'allow' : 'ask';
  return { decision, subcommands };
}

/** Tools whose argument is a shell command, and where to find it. */
export function extractCommand(toolLabel: string, args: Record<string, unknown>): string | null {
  const real = toolLabel.split('/').pop() ?? toolLabel;
  if (real === 'run_bash' || real === 'terminal_send' || real === 'run_command') {
    const cmd = args['command'] ?? args['keys'] ?? args['input'];
    return typeof cmd === 'string' ? cmd : null;
  }
  return null;
}

/** Grant label for a command prefix (stored in approval_grants.tool_label). */
export const commandGrantLabel = (prefix: string) => `cmd:${prefix}`;
