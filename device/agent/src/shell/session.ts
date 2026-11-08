import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { DevicePlatform, ShellKind } from '../detect.js';
import { OutputBuffer, capOutput } from './output.js';
import { initCommand, launchFor, markerPattern, newNonce, shellEnv, wrapCommand } from './protocol.js';

/**
 * One persistent shell process driven through pipes (ADR 0021): working directory, variables and functions survive from
 * command to command, a command's end and exit status are read from a marker (protocol.ts), no PTY involved.
 *
 * Interrupting. POSIX shells are started `detached`, i.e. as leaders of their own process group, and the shell traps
 * SIGINT. Interrupting a command is `kill(-pgid, SIGINT)` — what Ctrl-C does in a terminal: the command and everything it
 * started die, the trapped shell lives on and prints the marker. If a command shrugs SIGINT off (a builtin loop, a program
 * that handles it), the interrupt escalates to SIGTERM and SIGKILL of the group; that costs the session, which is reported.
 * Windows has no signals: children of the shell are killed with `taskkill /T /F`, the shell itself is spared.
 */

export interface ShellSpec {
  path: string;
  kind: ShellKind;
  platform: DevicePlatform;
}

export interface RunOutcome {
  output: string;
  /** null when the shell ended without reporting one. */
  exitCode: number | null;
  cwd: string | null;
  timedOut: boolean;
  /** The command was interrupted because the call was cancelled. */
  cancelled: boolean;
  /** The shell process is gone (the command ran `exit`, was killed, or ignored every interrupt). */
  shellEnded: boolean;
}

export interface ReadOutcome {
  output: string;
  running: boolean;
  /** Set once for a background command that finished since the last read. */
  finished: { exitCode: number | null; cwd: string | null; shellEnded: boolean } | null;
}

export class SessionBusyError extends Error {
  constructor(public readonly command: string) {
    super(`this session is still running: ${command.length > 80 ? `${command.slice(0, 80)}…` : command}`);
    this.name = 'SessionBusyError';
  }
}

interface Running {
  nonce: string;
  pattern: RegExp;
  command: string;
  background: boolean;
  startedAt: number;
  /** Foreground only. */
  settle?: (o: RunOutcome) => void;
  timedOut: boolean;
  cancelled: boolean;
  timers: NodeJS.Timeout[];
}

const START_TIMEOUT_MS = 20_000;
const ESCALATE_TERM_MS = 3_000;
const ESCALATE_KILL_MS = 2_000;

export class ShellSession {
  readonly createdAt = Date.now();
  lastActivity = Date.now();
  cwd: string;

  private state: 'idle' | 'running' | 'dead' = 'idle';
  private running: Running | null = null;
  /** The foreground command's output while it runs. */
  private current = new OutputBuffer();
  /** Output nobody asked for yet: background commands, and what jobs started with `&` print later. */
  private unread = new OutputBuffer();
  private backgroundResult: ReadOutcome['finished'] = null;
  private readonly decoder = new StringDecoder('utf8');
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private readonly listeners = new Set<() => void>();

  private constructor(
    readonly spec: ShellSpec,
    private readonly child: ChildProcessWithoutNullStreams,
    startCwd: string,
    readonly onExit: (s: ShellSession) => void,
  ) {
    this.cwd = startCwd;
  }

