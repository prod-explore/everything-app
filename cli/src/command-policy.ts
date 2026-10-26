/**
 * Command policy engine: shell commands are approved per command, not per tool (an "always" on run_bash would let
 * every command through).
 *
 * A command is split into its sub-commands (`a && b | c; $(d)`, `bash -c "…"`, function bodies, `find -exec`), each one
 * is classified allow / ask / deny against the project policy and the persisted prefix grants, and the whole command is
 * only as permissive as its least permissive part. An allow on `ls` therefore never lets `ls && rm -rf ~` through.
 * Rules are matched against the words the shell will actually run: quotes, escapes, `$IFS`, binary paths, variable
 * assignments and wrappers such as `sudo -u x`, `env -S`, `nice -n 5` or `timeout 5` are taken off first.
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
  return wordsOf(sub).map(w => w.text);
}

interface Word { text: string; start: number }

const ANSI_SIMPLE: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v' };

/** One escape inside `$'…'` starting after the backslash: its text and how many characters it used (`\x72` is `r`). */
function ansiEscape(src: string, at: number): [string, number] {
  const c = src[at]!;
  if (c in ANSI_SIMPLE) return [ANSI_SIMPLE[c]!, 1];
  const code = (re: RegExp, base: number): [string, number] | null => {
    const m = re.exec(src.slice(at));
    return m ? [String.fromCodePoint(parseInt(m[1]!, base)), m[0].length] : null;
  };
  return code(/^x([0-9A-Fa-f]{1,2})/, 16) ?? code(/^u([0-9A-Fa-f]{1,4})/, 16) ?? code(/^U([0-9A-Fa-f]{1,8})/, 16) ?? code(/^([0-7]{1,3})/, 8) ?? [c, 1];
}

function wordsOf(src: string): Word[] {
  const out: Word[] = [];
  let cur = '';
  let start = -1;
  const begin = (i: number) => { if (start === -1) start = i; };
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === "'") {
      begin(i);
      const end = src.indexOf("'", i + 1);
      const stop = end === -1 ? src.length : end;
      cur += src.slice(i + 1, stop); i = stop; continue;
    }
    if (c === '$' && src[i + 1] === "'") {
      begin(i);
      let j = i + 2;
      while (j < src.length && src[j] !== "'") {
        if (src[j] === '\\' && j + 1 < src.length) {
          const [text, used] = ansiEscape(src, j + 1);
          cur += text; j += 1 + used; continue;
        }
        cur += src[j]; j++;
      }
      i = j; continue;
    }
    if (c === '"') {
      begin(i);
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && /["\\$`]/.test(src[j + 1] ?? '')) j++;
        cur += src[j]; j++;
      }
      i = j; continue;
    }
    if (c === '\\' && i + 1 < src.length) { begin(i); cur += src[++i]; continue; }
    if (/\s/.test(c)) { if (start !== -1) out.push({ text: cur, start }); cur = ''; start = -1; continue; }
    begin(i); cur += c;
  }
  if (start !== -1) out.push({ text: cur, start });
  return out;
}

// ─── Destructive commands (grants no wider than one chat) ───────────────────

/** Whether any word of `args` (before `--`) is one of these options; short ones also inside a cluster. */
const anyOption = (args: string[], set: OptionSet) => hasOption(args, set) !== null;

const GIT_DESTRUCTIVE: Record<string, (args: string[]) => boolean> = {
  reset: () => true,
  clean: () => true,
  push: () => true,
  restore: () => true,
  rm: () => true,
  'filter-branch': () => true,
  'filter-repo': () => true,
  // `git checkout -- f`, `git checkout .`, `git checkout -f` throw away changes; switching branches does not.
  checkout: args => args.includes('--') || args.includes('.') || anyOption(args, { long: ['force', 'overwrite-ignore'], short: 'f' }),
  stash: args => args[0] === 'drop' || args[0] === 'clear',
  branch: args => anyOption(args, { long: ['delete', 'force'], short: 'dDf' }),
  'update-ref': args => anyOption(args, { short: 'd' }),
  reflog: args => args[0] === 'delete' || args[0] === 'expire',
};

/** Container verbs that remove or stop: `docker rm`, `docker image prune`, `podman stop`… */
const DOCKER_REMOVE = /^(rm|rmi|kill|stop|prune)$/;

/**
 * Commands that destroy work or stop things: deleting files, discarding changes, rewriting or pushing history, killing
 * processes, removing containers. Approving one is never remembered beyond the chat, and a project-wide or permanent grant
 * on the same prefix (given for a harmless use, like `git checkout main`) does not cover it either.
 */
export function isDestructive(sub: string): boolean {
  return destructiveWords(unwrap(sub).words);
}

