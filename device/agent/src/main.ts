import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { Agent, readTokenFile } from './agent.js';
import { ConfigError, loadConfig, resolveConfig } from './config.js';
import { defaultDataDir, hostEnv } from './detect.js';
import type { AgentMessage } from './protocol.js';
import { runStdio } from './stdio.js';
import { AGENT_VERSION } from './version.js';
import * as nodePath from 'node:path';

/**
 * evvapp-device — the EverythingApp device agent.
 *
 *   evvapp-device pair --server <url> --name <name>   pair this machine (approve the code in the browser)
 *   evvapp-device run                                  stay connected and serve tools
 *   evvapp-device status                               what is configured, without connecting
 *   evvapp-device --stdio                              tray mode: JSON lines on stdin/stdout (used by the tray app)
 */

const USAGE = `evvapp-device ${AGENT_VERSION} — EverythingApp device agent

Usage:
  evvapp-device pair --server <url> --name <name> [--config <path>] [--data-dir <dir>]
  evvapp-device run [--config <path>] [--data-dir <dir>]
  evvapp-device status [--config <path>] [--data-dir <dir>]
  evvapp-device --stdio            (tray mode: JSON lines on stdin/stdout)

Options:
  --server <url>     EverythingApp server, e.g. https://evvapp.example.com (saved to the config after pairing)
  --name <name>      name of this device as shown in the app (1-40 characters)
  --config <path>    config file (default: <data-dir>/config.json)
  --data-dir <dir>   config, token and browser profile directory
                       Windows %APPDATA%\\evvapp-device, macOS ~/Library/Application Support/evvapp-device,
                       Linux \${XDG_CONFIG_HOME:-~/.config}/evvapp-device
  -h, --help         show this help
  -v, --version      show the version

The device token is kept in <data-dir>/token (mode 0600); EVVAPP_DEVICE_TOKEN overrides it.
Reference: docs/devices.md
`;

function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd!, args as string[], { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* printing the URL is the fallback */
  }
}

function printer(): (m: AgentMessage) => void {
  const stamp = (): string => new Date().toISOString().slice(11, 19);
  return m => {
    switch (m.type) {
      case 'status':
        console.log('[%s] %s%s', stamp(), m.state, m.detail ? ` — ${m.detail}` : '');
        break;
      case 'pairing':
        console.log('\nApprove this device in the app:\n  code  %s\n  open  %s\n(the code on that page must match)\n', m.userCode, m.url);
        openInBrowser(m.url);
        break;
      case 'paired':
        console.log('[%s] paired (device %s)', stamp(), m.deviceId);
        break;
      case 'unpaired':
        console.log(`[${stamp()}] unpaired`);
        break;
      case 'activity':
        console.log('[%s] %s%s', stamp(), m.tool, m.summary ? `: ${m.summary}` : '');
        break;
      case 'log':
        console.error('[%s] %s: %s', stamp(), m.level, m.message);
        break;
    }
  };
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      server: { type: 'string' },
      name: { type: 'string' },
      config: { type: 'string' },
      'data-dir': { type: 'string' },
      stdio: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });
  if (values.help || positionals[0] === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${AGENT_VERSION}\n`);
    return 0;
  }

  if (values.stdio) {
    // stdout belongs to the protocol: anything a dependency prints with console.log must not reach it.
    console.log = console.info = console.debug = (...args: unknown[]) => console.error(...args);
    return new Promise<number>(resolve => {
      const { agent } = runStdio({ input: process.stdin, output: process.stdout, onExit: resolve });
      process.on('exit', () => agent()?.killNow());
    });
  }

  const command = positionals[0] ?? 'run';
  const dataDir = values['data-dir'] ?? defaultDataDir(hostEnv());
  const configPath = values.config ?? nodePath.join(dataDir, 'config.json');

  if (command === 'status') return status(configPath, dataDir);
  if (command !== 'run' && command !== 'pair') {
    process.stderr.write(`unknown command "${command}"\n\n${USAGE}`);
    return 64;
  }

  const token = process.env['EVVAPP_DEVICE_TOKEN']?.trim() || (await readTokenFile(dataDir));
  const agent = new Agent({ configPath, dataDir, token: command === 'pair' ? null : token, persistToken: true, emit: printer() });
  process.on('exit', () => agent.killNow());

  if (command === 'pair') {
    const outcome = await agent.pair(
      { ...(values.server ? { server: values.server } : {}), ...(values.name ? { name: values.name } : {}) },
      false,
    );
    if (!outcome.ok) {
      process.stderr.write(`pairing failed: ${outcome.error}\n`);
      return 1;
    }
    process.stdout.write(`Paired. Start the agent with: evvapp-device run${values.config ? ` --config ${values.config}` : ''}${values['data-dir'] ? ` --data-dir ${values['data-dir']}` : ''}\n`);
    return 0;
  }

  // run: stay up until revoked/replaced (exit 2/3) or signalled.
  return new Promise<number>(resolve => {
    const stop = (code: number): void => {
      void agent.shutdown().finally(() => resolve(code));
    };
    process.once('SIGINT', () => stop(0));
    process.once('SIGTERM', () => stop(0));
    const timer = setInterval(() => {
      const s = agent.currentState;
      if (s === 'revoked') stop(2);
      else if (s === 'replaced') stop(3);
      else if (s === 'unpaired') {
        process.stderr.write('this device is not paired. Run: evvapp-device pair --server <url> --name <name>\n');
        stop(1);
      }
    }, 500);
    timer.unref();
    void agent.start().then(() => {
      if (agent.currentState === 'error') stop(1);
    });
    // Keep the loop alive while connected (the socket does, but not between reconnect attempts).
    setInterval(() => {}, 1 << 30);
  });
}

async function status(configPath: string, dataDir: string): Promise<number> {
  try {
    const cfg = resolveConfig(await loadConfig(configPath), dataDir, hostEnv());
    const token = process.env['EVVAPP_DEVICE_TOKEN']?.trim() || (await readTokenFile(dataDir));
    const lines = [
      `evvapp-device ${AGENT_VERSION}`,
      `config:   ${configPath}`,
      `data dir: ${dataDir}`,
      `server:   ${cfg.server ?? '(not set)'}`,
      `name:     ${cfg.deviceName}`,
      `paired:   ${token ? 'yes' : 'no'}`,
      `platform: ${cfg.platform}`,
      `shell:    ${cfg.shell.enabled ? `${cfg.shell.kind} ${cfg.shell.path} (cwd ${cfg.shell.cwd})` : 'off'}`,
      `files:    ${cfg.files.enabled ? `${cfg.files.write ? 'read-write' : 'read-only'} ${cfg.files.roots.join(', ')}` : 'off'}`,
      `browser:  ${cfg.browser.enabled ? `${cfg.browser.product} ${cfg.browser.mode} ${cfg.browser.executable} (profile ${cfg.browser.userDataDir})` : 'off'}`,
      ...cfg.warnings.map(w => `warning:  ${w}`),
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`${err instanceof ConfigError ? err.message : (err as Error).message}\n`);
    return 1;
  }
}

main(process.argv.slice(2)).then(
  code => process.exit(code),
  err => {
    process.stderr.write(`evvapp-device: ${(err as Error).message}\n`);
    process.exit(1);
  },
);