  static async start(spec: ShellSpec, cwd: string, onExit: (s: ShellSession) => void = () => {}): Promise<ShellSession> {
    const launch = launchFor(spec.path, spec.kind);
    const child = spawn(launch.file, launch.args, {
      cwd,
      env: shellEnv(process.env, spec.platform),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: spec.platform !== 'windows',
      windowsHide: true,
    });
    const session = new ShellSession(spec, child, cwd, onExit);
    const nonce = newNonce();
    session.state = 'running';
    session.running = {
      nonce: nonce.full,
      pattern: markerPattern(nonce.full),
      command: '(starting the shell)',
      background: false,
      startedAt: Date.now(),
      timedOut: false,
      cancelled: false,
      timers: [],
    };
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.hardKill();
        reject(new Error(`the shell did not start within ${START_TIMEOUT_MS / 1000}s (${spec.path})`));
      }, START_TIMEOUT_MS);
      session.running!.settle = outcome => {
        clearTimeout(timer);
        if (outcome.shellEnded) reject(new Error(`the shell exited while starting: ${outcome.output.trim().slice(0, 500) || 'no output'}`));
        else resolve();
      };
      child.once('error', err => {
        clearTimeout(timer);
        reject(new Error(`cannot start ${spec.path}: ${err.message}`));
      });
    });
    session.attach();
    child.stdin.write(initCommand(spec.kind, nonce));
    await ready;
    return session;
  }

  private attach(): void {
    const { child } = this;
    child.stdout.on('data', (buf: Buffer) => this.onData(this.decoder.write(buf)));
    // stderr is merged into stdout by the shell itself (`exec 2>&1`); anything still arriving here (PowerShell's
    // native-error stream, a shell that failed before the redirect) is output too.
    child.stderr.on('data', (buf: Buffer) => this.onData(buf.toString('utf8')));
    child.stdin.on('error', () => {
      /* EPIPE after the shell died: the exit handler reports it */
    });
    child.on('exit', (code, signal) => {
      this.exitInfo = { code, signal };
      this.state = 'dead';
      for (const t of this.running?.timers ?? []) clearTimeout(t);
      const r = this.running;
      this.running = null;
      const leftover = this.decoder.end();
      if (leftover) (r && !r.background ? this.current : this.unread).append(leftover);
      if (r?.background) {
        this.backgroundResult = { exitCode: code ?? null, cwd: null, shellEnded: true };
      } else if (r?.settle) {
        r.settle({
          output: this.current.take(),
          exitCode: code ?? null,
          cwd: null,
          timedOut: r.timedOut,
          cancelled: r.cancelled,
          shellEnded: true,
        });
      }
      this.notify();
      this.onExit(this);
    });
  }

  private onData(raw: string): void {
    this.notify();
    const chunk = this.spec.kind === 'powershell' ? raw.replace(/\r/g, '') : raw;
    const r = this.running;
    if (!r) {
      this.unread.append(chunk);
      return;
    }
    const buffer = r.background ? this.unread : this.current;
    buffer.append(chunk);
    const cut = buffer.cutAt(r.pattern);
    if (!cut) return;
    for (const t of r.timers) clearTimeout(t);
    this.running = null;
    this.state = 'idle';
    const exitCode = Number(cut.match[1]);
    this.cwd = cut.match[2] || this.cwd;
    if (r.background) {
      this.backgroundResult = { exitCode, cwd: this.cwd, shellEnded: false };
      if (cut.after) buffer.append(cut.after);
    } else {
      const output = this.current.take();
      if (cut.after) this.unread.append(cut.after);
      r.settle?.({ output, exitCode, cwd: this.cwd, timedOut: r.timedOut, cancelled: r.cancelled, shellEnded: false });
    }
  }

  /** Resolves on the next output or exit — for the short settle wait after shell_send / shell_read. */
  private notify(): void {
    for (const l of [...this.listeners]) l();
  }

  get isRunning(): boolean {
    return this.state === 'running';
  }

  get isDead(): boolean {
    return this.state === 'dead';
  }

  get runningCommand(): string | null {
    return this.running?.command ?? null;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get exitDescription(): string {
    const e = this.exitInfo;
    if (!e) return 'the shell ended';
    return e.signal ? `the shell was killed (${e.signal})` : `the shell exited with code ${e.code ?? '?'}`;
  }

  touch(): void {
    this.lastActivity = Date.now();
  }

  /** Runs `command` and waits for it. On timeout (or cancellation) the command is interrupted and the outcome says so. */
  async run(command: string, timeoutMs: number, signal?: AbortSignal): Promise<RunOutcome> {
    this.assertIdle();
    this.touch();
    return new Promise<RunOutcome>(resolve => {
      const r = this.begin(command, false);
      r.settle = resolve;
      const interruptFor = (reason: 'timeout' | 'cancel'): void => {
        if (this.running !== r) return;
        if (reason === 'timeout') r.timedOut = true;
        else r.cancelled = true;
        this.interrupt();
        this.escalate(r);
      };
      r.timers.push(setTimeout(() => interruptFor('timeout'), timeoutMs));
      if (signal) {
        if (signal.aborted) interruptFor('cancel');
        else signal.addEventListener('abort', () => interruptFor('cancel'), { once: true });
      }
    });
  }

  /** Starts `command` and returns at once; its output is collected with read(). */
  startBackground(command: string): void {
    this.assertIdle();
    this.touch();
    this.backgroundResult = null;
    this.begin(command, true);
  }

  private assertIdle(): void {
    if (this.state === 'dead') throw new Error('the shell has ended');
    if (this.running) throw new SessionBusyError(this.running.command);
  }

  private begin(command: string, background: boolean): Running {
    const nonce = newNonce();
    const r: Running = {
      nonce: nonce.full,
      pattern: markerPattern(nonce.full),
      command,
      background,
      startedAt: Date.now(),
      timedOut: false,
      cancelled: false,
      timers: [],
    };
    this.running = r;
    this.state = 'running';
    this.current = new OutputBuffer();
    this.child.stdin.write(wrapCommand(this.spec.kind, command, nonce));
    return r;
  }

  /** The command ignored the first interrupt: stronger signals, at the cost of the shell. */
  private escalate(r: Running): void {
    r.timers.push(
      setTimeout(() => {
        if (this.running !== r) return;
        this.signalGroup('SIGTERM');
        r.timers.push(
          setTimeout(() => {
            if (this.running === r) this.hardKill();
          }, ESCALATE_KILL_MS),
        );
      }, ESCALATE_TERM_MS),
    );
  }

  /** Writes to the running command's stdin. */
  send(input: string): void {
    if (this.state === 'dead') throw new Error('the shell has ended');
    if (!this.running) throw new Error('no command is running in this session — nothing would read the input; use shell_run');
    if (this.spec.kind === 'powershell') {
      throw new Error('shell_send is not available in PowerShell sessions (the shell itself reads its stdin); use a POSIX shell for interactive programs');
    }
    this.touch();
    this.child.stdin.write(`${input}\n`);
  }

  /** New output since the last read (and whether the background command finished). */
  read(): ReadOutcome {
    this.touch();
    const output = this.unread.take();
    const finished = this.backgroundResult;
    this.backgroundResult = null;
    return { output, running: this.state === 'running', finished };
  }

  /** Waits until output arrives and then stays quiet for `quietMs`, or `maxMs` passes, or the command ends. */
  async settle(maxMs: number, quietMs: number): Promise<void> {
    if (!this.running && this.unread.isEmpty()) return;
    await new Promise<void>(resolve => {
      let quiet: NodeJS.Timeout | null = null;
      const finish = (): void => {
        if (quiet) clearTimeout(quiet);
        clearTimeout(cap);
        this.listeners.delete(onActivity);
        resolve();
      };
      const onActivity = (): void => {
        if (!this.running) return finish();
        if (quiet) clearTimeout(quiet);
        quiet = setTimeout(finish, quietMs);
      };
      const cap = setTimeout(finish, maxMs);
      this.listeners.add(onActivity);
    });
  }

  /** Ctrl-C for the running command; the shell stays. */
  interrupt(): void {
    if (this.state === 'dead') return;
    if (this.spec.platform === 'windows') this.killChildrenWindows();
    else this.signalGroup('SIGINT');
  }

  private signalGroup(sig: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (!pid) return;
    try {
      process.kill(-pid, sig);
    } catch {
      /* group already gone */
    }
  }

  private killChildrenWindows(): void {
    const pid = this.child.pid;
    if (!pid) return;
    // The children of the shell, not the shell: taskkill /T takes each child's own subtree with it.
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}' | ForEach-Object { taskkill /T /F /PID $_.ProcessId | Out-Null }`,
      ],
      { windowsHide: true },
      () => {},
    );
  }

  /** SIGKILL / taskkill of the whole tree. */
  hardKill(): void {
    const pid = this.child.pid;
    if (!pid || this.state === 'dead') return;
    if (this.spec.platform === 'windows') execFile('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true }, () => {});
    else this.signalGroup('SIGKILL');
  }

  /** Ends the shell and everything it started: SIGTERM to the group, SIGKILL if it is still there shortly after. */
  async close(): Promise<void> {
    if (this.state === 'dead') return;
    const exited = new Promise<void>(resolve => this.child.once('exit', () => resolve()));
    if (this.spec.platform === 'windows') this.hardKill();
    else {
      this.signalGroup('SIGTERM');
      const t = setTimeout(() => this.hardKill(), 1_500);
      void exited.then(() => clearTimeout(t));
    }
    await Promise.race([exited, new Promise<void>(r => setTimeout(r, 4_000))]);
  }
}
