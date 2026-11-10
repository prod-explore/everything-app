// Regenerates docs/img/*.png against a running mock stack:  OUT=docs/img BASE=http://localhost:3000 PASSWORD=dev CHROME=/path/to/chrome node tools/screenshots.mjs
// Needs: npm i playwright-core (not a dependency of the repo).
// The device screenshots (devices.png, pair.png, device-approval.png) also need `(cd device/agent && npm ci && npm run build)`, a
// system Chrome for the agent's browser capability, and write a small demo checkout under DEVICE_ROOT (default /home/me/projects)
// so that the paths on screen read naturally. Skip them with SKIP_DEVICE=1. The agent's config and token live in a temporary folder.
// Leave the helper model slot empty, or the chat titles are written by the model; the script renames only the device chat.
import { chromium } from 'playwright-core';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const OUT = process.env.OUT;
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const BASE = process.env.BASE ?? 'http://localhost:3000';
async function open(vp, mobile) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: mobile ? 2 : 1, hasTouch: mobile, isMobile: mobile });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.fill('input[placeholder="Password"]', process.env.PASSWORD ?? 'pw'); await page.keyboard.press('Enter');
  await page.waitForSelector('#composer-input');
  return page;
}
const send = async (page, t) => { await page.fill('#composer-input', t); await page.keyboard.press('Enter'); };
const idle = page => page.waitForSelector('button[title="Stop (kill switch)"]', { state: 'detached', timeout: 30000 });

let page = await open({ width: 1440, height: 900 });
await send(page, 'long'); await page.waitForSelector('text=A longer answer'); await idle(page);
await page.screenshot({ path: `${OUT}/chat.png` });
await send(page, 'ask: pick a database'); await page.waitForSelector('[aria-label="Questions from the agent"]');
await page.screenshot({ path: `${OUT}/question.png` });
await page.locator('[aria-label="Questions from the agent"] >> text=Dismiss').first().click(); await idle(page);
await send(page, 'spawn'); await idle(page);
await page.click('button[aria-label="Agents"]'); await page.waitForSelector('text=Completed'); await idle(page);
await page.screenshot({ path: `${OUT}/agents.png` });
await page.reload(); await page.waitForSelector('#composer-input');
await page.locator('#composer-input').blur();
for (const k of ['Control+k', 'Meta+k']) { await page.keyboard.press(k); if (await page.locator('[aria-label="Search conversations"]').count()) break; }
await page.waitForSelector('[aria-label="Search conversations"]');
await page.fill('[aria-label="Search conversations"] input', 'markdown'); await page.waitForSelector('text=In messages');
await page.screenshot({ path: `${OUT}/search.png` });
await page.keyboard.press('Escape');
await page.fill('#composer-input', '/');
await page.waitForSelector('[aria-label="Commands"]');
await page.screenshot({ path: `${OUT}/slash.png` });
await page.fill('#composer-input', '');
await page.click('text=Settings'); await page.waitForSelector('text=Model slots');
await page.screenshot({ path: `${OUT}/models.png` });
await page.keyboard.press('Escape');

if (!process.env.SKIP_DEVICE) await deviceShots(page);
await page.context().close();

page = await open({ width: 390, height: 844 }, true);
await send(page, 'long'); await page.waitForSelector('text=A longer answer'); await idle(page);
await page.screenshot({ path: `${OUT}/mobile.png` });
await browser.close();

/** A paired laptop: the pairing page, an approval card for a command on it, and Settings → Devices. */
async function deviceShots(page) {
  const root = process.env.DEVICE_ROOT ?? '/home/me/projects';
  const repo = join(root, 'web-shop');
  mkdirSync(repo, { recursive: true });
  if (!existsSync(join(repo, '.git'))) {
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    writeFileSync(join(repo, 'README.md'), '# web-shop\n');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'web-shop', version: '1.0.0', scripts: { test: 'echo 24 tests passed' } }, null, 2));
  }
  const dataDir = mkdtempSync(join(tmpdir(), 'evvapp-device-'));
  const config = join(dataDir, 'config.json');
  writeFileSync(config, JSON.stringify({
    server: BASE, deviceName: 'Laptop',
    shell: { enabled: true, cwd: repo },
    files: { enabled: true, roots: [root], write: true },
    browser: { enabled: true, mode: 'dedicated', product: 'chrome' },
  }));
  const agent = process.env.DEVICE_AGENT ?? new URL('../device/agent/dist/main.mjs', import.meta.url).pathname;
  const env = { ...process.env, EVVAPP_DEVICE_TEST_HEADLESS: '1', BROWSER: 'none' };
  const agentArgs = cmd => [agent, cmd, '--config', config, '--data-dir', dataDir];

  // pair: the agent prints the code and the approval URL, then polls until the page below approves it
  const pairing = spawn('node', [...agentArgs('pair'), '--server', BASE, '--name', 'Laptop'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  const paired = new Promise((res, rej) => { pairing.on('exit', c => (c === 0 ? res() : rej(new Error(`device pair exited ${c}`)))); });
  let out = '';
  const path = await new Promise((res, rej) => {
    pairing.stdout.on('data', d => { out += d; const m = /open\s+\S*?(\/devices\/pair\?code=[A-Z0-9-]+)/.exec(out); if (m) res(m[1]); });
    paired.catch(rej);
  });
  await page.goto(BASE + path);
  await page.waitForSelector('text=Pair a device'); await page.waitForSelector('input[value="Laptop"]');
  await page.screenshot({ path: `${OUT}/pair.png` });
  await page.click('button:has-text("Approve")');
  await paired;
  const runner = spawn('node', agentArgs('run'), { env, stdio: 'ignore' });
  try {
    await page.goto(BASE); await page.waitForSelector('#composer-input');
    const online = () => page.evaluate(async () => (await (await fetch('/api/devices')).json()).devices.some(d => d.online && d.tools.length));
    for (let i = 0; !(await online()); i++) { if (i > 60) throw new Error('the device did not come online'); await page.waitForTimeout(500); }
    // a command on the laptop: the approval card names the device; remember it for this device
    await page.click('text=New conversation');
    await page.waitForSelector('#composer-input');
    await send(page, 'tool: shell_run {"command":"npm test"}');
    const card = '[aria-label="Tool call requires approval"]';
    await page.waitForSelector(card, { timeout: 30000 });
    // the chat title the app derives from that message is not one a person would keep
    await page.evaluate(async () => {
      const { conversations } = await (await fetch('/api/conversations')).json();
      const c = conversations.find(x => x.messageCount > 0 && (x.title === 'New conversation' || x.title.startsWith('tool: shell_run')));
      await fetch(`/api/conversations/${c.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Run the tests on my laptop' }) });
    });
    await page.reload(); await page.waitForSelector(card);
    await page.locator('#composer-input').blur();
    await page.screenshot({ path: `${OUT}/device-approval.png` });
    await page.locator(card).getByRole('button', { name: 'Always' }).click();
    await idle(page); await page.waitForSelector('text=Run the tests on my laptop');
    await page.click('text=Settings');
    await page.click('[role="dialog"] >> text=Devices'); await page.waitForSelector('text=Remembered commands');
    await page.waitForSelector('text=online');
    await page.screenshot({ path: `${OUT}/devices.png` });
    await page.keyboard.press('Escape');
  } finally {
    runner.kill(); rmSync(dataDir, { recursive: true, force: true });
  }
}
