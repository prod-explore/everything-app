import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type * as Llm from '../llm-types.js';
import { buildApp, type BuiltApp } from '../server.js';
import { openDb, runMigrations, getMessages } from '../db.js';
import { ProviderRouter } from '../providers/router.js';
import type { McpConnection } from '../mcp-client.js';
import { MAX_WAKE_CHAIN, MAX_WAKEUPS_PER_CHAT, listSchedules, setNextRun } from '../schedules.js';
import { createTaskTool, schedulingPrompt, wakeupTool } from '../schedule-tools.js';

const NOW = new Date('2026-10-23T12:00:00.000Z');
const ctx = { toolUseId: 't1' };

function fresh() {
  const db = openDb(':memory:');
  runMigrations(db);
  return db;
}

const deps = (db: ReturnType<typeof fresh>, over: Partial<Parameters<typeof wakeupTool>[0]> = {}) => ({
  db, convId: 'chat-1', projectId: null, timezone: 'Europe/Warsaw', onChange: () => {}, now: () => NOW, ...over,
});

describe('schedule_wakeup', () => {
  it('sets a one-time wake-up of this chat, in N minutes', async () => {
    const db = fresh();
    const r = await wakeupTool(deps(db)).handler({ prompt: 'check the build', minutes: 30 }, ctx);
    assert.equal(r.isError, undefined);
    assert.match(r.text, /Wake-up set for .*14:30.*in 30 min/);
    const [s] = listSchedules(db);
    assert.equal(s!.conversationId, 'chat-1');
    assert.equal(s!.chain, 1);
    assert.equal(s!.cron, '2026-10-23T12:30:00');
    assert.equal(s!.timezone, 'UTC');
    assert.equal(s!.nextRunAt, '2026-10-23T12:30:00.000Z');
    assert.equal(s!.approvalWaitMin, 30);
  });

  it('takes a local date and time in the user\'s zone, or one with an offset', async () => {
    const db = fresh();
    const tool = wakeupTool(deps(db));
    assert.equal((await tool.handler({ prompt: 'a', at: '2026-10-24T08:30' }, ctx)).isError, undefined);
    assert.equal((await tool.handler({ prompt: 'b', at: '2026-10-24T08:30:00+02:00' }, ctx)).isError, undefined);
    const [local, offset] = listSchedules(db);
    assert.equal(local!.nextRunAt, '2026-10-24T06:30:00.000Z', 'Warsaw is UTC+2 in October (summer time until the 25th)');
    assert.equal(offset!.nextRunAt, '2026-10-24T06:30:00.000Z');
  });

  it('refuses what makes no sense, with a sentence the model can act on', async () => {
    const db = fresh();
    const tool = wakeupTool(deps(db));
    const refused = async (input: Record<string, unknown>) => { const r = await tool.handler(input, ctx); assert.equal(r.isError, true); return r.text; };
    assert.match(await refused({ prompt: '' , minutes: 5 }), /needs a "prompt"/);
    assert.match(await refused({ prompt: 'x' }), /Say when/);
    assert.match(await refused({ prompt: 'x', minutes: 5, at: '2026-10-24T08:30' }), /either/);
    assert.match(await refused({ prompt: 'x', minutes: 0 }), /whole number from 1/);
    assert.match(await refused({ prompt: 'x', at: 'tomorrow morning' }), /not a date and time/);
    assert.match(await refused({ prompt: 'x', at: '2026-10-22T08:30' }), /already passed.*Now it is .*23 Oct 2026/);
    assert.match(await refused({ prompt: 'x', minutes: 20160 + 1 }), /whole number from 1/);
    assert.match(await refused({ prompt: 'x', at: '2026-12-24T08:30' }), /too far away/);
    assert.equal(listSchedules(db).length, 0, 'nothing is left behind');
  });

  it(`allows ${MAX_WAKEUPS_PER_CHAT} waiting per chat, and other chats have their own`, async () => {
    const db = fresh();
    const tool = wakeupTool(deps(db));
    for (let i = 0; i < MAX_WAKEUPS_PER_CHAT; i++) assert.equal((await tool.handler({ prompt: `w${i}`, minutes: 10 + i }, ctx)).isError, undefined);
    const sixth = await tool.handler({ prompt: 'one too many', minutes: 99 }, ctx);
    assert.equal(sixth.isError, true);
    assert.match(sixth.text, /already has 5 wake-ups waiting/);
    assert.equal((await wakeupTool(deps(db, { convId: 'chat-2' })).handler({ prompt: 'elsewhere', minutes: 10 }, ctx)).isError, undefined);
  });

  it('wake-ups do not use up the user\'s own schedules', async () => {
    const db = fresh();
    for (let i = 0; i < 3; i++) await wakeupTool(deps(db, { convId: `c${i}` })).handler({ prompt: 'x', minutes: 10 }, ctx);
    const created = await createTaskTool(deps(db)).handler({ name: 'Daily', prompt: 'do it', cron: '0 9 * * *' }, ctx);
    assert.equal(created.isError, undefined);
  });

  it(`cuts a chain of ${MAX_WAKE_CHAIN} wake-ups without a word from the user, and counts the chain up`, async () => {
    const db = fresh();
    await wakeupTool(deps(db, { wakeChain: 3 })).handler({ prompt: 'again', minutes: 10 }, ctx);
    assert.equal(listSchedules(db)[0]!.chain, 4);
    const r = await wakeupTool(deps(db, { wakeChain: MAX_WAKE_CHAIN })).handler({ prompt: 'again', minutes: 10 }, ctx);
    assert.equal(r.isError, true);
    assert.match(r.text, /10 times in a row/);
  });
});

