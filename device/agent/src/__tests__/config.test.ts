import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { describe, it } from 'node:test';
import { ConfigError, loadConfig, parseConfig, resolveConfig, updateConfigFile } from '../config.js';
import {
  browserCandidates,
  defaultDataDir,
  defaultUserDataDir,
  detectBrowserExecutable,
  detectShell,
  describeShell,
  shellKind,
  type HostEnv,
} from '../detect.js';
import { AGENT_VERSION } from '../version.js';

/** A fake machine: only the listed paths exist. */
function machine(platform: HostEnv['platform'], env: Record<string, string>, files: string[], home = platform === 'windows' ? 'C:\\Users\\me' : '/home/me'): HostEnv {
  const set = new Set(files);
  return { platform, env, home, exists: p => set.has(p) };
}

describe('config schema', () => {
  it('an empty file means the documented defaults', () => {
    const c = parseConfig({});
    assert.equal(c.server, null);
    assert.ok(c.deviceName.length >= 1 && c.deviceName.length <= 40);
    assert.deepEqual(c.shell, { enabled: true, path: null, cwd: null });
    assert.deepEqual(c.files, { enabled: false, roots: [], write: false });
    assert.deepEqual(c.browser, {
      enabled: false,
      mode: 'profile',
      product: 'brave',
      executable: null,
      userDataDir: null,
      profileDirectory: 'Default',
      allowPrivateNetwork: true,
    });
  });

  it('accepts the example from docs/devices.md', () => {
    const c = parseConfig({
      server: 'https://evvapp.example.com',
      deviceName: 'PC',
      shell: { enabled: true, path: null, cwd: null },
      files: { enabled: false, roots: [], write: false },
      browser: { enabled: false, mode: 'profile', product: 'brave', executable: null, userDataDir: null, profileDirectory: 'Default', allowPrivateNetwork: true },
    });
    assert.equal(c.server, 'https://evvapp.example.com');
  });

  it('rejects bad values with a readable message', () => {
    for (const bad of [
      { server: 'ftp://x' },
      { server: 'not a url' },
      { deviceName: '' },
      { deviceName: 'x'.repeat(41) },
      { browser: { mode: 'weird' } },
      { browser: { product: 'firefox' } },
      { files: { roots: 'C:\\' } },
      { shell: { enabled: 'yes' } },
    ]) {
      assert.throws(() => parseConfig(bad), ConfigError, JSON.stringify(bad));
    }
    assert.throws(() => parseConfig({ browser: { mode: 'weird' } }), /browser/);
  });

  it('loadConfig: missing file → defaults; broken JSON and invalid values → ConfigError naming the file', async () => {
    const dir = await mkdtemp(nodePath.join(tmpdir(), 'evv-cfg-'));
    assert.equal((await loadConfig(nodePath.join(dir, 'nope.json'))).shell.enabled, true);
    const broken = nodePath.join(dir, 'broken.json');
    await writeFile(broken, '{ nope');
    await assert.rejects(loadConfig(broken), /broken\.json is not valid JSON/);
    const invalid = nodePath.join(dir, 'invalid.json');
    await writeFile(invalid, JSON.stringify({ files: { write: 'maybe' } }));
    await assert.rejects(loadConfig(invalid), /invalid\.json: invalid config[\s\S]*write/);
    const bom = nodePath.join(dir, 'bom.json');
    await writeFile(bom, `\uFEFF${JSON.stringify({ deviceName: 'Laptop' })}`);
    assert.equal((await loadConfig(bom)).deviceName, 'Laptop');
  });

  it('updateConfigFile keeps unknown keys and refuses to write an invalid file', async () => {
    const dir = await mkdtemp(nodePath.join(tmpdir(), 'evv-cfg-'));
    const file = nodePath.join(dir, 'sub', 'config.json');
    await updateConfigFile(file, { server: 'https://a.example', deviceName: 'One' });
    await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), custom: 1 }));
    await updateConfigFile(file, { deviceName: 'Two' });
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { server: 'https://a.example', deviceName: 'Two', custom: 1 });
    await assert.rejects(updateConfigFile(file, { server: 'nonsense' }), ConfigError);
  });

  it('AGENT_VERSION equals package.json', async () => {
    const pkg = JSON.parse(await readFile(nodePath.join(process.cwd(), 'package.json'), 'utf8') /* npm test runs in the package directory */) as { version: string };
    assert.equal(AGENT_VERSION, pkg.version);
  });
});

