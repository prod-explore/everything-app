import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type * as Llm from '../llm-types.js';
import { buildApp, type BuiltApp } from '../server.js';
import { openDb, runMigrations, getMessages, createProject } from '../db.js';
import { ProviderRouter } from '../providers/router.js';
import type { McpConnectionLike } from '../mcp-client.js';
import { McpConnection } from '../mcp-client.js';
import { setNextRun, startRun } from '../schedules.js';

const TOKEN = 'schedules-test-token';
const AUTH = { authorization: `Bearer ${TOKEN}` };
const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null, cache_creation: null };
const message = (content: unknown[], stop: string) =>
  ({ id: 'm', container: null, content, model: 'm', role: 'assistant', stop_reason: stop, stop_sequence: null, type: 'message', usage }) as unknown as Llm.Message;
const text = (t: string) => ({ type: 'text', text: t, citations: null });
const toolUse = (id: string, name: string, input: Record<string, unknown> = {}) => ({ type: 'tool_use', id, name, input });

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

const until = async (cond: () => boolean | Promise<boolean>, what: string, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
};

describe('scheduled tasks over HTTP', () => {
  const db = openDb(':memory:');
  runMigrations(db);
  const requests: Llm.MessageCreateParamsNonStreaming[] = [];
  let script: (p: Llm.MessageCreateParamsNonStreaming, n: number) => Llm.Message = () => message([text('Report: all quiet.')], 'end_turn');
  const executed: string[] = [];
  const conn: McpConnectionLike = {
    name: 'srv',
    async listTools() { return [{ name: 'danger', description: 'needs approval', inputSchema: { type: 'object' } }]; },
    async callTool(name) { executed.push(name); return { text: `${name} ran`, isError: false }; },
  };
  let built: BuiltApp;
  let server: http.Server;
  let port: number;

  before(async () => {
    const client = { messages: { async create(p: Llm.MessageCreateParamsNonStreaming) { requests.push(p); return script(p, requests.length); } } };
    const router = new ProviderRouter({ db, env: {}, llmOverride: client as never });
    router.catalog.create({ slug: 't', label: 'Test', baseUrl: 'https://t.example/v1', keyOptional: true });
    router.catalog.addManual('t', 'free-1', { tags: ['free'] });
    router.catalog.addManual('t', 'strong', { tags: ['reasoning'] });
    built = await buildApp({
      db,
      connections: [conn as unknown as McpConnection],
      router,
      authToken: TOKEN,
      config: { model: '@t/free-1', autoApproveTools: [] },
      scheduler: { autostart: false },
    });
    server = built.app.listen(0);
    await new Promise<void>(r => server.once('listening', () => r()));
    port = (server.address() as AddressInfo).port;
  });

  after(async () => {
    built.stop();
    await new Promise<void>(r => server.close(() => r()));
    db.close();
  });

  const create = (extra: Record<string, unknown> = {}) =>
    request(port, 'POST', '/api/schedules', { name: 'Morning stocks', prompt: 'Report AAPL.', cron: '30 8 * * 1-5', timezone: 'Europe/Warsaw', ...extra });

  const lastRun = async (id: string) => (await request(port, 'GET', `/api/schedules/${id}/runs`)).json.runs[0];

  it('needs a login like the rest of the API', async () => {
    const res = await new Promise<number>(resolve => http.get({ host: '127.0.0.1', port, path: '/api/schedules' }, r => { r.resume(); resolve(r.statusCode ?? 0); }));
    assert.equal(res, 401);
  });

  it('creates, lists, edits, previews and deletes a schedule', async () => {
    const made = await create();
    assert.equal(made.status, 201);
    assert.equal(made.json.enabled, true);
    assert.ok(made.json.nextRunAt);

    const list = await request(port, 'GET', '/api/schedules');
    assert.equal(list.json.schedules.length, 1);
    assert.equal(list.json.schedules[0].lastRun, null);

    const edited = await request(port, 'PATCH', `/api/schedules/${made.json.id}`, { name: 'Evening stocks', enabled: false });
    assert.equal(edited.json.name, 'Evening stocks');
    assert.equal(edited.json.nextRunAt, null);

    const preview = await request(port, 'GET', '/api/schedules/preview?cron=0%209%20*%20*%20*&timezone=UTC');
    assert.equal(preview.json.ok, true);
    assert.equal(preview.json.next.length, 5);
    const bad = await request(port, 'GET', '/api/schedules/preview?cron=*%20*%20*%20*%20*&timezone=UTC');
    assert.deepEqual([bad.json.ok, /15 minutes/.test(bad.json.error)], [false, true]);

    assert.equal((await request(port, 'DELETE', `/api/schedules/${made.json.id}`)).status, 200);
    assert.equal((await request(port, 'DELETE', `/api/schedules/${made.json.id}`)).status, 404);
  });

  it('explains what is wrong with a request in a 400', async () => {
    assert.match((await create({ cron: '* * * * *' })).json.error, /15 minutes/);
    assert.match((await create({ name: '' })).json.error, /name is required/);
    assert.match((await create({ model: '@t/missing' })).json.error, /not a model of this app/);
    assert.match((await create({ projectId: 'nope' })).json.error, /does not exist/);
    assert.match((await create({ enabled: 'yes' })).json.error, /true or false/);
    const ghost = createProject(db, { name: 'ghosts', ghost: true });
    assert.match((await create({ projectId: ghost.id })).json.error, /ghost project/);
  });

  it('a run makes a chat, runs it unattended and posts the final answer to Gazeta', async () => {
    requests.length = 0;
    script = () => message([text('Report: AAPL 230, MSFT 450.')], 'end_turn');
    const s = (await create({ name: 'Stocks run' })).json;
    const started = await request(port, 'POST', `/api/schedules/${s.id}/run`);
    assert.equal(started.status, 202);
    await until(async () => (await lastRun(s.id))?.status === 'done', 'the run to finish');

    const run = await lastRun(s.id);
    assert.equal(run.trigger, 'manual');
    assert.match(run.summary, /AAPL 230/);
    const rows = getMessages(db, run.conversationId);
    assert.deepEqual(rows.map(r => r.role), ['user', 'assistant']);
    assert.equal(rows[0]!.content, 'Report AAPL.');

    // The system prompt told the model nobody is watching, and the model was the free one.
    const system = JSON.stringify(requests[0]!.system);
    assert.match(system, /automated, scheduled run/);
    assert.match(system, /at most 25 steps/);
    const conv = (await request(port, 'GET', `/api/conversations/${run.conversationId}`)).json;
    assert.match(conv.title ?? conv.conversation?.title ?? '', /^⏰ Stocks run · /);

    const gazeta = (await request(port, 'GET', `/api/gazeta?type=report&conversationId=${run.conversationId}`)).json.items;
    assert.equal(gazeta.length, 1);
    assert.equal(gazeta[0].title, 'Stocks run');
    assert.equal(gazeta[0].description, 'Report: AAPL 230, MSFT 450.');
    assert.equal(gazeta[0].agent, 'schedule');

    const list = (await request(port, 'GET', '/api/schedules')).json.schedules.find((x: { id: string }) => x.id === s.id);
    assert.equal(list.lastRun.status, 'done');
    assert.ok(list.lastRunAt);
  });

  const pendingOf = async (convId: string) =>
    ((await request(port, 'GET', '/api/pending-approvals')).json.pending as Array<Record<string, any>>).filter(p => p.conversationId === convId);
  const toolThenAnswer = (_p: Llm.MessageCreateParamsNonStreaming, n: number) => (n === 1
    ? message([toolUse('c1', 'srv__danger')], 'tool_use')
    : message([text('Done with what I could.')], 'end_turn'));
  const listRunsOf = async (id: string) => (await request(port, 'GET', `/api/schedules/${id}/runs`)).json.runs as Array<{ status: string; conversationId: string | null }>;
  const runReachedApproval = (id: string) => async () => !!(await lastRun(id))?.conversationId && (await pendingOf((await lastRun(id)).conversationId)).length === 1;

  it('by default a call that needs approval is refused at once and the run goes on; the same approval card waits for "Always", which lets the next run through', async () => {
    requests.length = 0;
    executed.length = 0;
    script = toolThenAnswer;
    const s = (await create({ name: 'Needs approval' })).json;
    assert.equal(s.approvalWaitMin, 0);
    await request(port, 'POST', `/api/schedules/${s.id}/run`);
    await until(async () => (await lastRun(s.id))?.status === 'done', 'the run to finish');
    assert.deepEqual(executed, []);
    const second = JSON.stringify(requests[1]!.messages);
    assert.match(second, /Not executed/);
    assert.match(second, /does not wait for approvals/);
    assert.match(JSON.stringify(requests[0]!.system), /refused right away/);

    // The request is an ordinary pending approval (what Gazeta lists next to everything else), marked as late.
    const run = await lastRun(s.id);
    const [card] = await pendingOf(run.conversationId);
    assert.ok(card, 'the request is left in the list');
    assert.equal(card!.late, true);
    assert.match(card!.note, /Needs approval.*did not wait/);
    assert.match(card!.toolLabel, /danger/);

    // "Once" means nothing for a run that is over; "Always" is a standing grant.
    const answered = await request(port, 'POST', '/api/approve', { id: card!.id, approved: true, scope: 'always' });
    assert.equal(answered.status, 200);
    assert.equal((await pendingOf(run.conversationId)).length, 0);
    const grants = (await request(port, 'GET', '/api/approval/grants')).json.grants as Array<{ id: string; toolLabel: string; scope: string }>;
    const granted = grants.filter(g => /danger/.test(g.toolLabel));
    assert.equal(granted.length, 1);
    assert.equal(granted[0]!.scope, 'always');

    // The next run is not stopped by it.
    requests.length = 0;
    await request(port, 'POST', `/api/schedules/${s.id}/run`);
    await until(async () => (await listRunsOf(s.id)).filter(r => r.status === 'done').length === 2, 'the second run to finish');
    assert.deepEqual(executed, ['danger']);

    for (const g of granted) await request(port, 'DELETE', `/api/approval/grants/${g.id}`);
  });

  it('with a wait set the run pauses on a normal pending approval (not late), and approving it once lets that one call through', async () => {
    requests.length = 0;
    executed.length = 0;
    script = toolThenAnswer;
    const s = (await create({ name: 'Waits', approvalWaitMin: 5 })).json;
    await request(port, 'POST', `/api/schedules/${s.id}/run`);
    await until(runReachedApproval(s.id), 'the request to appear');
    const run = await lastRun(s.id);
    assert.equal(run.status, 'running');
    assert.deepEqual(executed, []);
    assert.match(JSON.stringify(requests[0]!.system), /at most 5 minutes/);
    const [card] = await pendingOf(run.conversationId);
    assert.equal(card!.late, undefined);
    assert.match(card!.note, /Waits.*is paused on this call/);

    assert.equal((await request(port, 'POST', '/api/approve', { id: card!.id, approved: true, scope: 'once' })).status, 200);
    await until(async () => (await lastRun(s.id))?.status === 'done', 'the run to go on');
    assert.deepEqual(executed, ['danger']);
    // "Once" is not remembered.
    const grants = (await request(port, 'GET', '/api/approval/grants')).json.grants as Array<{ toolLabel: string }>;
    assert.equal(grants.filter(g => /danger/.test(g.toolLabel)).length, 0);
  });

  it('a denial refuses the call, and the run goes on without it', async () => {
    requests.length = 0;
    executed.length = 0;
    script = toolThenAnswer;
    const s = (await create({ name: 'Denied', approvalWaitMin: 5 })).json;
    await request(port, 'POST', `/api/schedules/${s.id}/run`);
    await until(runReachedApproval(s.id), 'the request to appear');
    const [card] = await pendingOf((await lastRun(s.id)).conversationId);
    await request(port, 'POST', '/api/approve', { id: card!.id, approved: false, scope: 'once' });
    await until(async () => (await lastRun(s.id))?.status === 'done', 'the run to finish');
    assert.deepEqual(executed, []);
    assert.match(JSON.stringify(requests[1]!.messages), /Rejected by user/);
  });

  it('stopping the run while it waits takes its request out of the list', async () => {
    requests.length = 0;
    executed.length = 0;
    script = toolThenAnswer;
    const s = (await create({ name: 'Stopped', approvalWaitMin: 5 })).json;
    await request(port, 'POST', `/api/schedules/${s.id}/run`);
    await until(runReachedApproval(s.id), 'the request to appear');
    const run = await lastRun(s.id);
    await request(port, 'POST', `/api/conversations/${run.conversationId}/kill`);
    await until(async () => (await pendingOf(run.conversationId)).length === 0, 'the request to go away');
    await until(async () => (await lastRun(s.id))?.status !== 'running', 'the run to end');
    assert.deepEqual(executed, []);
  });

  it('one-time and limited schedules: created, shown as such, and refused when they make no sense', async () => {
    const soon = new Date(Date.now() + 36 * 3600_000).toISOString().slice(0, 16);
    const once = await create({ name: 'Once', cron: soon, timezone: 'UTC' });
    assert.equal(once.status, 201);
    assert.deepEqual([once.json.finished, once.json.maxRuns, once.json.cron], [false, null, `${soon}:00`]);
    assert.ok(once.json.nextRunAt);

    const few = await create({ name: 'Few', maxRuns: 3 });
    assert.deepEqual([few.json.maxRuns, few.json.runCount, few.json.finished], [3, 0, false]);
    const raised = await request(port, 'PATCH', `/api/schedules/${few.json.id}`, { maxRuns: 5 });
    assert.equal(raised.json.maxRuns, 5);
    const unlimited = await request(port, 'PATCH', `/api/schedules/${few.json.id}`, { maxRuns: null });
    assert.equal(unlimited.json.maxRuns, null);

    assert.match((await create({ cron: '2020-01-01T08:00', timezone: 'UTC' })).json.error, /already passed/);
    assert.match((await create({ maxRuns: 0 })).json.error, /whole number/);
    assert.match((await create({ maxRuns: 'many' })).json.error, /number or null/);
    assert.match((await create({ approvalWaitMin: 9999 })).json.error, /minutes/);

    const preview = await request(port, 'GET', `/api/schedules/preview?cron=${encodeURIComponent(soon)}&timezone=UTC`);
    assert.equal(preview.json.ok, true);
    assert.equal(preview.json.next.length, 1);
  });

  it('refuses a paid model unless the task allows it, and says so in Gazeta', async () => {
    script = () => message([text('ok')], 'end_turn');
    const s = (await create({ name: 'Paid one', model: '@t/strong' })).json;
    await request(port, 'POST', `/api/schedules/${s.id}/run`);
    await until(async () => (await lastRun(s.id))?.status === 'error', 'the run to fail');
    const run = await lastRun(s.id);
    assert.match(run.error, /not a free model/);
    const reports = (await request(port, 'GET', '/api/gazeta?type=report')).json.items.filter((i: { title: string }) => i.title === 'Scheduled task failed: Paid one');
    assert.equal(reports.length, 1);
    assert.match(reports[0].description, /Allow paid models/);

    await request(port, 'PATCH', `/api/schedules/${s.id}`, { allowPaid: true });
    await request(port, 'POST', `/api/schedules/${s.id}/run`);
    await until(async () => (await lastRun(s.id))?.status === 'done', 'the allowed run to finish');
  });

  it('a due schedule is started by the timer tick and moves on to its next slot', async () => {
    script = () => message([text('Tick report.')], 'end_turn');
    const s = (await create({ name: 'Due now' })).json;
    setNextRun(db, s.id, new Date(Date.now() - 1000));
    await built.scheduler.tick();
    await until(async () => (await lastRun(s.id))?.status === 'done', 'the due run to finish');
    assert.equal((await lastRun(s.id)).trigger, 'schedule');
    const after = (await request(port, 'GET', '/api/schedules')).json.schedules.find((x: { id: string }) => x.id === s.id);
    assert.ok(new Date(after.nextRunAt).getTime() > Date.now());
  });

  it('a second "run now" while one is going is a 409', async () => {
    const s = (await create({ name: 'Busy' })).json;
    startRun(db, s.id, 'schedule'); // a run that has not finished
    const again = await request(port, 'POST', `/api/schedules/${s.id}/run`);
    assert.equal(again.status, 409);
    assert.match(again.json.error, /already running/);
  });
});