describe('create_scheduled_task', () => {
  it('needs the user\'s approval', () => {
    assert.equal(createTaskTool(deps(fresh())).requiresApproval, true);
    assert.equal(wakeupTool(deps(fresh())).requiresApproval, undefined);
  });

  it('creates a repeating task (free models, a fresh chat each time), or a single one at a time', async () => {
    const db = fresh();
    const tool = createTaskTool(deps(db, { projectId: null }));
    const daily = await tool.handler({ name: 'Job offers', prompt: 'Look for offers', cron: '30 8 * * 1-5', max_runs: 5 }, ctx);
    assert.equal(daily.isError, undefined);
    assert.match(daily.text, /Created the scheduled task "Job offers"\. Next run: .*Mon, 26 Oct 2026, 08:30/);
    const once = await tool.handler({ name: 'Reminder', prompt: 'Remind me', at: '2026-10-24T08:30', timezone: 'UTC' }, ctx);
    assert.equal(once.isError, undefined);
    const [a, b] = listSchedules(db);
    assert.deepEqual([a!.allowPaid, a!.maxRuns, a!.conversationId, a!.approvalWaitMin], [false, 5, null, 0]);
    assert.deepEqual([b!.cron, b!.timezone], ['2026-10-24T08:30:00', 'UTC']);
  });

  it('explains what is wrong', async () => {
    const db = fresh();
    const tool = createTaskTool(deps(db));
    const refused = async (input: Record<string, unknown>) => { const r = await tool.handler(input, ctx); assert.equal(r.isError, true); return r.text; };
    assert.match(await refused({ name: '', prompt: 'x', cron: '0 9 * * *' }), /needs a "name" and a "prompt"/);
    assert.match(await refused({ name: 'n', prompt: 'x' }), /either "cron".*or "at"/);
    assert.match(await refused({ name: 'n', prompt: 'x', cron: '0 9 * * *', at: '2026-10-24T08:30' }), /either "cron"/);
    assert.match(await refused({ name: 'n', prompt: 'x', cron: '* * * * *' }), /15 minutes/);
    assert.match(await refused({ name: 'n', prompt: 'x', cron: '0 9 * * *', timezone: 'Mars/Base' }), /not a time zone/);
    assert.match(await refused({ name: 'n', prompt: 'x', at: '2026-10-22T08:30' }), /already passed/);
    assert.equal(listSchedules(db).length, 0);
  });
});

describe('schedulingPrompt', () => {
  it('tells the model the date and zone, since it has no clock', () => {
    const p = schedulingPrompt(NOW, 'Europe/Warsaw');
    assert.match(p, /Today is Friday 2026-10-23 \(time zone Europe\/Warsaw\)/);
    assert.match(p, /schedule_wakeup.*create_scheduled_task/s);
    assert.doesNotMatch(schedulingPrompt(NOW, 'UTC', true), /create_scheduled_task/);
  });
});

// ─── in a real chat ───────────────────────────────────────────────────────────

const TOKEN = 'schedule-tools-token';
const AUTH = { authorization: `Bearer ${TOKEN}` };
const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null, cache_creation: null };
const message = (content: unknown[], stop: string) =>
  ({ id: 'm', container: null, content, model: 'm', role: 'assistant', stop_reason: stop, stop_sequence: null, type: 'message', usage }) as unknown as Llm.Message;