function destructiveWords(words: string[]): boolean {
  const cmd = words[0] ?? '';
  const args = words.slice(1);
  switch (cmd) {
    case 'rm': case 'rmdir': case 'unlink': case 'shred': case 'truncate': case 'dd':
    case 'kill': case 'pkill': case 'killall':
      return true;
    case 'find':
      // -exec/-ok run a command this gate never sees on its own.
      return args.some(a => /^-(delete|exec|execdir|ok|okdir)$/.test(a));
    case 'git': {
      const verb = args[0];
      return verb !== undefined && (GIT_DESTRUCTIVE[verb]?.(args.slice(1)) ?? false);
    }
    case 'docker': case 'podman': {
      // `docker rm x`, `docker container rm x`, `docker system prune`, `docker volume rm v`, `docker compose down`…
      const [a, b] = args;
      if (a === 'compose') return b === 'down' || b === 'rm' || b === 'kill' || b === 'stop';
      return DOCKER_REMOVE.test(a ?? '') || (/^(container|image|volume|network|system|builder)$/.test(a ?? '') && DOCKER_REMOVE.test(b ?? ''));
    }
    case 'docker-compose':
      return /^(down|rm|kill|stop)$/.test(args[0] ?? '');
    case 'kubectl':
      return args[0] === 'delete' || args[0] === 'drain';
    case 'helm':
      return args[0] === 'uninstall' || args[0] === 'delete';
    case 'crontab':
      return args.some(a => /^-[a-z]*r/.test(a));
    default:
      return false;
  }
}

