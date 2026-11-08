import { randomBytes } from 'node:crypto';
import type { DevicePlatform, ShellKind } from '../detect.js';

/**
 * How commands are fed to a long-lived shell through plain pipes (ADR 0021), and how their end is recognised.
 *
 * Every command is followed, in the SAME input unit the shell parses, by a line that prints a marker holding a random
 * nonce, the exit status and the working directory:
 *
 *     \n<<EVV:<nonce>:<status>:<cwd>>>\n
 *
 * The shell prints it only after the command finished, so the output before it is exactly the command's and the marker
 * says how it ended. Three details carry the weight:
 *
 *  - The command travels as a quoted heredoc inside `eval "$(cat <<'DELIM' … DELIM)"`. A command with an unterminated
 *    quote or a syntax error then fails inside eval instead of swallowing the marker line, and `cd`, `export` and
 *    functions still act on the persistent shell (eval runs in it).
 *  - The marker line is part of the same parsed unit, so the shell has read it before the command starts. A command that
 *    reads stdin (`read`, `cat`) gets what `shell_send` writes afterwards, never the marker.
 *  - The nonce is split across two printf arguments, so a shell error message that quotes the source line never contains
 *    the complete marker; and since it is random per command, output of the command itself cannot forge one.
 */

export function newNonce(): { n1: string; n2: string; full: string } {
  const hex = randomBytes(8).toString('hex');
  return { n1: hex.slice(0, 8), n2: hex.slice(8), full: hex };
}

/** Matches the marker of one command in the stream; the leading newline is the one the marker itself prints. */
export function markerPattern(nonce: string): RegExp {
  return new RegExp(`\\n<<EVV:${nonce}:(-?\\d+):([\\s\\S]*?)>>\\n`);
}

export function posixCommand(command: string, nonce: ReturnType<typeof newNonce>): string {
  const delim = `__EVV_CMD_${nonce.full}__`;
  const body = command.replace(/\r\n/g, '\n');
  return (
    `eval "$(cat <<'${delim}'\n${body}\n${delim}\n)"; __evv_rc=$?; ` +
    `printf '\\n<<EVV:%s%s:%s:%s>>\\n' '${nonce.n1}' '${nonce.n2}' "$__evv_rc" "$PWD"\n`
  );
}

/**
 * PowerShell reads its script from stdin line by line, so the command is sent base64-encoded on one line (also immune to
 * the console code page mangling non-ASCII text). The status is the last native program's exit code, else 1 if the command
 * added to `$Error`, else 0 — `$?` itself is not usable after a pipeline.
 */
export function powershellCommand(command: string, nonce: ReturnType<typeof newNonce>): string {
  const b64 = Buffer.from(command, 'utf8').toString('base64');
  return (
    `$global:LASTEXITCODE=$null; $__evv_e0=$null; if ($Error.Count -gt 0) { $__evv_e0=$Error[0] }; ` +
    `try { . ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))) 2>&1 ` +
    `| Out-String -Stream | ForEach-Object { [Console]::Out.WriteLine($_) } } catch { [Console]::Out.WriteLine($_.ToString()) }; ` +
    `$__evv_rc = 0; if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { $__evv_rc = $LASTEXITCODE } ` +
    `elseif ($Error.Count -gt 0 -and -not [object]::ReferenceEquals($Error[0], $__evv_e0)) { $__evv_rc = 1 }; ` +
    `[Console]::Out.WriteLine(''); [Console]::Out.WriteLine('<<EVV:${nonce.n1}' + '${nonce.n2}:' + $__evv_rc + ':' + (Get-Location).Path + '>>')\n`
  );
}

export function wrapCommand(kind: ShellKind, command: string, nonce: ReturnType<typeof newNonce>): string {
  return kind === 'powershell' ? powershellCommand(command, nonce) : posixCommand(command, nonce);
}

/**
 * First thing sent to a new shell. POSIX: stderr joins stdout for the shell and everything it starts (output order is
 * kept, as in a terminal), and SIGINT is trapped — that trap is what lets the timeout interrupt a running command
 * (SIGINT to the process group) without ending the shell: a trapped shell carries on after its child died of the signal.
 */
export function initCommand(kind: ShellKind, nonce: ReturnType<typeof newNonce>): string {
  if (kind === 'powershell') {
    return (
      `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; ` +
      `[Console]::Out.WriteLine(''); [Console]::Out.WriteLine('<<EVV:${nonce.n1}' + '${nonce.n2}:0:' + (Get-Location).Path + '>>')\n`
    );
  }
  return (
    `exec 2>&1; trap : INT; unset PROMPT_COMMAND; ` +
    `printf '\\n<<EVV:%s%s:%s:%s>>\\n' '${nonce.n1}' '${nonce.n2}' 0 "$PWD"\n`
  );
}

export interface ShellLaunch {
  file: string;
  args: string[];
}

export function launchFor(shellPath: string, kind: ShellKind): ShellLaunch {
  if (kind === 'powershell') {
    return { file: shellPath, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'] };
  }
  const base = shellPath.split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, '');
  // A login shell picks up the PATH the person's terminals have (matters most on macOS, where a GUI app starts with a bare one).
  return { file: shellPath, args: base === 'bash' || base === 'zsh' ? ['-l'] : [] };
}

/** Environment for the shell: no pagers or prompts that would wait for a person who is not typing. */
export function shellEnv(base: NodeJS.ProcessEnv, platform: DevicePlatform): NodeJS.ProcessEnv {
  return {
    ...base,
    TERM: 'dumb',
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    EVVAPP_DEVICE: '1',
    // Git Bash's /etc/profile cd's to $HOME for login shells unless told to stay.
    ...(platform === 'windows' ? { CHERE_INVOKING: '1' } : {}),
  };
}