const text = (t: string) => ({ type: 'text', text: t, citations: null });
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });

function request(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', ...AUTH, ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}) } },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const t = Buffer.concat(chunks).toString('utf8');
          try { resolve({ status: res.statusCode ?? 0, json: t ? JSON.parse(t) : {} }); } catch (e) { reject(e); }
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const until = async (cond: () => boolean | Promise<boolean>, what: string, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
};

describe('the agent schedules from an ordinary chat', () => {
  const db = openDb(':memory:');
  runMigrations(db);
  const requests: Llm.MessageCreateParamsNonStreaming[] = [];
  let script: (p: Llm.MessageCreateParamsNonStreaming, n: number) => Llm.Message = () => message([text('ok')], 'end_turn');
  let built: BuiltApp;
  let server: http.Server;
  let port: number;

  before(async () => {
    const client = { messages: { async create(p: Llm.MessageCreateParamsNonStreaming) { requests.push(p); return script(p, requests.length); } } };
    const router = new ProviderRouter({ db, env: {}, llmOverride: client as never });
    router.catalog.create({ slug: 't', label: 'Test', baseUrl: 'https://t.example/v1', keyOptional: true });
    router.catalog.addManual('t', 'free-1', { tags: ['free'] });
    built = await buildApp({ db, connections: [] as McpConnection[], router, authToken: TOKEN, sandboxLifecycle: null, config: { model: '@t/free-1', autoApproveTools: [] }, scheduler: { autostart: false } });
    server = built.app.listen(0);
    await new Promise<void>(r => server.once('listening', () => r()));
    port = (server.address() as AddressInfo).port;
  });

  after(async () => {
    built.stop();
    await new Promise<void>(r => server.close(() => r()));
    db.close();
  });

  const toolNames = (p: Llm.MessageCreateParamsNonStreaming) => ((p.tools ?? []) as Array<{ name: string }>).map(t => t.name);
  const say = async (convId: string, t: string) => request(port, 'POST', `/api/conversations/${convId}/message`, { text: t });
  const settled = async (convId: string) => until(async () => (await request(port, 'GET', `/api/conversations/${convId}/status`)).json.status !== 'running', 'the turn to end');
  const wakeups = async (convId: string) => (await request(port, 'GET', '/api/schedules')).json.schedules.filter((s: { conversationId: string | null }) => s.conversationId === convId);

  it('wakes the same chat later with its prompt, unattended, and the alarm is spent afterwards', async () => {
    requests.length = 0;
    const { id } = (await request(port, 'POST', '/api/conversations', {})).json;
    script = (_p, n) => (n === 1 ? message([toolUse('w1', 'schedule_wakeup', { prompt: 'check the build', minutes: 5 })], 'tool_use') : message([text('I will look at it in five minutes.')], 'end_turn'));
    await say(id, 'tell me when the build is done');
    await settled(id);

    // The first turn offered both tools and the date.
    assert.deepEqual(toolNames(requests[0]!).filter(n => /schedule/.test(n)).sort(), ['create_scheduled_task', 'schedule_wakeup']);
    assert.match(JSON.stringify(requests[0]!.system), /Today is \w+day \d{4}-\d{2}-\d{2}/);
    const [alarm] = await wakeups(id);
    assert.ok(alarm, 'the alarm is in the list the Schedules window shows');
    assert.equal(alarm.chain, 1);

    // The time comes: the prompt arrives in the same chat, as a new message, and a turn runs.
    requests.length = 0;
    script = (_p, n) => (n === 1 ? message([toolUse('w2', 'schedule_wakeup', { prompt: 'check once more', minutes: 10 })], 'tool_use') : message([text('Not green yet; I will look again.')], 'end_turn'));
    setNextRun(db, alarm.id, new Date(Date.now() - 1000));
    await built.scheduler.tick();
    await until(() => JSON.stringify(getMessages(db, id)).includes('Not green yet'), 'the wake-up turn to answer');
    await built.scheduler.idle();

    const user = getMessages(db, id).filter(m => m.role === 'user').map(m => JSON.stringify(m.content));
    assert.ok(user.some(c => c.includes('Wake-up you set earlier: check the build')), 'the prompt is a message in the same chat');
    const wakeTurn = requests[0]!;
    assert.match(JSON.stringify(wakeTurn.system), /wake-up you scheduled yourself/);
    assert.deepEqual(toolNames(wakeTurn).filter(n => /schedule/.test(n)), ['schedule_wakeup'], 'a wake-up may wake itself again, but may not create tasks');

    // The spent alarm is gone; the new one is one step further along the chain.
    const after = await wakeups(id);
    assert.equal(after.length, 1);
    assert.notEqual(after[0].id, alarm.id);
    assert.equal(after[0].chain, 2);
  });

  it('a task the agent creates waits for the user\'s approval, and exists only after it', async () => {
    requests.length = 0;
    const { id } = (await request(port, 'POST', '/api/conversations', {})).json;
    script = (_p, n) => (n === 1
      ? message([toolUse('t1', 'create_scheduled_task', { name: 'Morning news', prompt: 'Summarise the news', cron: '0 8 * * *' })], 'tool_use')
      : message([text('Done: every morning at 8.')], 'end_turn'));
    await say(id, 'every morning at 8, summarise the news for me');
    await until(async () => ((await request(port, 'GET', '/api/pending-approvals')).json.pending as Array<{ conversationId: string }>).some(p => p.conversationId === id), 'the approval to appear');
    const [card] = ((await request(port, 'GET', '/api/pending-approvals')).json.pending as Array<{ id: string; conversationId: string; toolLabel: string; args: Record<string, unknown> }>).filter(p => p.conversationId === id);
    assert.match(card!.toolLabel, /create_scheduled_task/);
    assert.equal(card!.args['cron'], '0 8 * * *');
    assert.equal((await request(port, 'GET', '/api/schedules')).json.schedules.some((s: { name: string }) => s.name === 'Morning news'), false, 'nothing exists before the click');

    await request(port, 'POST', '/api/approve', { id: card!.id, approved: true, scope: 'once' });
    await settled(id);
    const made = (await request(port, 'GET', '/api/schedules')).json.schedules.find((s: { name: string }) => s.name === 'Morning news');
    assert.ok(made);
    assert.equal(made.conversationId, null, 'a task of its own, not a wake-up');
    assert.equal(made.cron, '0 8 * * *');
  });

  it('a refused request creates nothing', async () => {
    requests.length = 0;
    const { id } = (await request(port, 'POST', '/api/conversations', {})).json;
    script = (_p, n) => (n === 1
      ? message([toolUse('t1', 'create_scheduled_task', { name: 'Nope', prompt: 'x', cron: '0 8 * * *' })], 'tool_use')
      : message([text('Understood, I did not schedule it.')], 'end_turn'));
    await say(id, 'schedule something');
    await until(async () => ((await request(port, 'GET', '/api/pending-approvals')).json.pending as Array<{ conversationId: string }>).some(p => p.conversationId === id), 'the approval to appear');
    const [card] = ((await request(port, 'GET', '/api/pending-approvals')).json.pending as Array<{ id: string; conversationId: string }>).filter(p => p.conversationId === id);
    await request(port, 'POST', '/api/approve', { id: card!.id, approved: false, scope: 'once' });
    await settled(id);
    assert.equal((await request(port, 'GET', '/api/schedules')).json.schedules.some((s: { name: string }) => s.name === 'Nope'), false);
  });

  it('a scheduled run of its own is not offered either tool', async () => {
    requests.length = 0;
    script = () => message([text('Report.')], 'end_turn');
    const made = (await request(port, 'POST', '/api/schedules', { name: 'Plain', prompt: 'Report', cron: '0 8 * * *', timezone: 'UTC' })).json;
    await request(port, 'POST', `/api/schedules/${made.id}/run`);
    await until(() => requests.length > 0, 'the run to ask the model');
    await built.scheduler.idle();
    assert.deepEqual(toolNames(requests[0]!).filter(n => /schedule/.test(n)), []);
    assert.doesNotMatch(JSON.stringify(requests[0]!.system), /Today is/);
  });

  it('deleting the chat cancels its wake-ups', async () => {
    requests.length = 0;
    const { id } = (await request(port, 'POST', '/api/conversations', {})).json;
    script = (_p, n) => (n === 1 ? message([toolUse('w1', 'schedule_wakeup', { prompt: 'later', minutes: 60 })], 'tool_use') : message([text('ok')], 'end_turn'));
    await say(id, 'remind me');
    await settled(id);
    assert.equal((await wakeups(id)).length, 1);
    assert.equal((await request(port, 'DELETE', `/api/conversations/${id}`)).status, 200);
    assert.equal((await wakeups(id)).length, 0);
  });
});