describe('shell detection', () => {
  it('Windows prefers Git Bash, then pwsh, then Windows PowerShell', () => {
    const env = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', SystemRoot: 'C:\\Windows', PATH: 'C:\\bin' };
    const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    const pwsh = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
    const legacy = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    assert.deepEqual(detectShell(machine('windows', env, [gitBash, pwsh, legacy])), { path: gitBash, kind: 'posix' });
    assert.deepEqual(detectShell(machine('windows', env, [pwsh, legacy])), { path: pwsh, kind: 'powershell' });
    assert.deepEqual(detectShell(machine('windows', env, [legacy])), { path: legacy, kind: 'powershell' });
    assert.equal(detectShell(machine('windows', env, [])), null);
  });

  it('Windows: finds Git Bash through git.exe on PATH (Git on another drive), never the WSL launcher', () => {
    const env = { PATH: 'D:\\Tools\\Git\\cmd;C:\\Windows\\System32', SystemRoot: 'C:\\Windows' };
    const found = detectShell(machine('windows', env, ['D:\\Tools\\Git\\cmd\\git.exe', 'D:\\Tools\\Git\\bin\\bash.exe', 'C:\\Windows\\System32\\bash.exe']));
    assert.equal(found?.path, 'D:\\Tools\\Git\\bin\\bash.exe');
    // environment variable names are case-insensitive on Windows
    const lower = detectShell(machine('windows', { programfiles: 'C:\\PF' }, ['C:\\PF\\Git\\bin\\bash.exe']));
    assert.equal(lower?.path, 'C:\\PF\\Git\\bin\\bash.exe');
  });

  it('macOS and Linux use $SHELL, fall back when it is missing or one the protocol cannot drive (fish)', () => {
    assert.deepEqual(detectShell(machine('macos', { SHELL: '/bin/zsh' }, ['/bin/zsh'])), { path: '/bin/zsh', kind: 'posix' });
    assert.deepEqual(detectShell(machine('macos', {}, ['/bin/zsh', '/bin/bash'])), { path: '/bin/zsh', kind: 'posix' });
    assert.deepEqual(detectShell(machine('linux', { SHELL: '/usr/bin/zsh' }, ['/usr/bin/zsh', '/bin/bash'])), { path: '/usr/bin/zsh', kind: 'posix' });
    assert.deepEqual(detectShell(machine('linux', { SHELL: '/usr/bin/fish' }, ['/usr/bin/fish', '/bin/bash'])), { path: '/bin/bash', kind: 'posix' });
    assert.deepEqual(detectShell(machine('linux', { SHELL: '/gone/zsh' }, ['/bin/bash'])), { path: '/bin/bash', kind: 'posix' });
    assert.equal(detectShell(machine('linux', {}, [])), null);
  });

  it('kind and description', () => {
    assert.equal(shellKind('C:\\Program Files\\PowerShell\\7\\pwsh.exe'), 'powershell');
    assert.equal(shellKind('powershell.exe'), 'powershell');
    assert.equal(shellKind('/bin/zsh'), 'posix');
    assert.equal(describeShell('C:\\Git\\bin\\bash.exe', 'posix', 'windows'), 'Git Bash');
    assert.equal(describeShell('/usr/bin/zsh', 'posix', 'macos'), 'zsh');
    assert.equal(describeShell('pwsh.exe', 'powershell', 'windows'), 'PowerShell');
  });
});