/** Always blocked, regardless of mode or grants. */
const DENY_PATTERNS: RegExp[] = [
  /^rm\s+(-[\w-]+\s+)*(\/+\.?\*?|~\/?|\$HOME\/?|\$\{HOME\}\/?)(\s|$)/,
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

/**
 * A sub-command: `command` as shown (from the real command on, original quoting), `words` as the shell will run it
 * (quotes removed, wrappers and assignments stripped, binary path dropped), and whether assignments or a wrapper were
 * stripped (`prefixed`).
 */
interface SplitPart { command: string; words: string[]; prefixed: boolean }

function splitDetailed(command: string, depth = 0): SplitPart[] {
  const out: string[] = [];
  splitInto(command, out, 0);
  return out.flatMap((raw): SplitPart[] => {
    const part = unwrap(raw);
    if (part.words.length === 0) return [];
    // `bash -c "…"`, `sh -c '…'`, `eval "…"`: the string is itself a command line.
    const script = shellScript(part.words);
    if (script === null) return [part, ...findExecs(part)];
    if (depth > 4) return [{ command: `${TOO_DEEP} ${part.command}`, words: [TOO_DEEP], prefixed: part.prefixed }];
    return [
      { command: part.words[0]!, words: [part.words[0]!], prefixed: part.prefixed },
      ...splitDetailed(script, depth + 1).map(p => ({ ...p, prefixed: p.prefixed || part.prefixed })),
    ];
  });
}

/** `find … -exec cmd {} ;` runs cmd for every match: each such command is a sub-command of its own. */
function findExecs(part: SplitPart): SplitPart[] {
  if (part.words[0] !== 'find') return [];
  const out: SplitPart[] = [];
  for (let i = 1; i < part.words.length; i++) {
    if (!/^-(exec|execdir|ok|okdir)$/.test(part.words[i]!)) continue;
    const end = part.words.findIndex((w, k) => k > i && (w === ';' || w === '+'));
    const words = part.words.slice(i + 1, end === -1 ? undefined : end);
    if (words.length) out.push({ ...unwrap(words.map(w => (/[\s'"\\$`;&|<>()]/.test(w) ? `'${w.replace(/'/g, `'\\''`)}'` : w)).join(' ')), prefixed: part.prefixed });
    i = end === -1 ? part.words.length : end;
  }
  return out;
}

/**
 * Commands that run the rest of their arguments as a command. `values`: short options taking a value; `long`: long ones;
 * `operands`: plain words before the command (`timeout 5 cmd`); `split`: the option whose value is itself a command line
 * (`env -S 'cmd args'`).
 */
interface Wrapper { values?: string; long?: string[]; operands?: number; split?: { short: string; long: string } }

const WRAPPERS: Record<string, Wrapper> = {
  sudo: { values: 'ughpCDRTUrt', long: ['user', 'group', 'host', 'prompt', 'close-from', 'chdir', 'chroot', 'command-timeout', 'other-user', 'role', 'type'] },
  doas: { values: 'uC' },
  env: { values: 'uC', long: ['unset', 'chdir'], split: { short: 'S', long: 'split-string' } },
  nice: { values: 'n', long: ['adjustment'] },
  ionice: { values: 'cnpPu', long: ['class', 'classdata', 'pid', 'pgid', 'uid'] },
  timeout: { values: 'sk', long: ['signal', 'kill-after'], operands: 1 },
  stdbuf: { values: 'ioe', long: ['input', 'output', 'error'] },
  time: { values: 'fo', long: ['format', 'output'] },
  xargs: { values: 'IadEeLlnPs', long: ['arg-file', 'delimiter', 'eof', 'replace', 'max-lines', 'max-args', 'max-procs', 'max-chars', 'process-slot-var'] },
  watch: { values: 'nq', long: ['interval', 'equexit'] },
  exec: { values: 'a' },
  nohup: {},
  setsid: {},
  command: {},
  builtin: {},
};

/** Words that only start a compound command; the command follows them. */
const LEADING_KEYWORDS = new Set(['if', 'then', 'do', 'else', 'elif', 'while', 'until', '!', 'coproc', '{']);
const CLOSING_KEYWORDS = new Set(['fi', 'done', 'esac', 'then', 'do', 'else']);
/** `$IFS` splits words like a space does (`rm${IFS}-rf${IFS}/`). */
const IFS_REF = /\$\{IFS\}|\$IFS(?![A-Za-z0-9_])/g;

/** Strips assignments, wrappers (with their options) and leading keywords off one sub-command. */
function unwrap(raw: string): SplitPart {
  const src = raw.replace(IFS_REF, ' ');
  const w = wordsOf(src);
  const rest = (i: number) => (i < w.length ? ` ${src.slice(w[i]!.start)}` : '');
  let i = 0;
  let prefixed = false;
  while (i < w.length) {
    const text = w[i]!.text;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(text)) { prefixed = true; i++; continue; }
    if (LEADING_KEYWORDS.has(text)) { i++; continue; }
    // A function definition runs its body: `f() { body; }`, `function f { body; }`.
    if (/^[A-Za-z_][\w-]*\(\)\{?$/.test(text) || text === '()') { i++; continue; }
    if (text === 'function' && i + 1 < w.length) { i += 2; continue; }
    // `case x in pattern) cmd;;` runs cmd.
    if (text === 'case') { const at = w.findIndex((x, k) => k > i && x.text === 'in'); i = at === -1 ? w.length : at + 1; continue; }
    if (/^\(?[^()]*\)$/.test(text) && i + 1 < w.length) { i++; continue; }
    const name = text.replace(/^.*\//, '');
    const spec = WRAPPERS[name];
    // `command -v x` looks a name up; it does not run it.
    if (!spec || (name === 'command' && /^-[A-Za-z]*[vV]/.test(w[i + 1]?.text ?? ''))) break;
    const at = i;
    const prefixedBefore = prefixed;
    prefixed = true;
    i++;
    while (i < w.length) {
      const opt = w[i]!.text;
      if (opt === '--') { i++; break; }
      if (!opt.startsWith('-') || opt === '-') break;
      i++;
      if (opt.startsWith('--')) {
        const eq = opt.indexOf('=');
        const optName = opt.slice(2, eq === -1 ? undefined : eq);
        if (optName === spec.split?.long) {
          const script = eq === -1 ? (w[i++]?.text ?? '') : opt.slice(eq + 1);
          return withPrefix(unwrap(script + rest(i)));
        }
        if (eq === -1 && spec.long?.includes(optName)) i++;
        continue;
      }
      const letters = opt.slice(1);
      for (let k = 0; k < letters.length; k++) {
        const c = letters[k]!;
        if (c === spec.split?.short) {
          const script = letters.slice(k + 1) || (w[i++]?.text ?? '');
          return withPrefix(unwrap(script + rest(i)));
        }
        // A value option ends the cluster: its value is the rest of the word, or the next word.
        if (spec.values?.includes(c)) { if (k === letters.length - 1) i++; break; }
      }
    }
    i += Math.min(spec.operands ?? 0, w.length - i);
    // Nothing left to run: the wrapper is the command itself (`env` prints the environment).
    if (i >= w.length) { i = at; prefixed = prefixedBefore; break; }
  }
  const left = w.slice(i);
  if (left.length === 0 || (left.length === 1 && CLOSING_KEYWORDS.has(left[0]!.text))) return { command: '', words: [], prefixed };
  const words = left.map(x => x.text);
  words[0] = words[0]!.replace(/^.*\//, ''); // /usr/bin/git → git
  return { command: src.slice(left[0]!.start).replace(/\s+/g, ' ').trim(), words, prefixed };

  function withPrefix(p: SplitPart): SplitPart {
    return { ...p, prefixed: true };
  }
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash']);
/** bash options that take the next word as their value. */
const SHELL_VALUE_OPTIONS = /^(?:[-+][A-Za-z]*[oO]|--rcfile|--init-file)$/;

/** The command line a shell, `eval`, `trap` or `su -c` runs (`bash -c "…"`), or null when this is not such a call. */
function shellScript(words: string[]): string | null {
  if (words[0] === 'eval') return words.slice(1).join(' ');
  // `trap 'cmd' EXIT` runs cmd later, in this shell.
  if (words[0] === 'trap') return words[1] !== undefined && !words[1].startsWith('-') ? words[1] : null;
  if (words[0] === 'su') {
    const at = words.findIndex(w => /^-[A-Za-z]*c$/.test(w) || w === '--command');
    if (at !== -1) return words[at + 1] ?? '';
    const eq = words.find(w => w.startsWith('--command='));
    return eq ? eq.slice('--command='.length) : null;
  }
  if (!SHELLS.has(words[0]!)) return null;
  let runsString = false;
  let i = 1;
  while (i < words.length && /^[-+]./.test(words[i]!)) {
    const opt = words[i++]!;
    if (opt === '--') break;
    if (/^-[A-Za-z]*c/.test(opt)) runsString = true;
    if (SHELL_VALUE_OPTIONS.test(opt)) i++;
  }
  return runsString ? (words[i] ?? '') : null;
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
  /** Destroys work or stops things (see isDestructive): approvable once or for this chat only. */
  destructive?: true;
}

export interface CommandVerdict {
  decision: CommandDecision;
  subcommands: SubcommandVerdict[];
}

/**
 * Classifies a full command line. `granted(prefix, opts)` reports whether a persisted grant covers a prefix in the
 * current context (chat/project/always, model/skill scoped); with `chatOnly` only a grant for this chat counts.
 */
export function evaluateCommand(command: string, policy: CommandPolicy, granted: (prefix: string, opts: { chatOnly: boolean }) => boolean): CommandVerdict {
  const parts = splitDetailed(command);
  if (parts.length === 0) return { decision: 'ask', subcommands: [] };

  const subcommands = parts.map((part): SubcommandVerdict => {
    const verdict = classify(part);
    return destructiveWords(part.words) && verdict.decision !== 'deny' ? { ...verdict, destructive: true } : verdict;
  });

  const decision: CommandDecision = subcommands.some(s => s.decision === 'deny')
    ? 'deny'
    : subcommands.every(s => s.decision === 'allow') ? 'allow' : 'ask';
  return { decision, subcommands };

  function classify({ command: sub, words, prefixed }: SplitPart): SubcommandVerdict {
    // Rules are matched against the command as the shell will run it (`'rm' -rf "/"`, `/bin/rm`, `sudo -u x rm`, `"git" push`).
    const run = words.join(' ');
    const prefix = grantPrefix(run);
    if (DENY_PATTERNS.some(re => re.test(sub) || re.test(run)) || policy.deny.some(d => matchesPrefix(sub, d) || matchesPrefix(run, d))) {
      return { command: sub, prefix, decision: 'deny', reason: 'blocked by policy' };
    }
    if (words[0] === TOO_DEEP) {
      return { command: sub, prefix, decision: 'ask', reason: 'nested too deeply to analyse' };
    }
    if (words[0] === '__SUBST__' || words[0]!.includes('$')) {
      return { command: sub, prefix, decision: 'ask', reason: 'command name comes from a substitution or a variable' };
    }
    // A boundary crossing always asks — even with a grant, in every mode.
    const boundary = crossesBoundary(run, policy);
    if (boundary) return { command: sub, prefix, decision: 'ask', reason: boundary };
    if (granted(prefix, { chatOnly: destructiveWords(words) })) return { command: sub, prefix, decision: 'allow', reason: 'granted' };
    if (policy.allow.some(a => matchesPrefix(run, a))) return { command: sub, prefix, decision: 'allow', reason: 'project allowlist' };
    if (policy.mode === 'auto') return { command: sub, prefix, decision: 'allow', reason: 'auto mode (inside sandbox)' };
    if (policy.mode === 'strict') return { command: sub, prefix, decision: 'ask', reason: 'strict mode' };
    const why = notReadOnly(sub, prefixed);
    if (why === null) return { command: sub, prefix, decision: 'allow', reason: 'safe read-only command' };
    return { command: sub, prefix, decision: 'ask', reason: why === 'not a read-only command' ? 'not on the allowlist' : `not read-only: ${why}` };
  }
}

/** Whether a grant on this sub-command's prefix can be stored at all (not for unanalysable or substituted names). */
export function grantable(v: Pick<SubcommandVerdict, 'decision' | 'prefix'>): boolean {
  return v.decision === 'ask' && v.prefix !== '' && v.prefix !== '__SUBST__' && v.prefix !== TOO_DEEP;
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
