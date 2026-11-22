import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, runMigrations, createProject, createConversation } from '../db.js';
import { WebApprovalGate } from '../web-approval.js';
import { KeyVault } from '../providers/key-vault.js';
import { GitHubCredentials } from '../github.js';
import { createGithubRoutes } from '../github-routes.js';
import { githubVirtualTools } from '../github-tools.js';
import { runTurn, type LlmClient } from '../llm-loop.js';
import { ToolRegistry } from '../tool-registry.js';
import type * as Llm from '../llm-types.js';

const SECRET = 'y'.repeat(40);

function msg(content: unknown[], stop: Llm.StopReason): Llm.Message {
  return {
    id: 'm',
    content,
    model: '@t/m',
    role: 'assistant',
    stop_reason: stop,
    stop_sequence: null,
    type: 'message',
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: null, cache_read_input_tokens: null },
  } as unknown as Llm.Message;
}

describe('github virtual tools (github_list_repos & github_clone_repo)', () => {
  it('lists private and public repos without approval and annotates already-cloned checkouts', async () => {
    const db = openDb(':memory:');
    runMigrations(db);
    const project = createProject(db, { name: 'multi' });
    const conv = createConversation(db, { projectId: project.id }).id;
    const gate = new WebApprovalGate(db);
    const urls: string[] = [];

    const fetchImpl = (async (url: string | URL) => {
      urls.push(String(url));
      if (String(url).includes('/user/repos')) {
        return new Response(JSON.stringify([
          { full_name: 'miki/secret-app', name: 'secret-app', owner: { login: 'miki' }, private: true, default_branch: 'main', description: 'Private core', language: 'TypeScript', pushed_at: '2026-11-20T00:00:00Z', html_url: 'https://github.com/miki/secret-app' },
          { full_name: 'miki/public-lib', name: 'public-lib', owner: { login: 'miki' }, private: false, default_branch: 'main', description: 'Public SDK', language: 'Rust', pushed_at: '2026-11-19T00:00:00Z', html_url: 'https://github.com/miki/public-lib' },
        ]), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    const creds = new GitHubCredentials(new KeyVault(db, SECRET), { GITHUB_PAT: 'github_pat_env' } as NodeJS.ProcessEnv, fetchImpl);
    const routes = createGithubRoutes({
      db,
      approvalGate: gate,
      credentials: creds,
      sandbox: {
        exec: async (_o, cmd) => {
          if (cmd.includes('find . -maxdepth 3')) {
            return { stdout: './secret-app\thttps://github.com/miki/secret-app.git\tmain\t1\t0\t0\n', stderr: '', exitCode: 0 };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      },
      activeConversationFor: () => conv,
      env: { GIT_PROXY_ADMIN_TOKEN: 'adm', GIT_PROXY_URL: 'http://git-proxy:8080', GITHUB_PAT: 'github_pat_env' } as NodeJS.ProcessEnv,
      fetchImpl,
    });

    const vtools = githubVirtualTools({
      db,
      owner: project.id,
      convId: conv,
      listAccountRepos: routes.listAccountRepos,
      listWorkspaceRepos: routes.listWorkspaceRepos,
      cloneRepo: routes.cloneGithubRepo,
    });

    const confirms: string[] = [];
    const seenRequests: Llm.MessageCreateParamsNonStreaming[] = [];
    let step = 0;
    const llm: LlmClient = {
      messages: {
        async create(p) {
          seenRequests.push(p);
          step++;
          if (step === 1) return msg([{ type: 'tool_use', id: 'tu1', name: 'github_list_repos', input: { visibility: 'all' } }], 'tool_use');
          return msg([{ type: 'text', text: 'Listed' }], 'end_turn');
        },
      },
    };

    const history = await runTurn(
      {
        llm,
        model: '@t/m',
        tools: new ToolRegistry([]),
        systemPrompt: 'sys',
        virtualTools: vtools,
        confirm: async label => { confirms.push(label); return true; },
        conversationId: conv,
        projectId: project.id,
      },
      [],
      'show my repos',
    );

    assert.deepEqual(confirms, [], 'github_list_repos is read-only and skips approval');
    assert.ok(urls[0]!.includes('/user/repos?visibility=all&affiliation=owner,collaborator,organization_member'));
    const toolResult = (history.at(-2)!.content as Llm.ToolResultBlockParam[])[0]!.content as string;
    assert.match(toolResult, /miki\/secret-app \(private, default:main, TypeScript\) \[cloned at \/workspace\/secret-app\]/);
    assert.match(toolResult, /miki\/public-lib \(public, default:main, Rust\)/);
  });

  it('requires approval for github_clone_repo and clones multiple repos via git-proxy into distinct folders', async () => {
    const db = openDb(':memory:');
    runMigrations(db);
    const project = createProject(db, { name: 'multi' });
    const conv = createConversation(db, { projectId: project.id }).id;
    const gate = new WebApprovalGate(db);
    const execs: string[] = [];

    const fetchImpl = (async (url: string | URL) => {
      if (String(url).endsWith('/admin/tokens')) {
        return new Response(JSON.stringify({ token: 'gpx_clone', expiresAt: new Date(Date.now() + 3600e3).toISOString() }), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    const creds = new GitHubCredentials(new KeyVault(db, SECRET), { GITHUB_PAT: 'github_pat_env' } as NodeJS.ProcessEnv, fetchImpl);
    const routes = createGithubRoutes({
      db,
      approvalGate: gate,
      credentials: creds,
      sandbox: {
        exec: async (_o, cmd) => {
          execs.push(cmd);
          return { stdout: 'ok', stderr: '', exitCode: 0 };
        },
      },
      activeConversationFor: () => conv,
      env: { GIT_PROXY_ADMIN_TOKEN: 'adm', GIT_PROXY_URL: 'http://git-proxy:8080', GITHUB_PAT: 'github_pat_env' } as NodeJS.ProcessEnv,
      fetchImpl,
    });

    const vtools = githubVirtualTools({
      db,
      owner: project.id,
      convId: conv,
      listAccountRepos: routes.listAccountRepos,
      listWorkspaceRepos: routes.listWorkspaceRepos,
      cloneRepo: routes.cloneGithubRepo,
    });

    const confirms: Array<{ label: string; args: Record<string, unknown> }> = [];
    let allow = true;
    let step = 0;
    const llm: LlmClient = {
      messages: {
        async create() {
          step++;
          if (step === 1) return msg([{ type: 'tool_use', id: 'tu1', name: 'github_clone_repo', input: { repo: 'miki/backend', dir: 'backend' } }], 'tool_use');
          if (step === 2) return msg([{ type: 'tool_use', id: 'tu2', name: 'github_clone_repo', input: { repo: 'github.com/miki/frontend', dir: 'frontend', branch: 'main' } }], 'tool_use');
          return msg([{ type: 'text', text: 'done' }], 'end_turn');
        },
      },
    };

    await runTurn(
      {
        llm,
        model: '@t/m',
        tools: new ToolRegistry([]),
        systemPrompt: 'sys',
        virtualTools: vtools,
        confirm: async (label, args) => {
          confirms.push({ label, args });
          allow = !allow; // deny first, approve second
          return allow ? true : { approved: false, reason: 'denied by test' };
        },
        conversationId: conv,
        projectId: project.id,
      },
      [],
      'clone both',
    );

    assert.equal(confirms.length, 2);
    assert.equal(confirms[0]!.label, 'github_clone_repo');
    assert.equal(execs.filter(c => c.includes('git clone')).length, 1, 'denied call never ran git clone');
    assert.ok(execs.some(c => c.includes("https://github.com/miki/frontend.git 'frontend'")));
    assert.ok(!execs.join('\n').includes('github_pat_env'), 'real GitHub token never entered sandbox');
  });
});