describe('browser detection', () => {
  const win = machine('windows', { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, [
    'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
  ]);

  it('Windows: executables and standard user-data dirs per product', () => {
    assert.equal(detectBrowserExecutable('brave', win), 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe');
    assert.equal(detectBrowserExecutable('chrome', win), 'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe');
    assert.equal(detectBrowserExecutable('edge', win), null);
    assert.equal(defaultUserDataDir('brave', win), 'C:\\Users\\me\\AppData\\Local\\BraveSoftware\\Brave-Browser\\User Data');
    assert.equal(defaultUserDataDir('edge', win), 'C:\\Users\\me\\AppData\\Local\\Microsoft\\Edge\\User Data');
    assert.equal(defaultUserDataDir('chromium', win), 'C:\\Users\\me\\AppData\\Local\\Chromium\\User Data');
    assert.equal(defaultUserDataDir('custom', win), null);
  });

  it('macOS', () => {
    const mac = machine('macos', {}, ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'], '/Users/me');
    assert.equal(detectBrowserExecutable('brave', mac), '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser');
    assert.equal(defaultUserDataDir('brave', mac), '/Users/me/Library/Application Support/BraveSoftware/Brave-Browser');
    assert.equal(defaultUserDataDir('chrome', mac), '/Users/me/Library/Application Support/Google/Chrome');
    assert.equal(defaultUserDataDir('edge', mac), '/Users/me/Library/Application Support/Microsoft Edge');
  });

  it('Linux honours XDG_CONFIG_HOME', () => {
    const lin = machine('linux', {}, ['/usr/bin/brave-browser']);
    assert.equal(detectBrowserExecutable('brave', lin), '/usr/bin/brave-browser');
    assert.equal(defaultUserDataDir('brave', lin), '/home/me/.config/BraveSoftware/Brave-Browser');
    assert.equal(defaultUserDataDir('chrome', machine('linux', { XDG_CONFIG_HOME: '/cfg' }, [])), '/cfg/google-chrome');
    assert.ok(browserCandidates('chromium', lin).includes('/usr/bin/chromium'));
    assert.deepEqual(browserCandidates('custom', lin), []);
  });

  it('data directory defaults per OS', () => {
    assert.equal(defaultDataDir(machine('windows', { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, [])), 'C:\\Users\\me\\AppData\\Roaming\\evvapp-device');
    assert.equal(defaultDataDir(machine('macos', {}, [], '/Users/me')), '/Users/me/Library/Application Support/evvapp-device');
    assert.equal(defaultDataDir(machine('linux', {}, [])), '/home/me/.config/evvapp-device');
    assert.equal(defaultDataDir(machine('linux', { XDG_CONFIG_HOME: '/x' }, [])), '/x/evvapp-device');
  });
});

describe('resolveConfig', () => {
  const linux = machine('linux', { SHELL: '/bin/bash' }, ['/bin/bash', '/usr/bin/brave-browser']);

  it('fills every null and reports the contract fields', () => {
    const r = resolveConfig(parseConfig({ server: 'https://s.example/', deviceName: 'PC', files: { enabled: true, roots: ['~/work', '/data'], write: true }, browser: { enabled: true } }), '/data/dir', linux);
    assert.equal(r.server, 'https://s.example');
    assert.deepEqual(r.shell, { enabled: true, kind: 'posix', path: '/bin/bash', cwd: '/home/me' });
    assert.deepEqual(r.files, { enabled: true, roots: ['/home/me/work', '/data'], write: true });
    assert.equal(r.browser.executable, '/usr/bin/brave-browser');
    assert.equal(r.browser.userDataDir, '/home/me/.config/BraveSoftware/Brave-Browser');
    assert.equal(r.browser.enabled, true);
    assert.deepEqual(r.warnings, []);
  });

  it('dedicated mode uses <dataDir>/browser-profile and the Default profile', () => {
    const r = resolveConfig(parseConfig({ browser: { enabled: true, mode: 'dedicated', profileDirectory: 'Profile 3' } }), '/data/dir', linux);
    assert.equal(r.browser.userDataDir, '/data/dir/browser-profile');
    assert.equal(r.browser.profileDirectory, 'Default');
    const win = resolveConfig(parseConfig({ browser: { enabled: true, mode: 'dedicated' } }), 'C:\\Users\\me\\AppData\\Roaming\\evvapp-device', machine('windows', {}, []));
    assert.equal(win.browser.userDataDir, 'C:\\Users\\me\\AppData\\Roaming\\evvapp-device\\browser-profile');
  });

  it('a capability that cannot work is switched off with a warning, not advertised', () => {
    const r = resolveConfig(parseConfig({ files: { enabled: true }, browser: { enabled: true, product: 'edge' } }), '/d', machine('linux', {}, []));
    assert.equal(r.files.enabled, false);
    assert.equal(r.browser.enabled, false);
    assert.equal(r.shell.enabled, false);
    assert.equal(r.warnings.length, 3);
    assert.match(r.warnings.join('\n'), /files.roots/);
    assert.match(r.warnings.join('\n'), /edge executable/);
  });

  it('explicit paths win over detection', () => {
    const r = resolveConfig(parseConfig({ shell: { path: '/opt/zsh', cwd: '/srv' }, browser: { enabled: true, product: 'custom', executable: '/opt/b/browser', userDataDir: '/opt/b/data' } }), '/d', linux);
    assert.deepEqual(r.shell, { enabled: true, kind: 'posix', path: '/opt/zsh', cwd: '/srv' });
    assert.equal(r.browser.executable, '/opt/b/browser');
    assert.equal(r.browser.userDataDir, '/opt/b/data');
    const custom = resolveConfig(parseConfig({ browser: { enabled: true, product: 'custom', executable: '/opt/b/browser' } }), '/d', linux);
    assert.equal(custom.browser.enabled, false);
    assert.match(custom.warnings[0]!, /userDataDir/);
  });
});
