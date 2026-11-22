import type Database from 'better-sqlite3';
import type { VirtualTool } from './llm-loop.js';
import { logApprovalAudit } from './db.js';
import type { AccountRepo, WorkspaceRepo } from './github-routes.js';

export const GITHUB_TOOLS_PROMPT =
  'You can inspect and clone repositories from the user\'s connected GitHub account (both private and public) into `/workspace`: ' +
  '`github_list_repos` lists accessible GitHub repositories and shows which ones are already cloned in `/workspace`. ' +
  '`github_clone_repo` clones a repository through `git-proxy` after user approval; pass `dir` to keep multiple repositories in one workspace without collisions. ' +
  'Real GitHub credentials never enter the sandbox — git pushes also require approval through `git-proxy`.';

export interface GithubToolsDeps {
  db: Database.Database;
  owner: string;
  convId: string;
  runId?: string;
  listAccountRepos: (opts?: { visibility?: 'all' | 'private' | 'public'; query?: string; limit?: number }) => Promise<{ connected: boolean; repos: AccountRepo[] }>;
  listWorkspaceRepos: (ownerId: string) => Promise<WorkspaceRepo[]>;
  cloneRepo: (ownerId: string, opts: { repo: unknown; dir?: unknown; branch?: unknown; depth?: unknown }) => Promise<{ dir: string; path: string; owner: string; repo: string; output: string }>;
}

/**
 * Virtual tools for discovering private/public GitHub repositories and cloning into `/workspace`.
 * Read-only listing runs without a card; cloning goes through the Approval Gate and uses `git-proxy` so GitHub tokens
 * never enter the sandbox (ADR 0003).
 */
export function githubVirtualTools(deps: GithubToolsDeps): VirtualTool[] {
  return [
    {
      definition: {
        name: 'github_list_repos',
        description:
          'List GitHub repositories accessible to the user (both private and public) and repositories currently cloned in `/workspace`. ' +
          'Use `query` to filter by name/description/language, or `visibility` ("all" | "private" | "public"). Read-only.',
        input_schema: {
          type: 'object',
          properties: {
            visibility: { type: 'string', enum: ['all', 'private', 'public'], description: 'Filter by visibility. Default "all".' },
            query: { type: 'string', description: 'Optional case-insensitive filter matching repository name, description, or language.' },
            limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum repositories to return. Default 30.' },
          },
        },
      },
      handler: async input => {
        const visibility = input['visibility'] === 'private' || input['visibility'] === 'public' ? input['visibility'] : 'all';
        const query = typeof input['query'] === 'string' ? input['query'] : undefined;
        const limit = typeof input['limit'] === 'number' ? input['limit'] : 30;
        const [account, local] = await Promise.all([
          deps.listAccountRepos({ visibility, query, limit }),
          deps.listWorkspaceRepos(deps.owner).catch(() => [] as WorkspaceRepo[]),
        ]);
        const clonedBySlug = new Map<string, WorkspaceRepo[]>();
        for (const r of local) {
          if (!r.owner || !r.repo) continue;
          const key = `${r.owner}/${r.repo}`.toLowerCase();
          const list = clonedBySlug.get(key) ?? [];
          list.push(r);
          clonedBySlug.set(key, list);
        }

        const lines: string[] = [];
        if (!account.connected) {
          lines.push('GitHub account is not connected yet (configure it in Settings → GitHub).');
        } else if (account.repos.length === 0) {
          lines.push(query ? `No GitHub repositories matching "${query}" (visibility: ${visibility}).` : `No GitHub repositories found (visibility: ${visibility}).`);
        } else {
          lines.push(`GitHub repositories (${account.repos.length} shown, visibility=${visibility}):`);
          for (const r of account.repos) {
            const matches = clonedBySlug.get(r.fullName.toLowerCase()) ?? [];
            const clonedNote = matches.length
              ? ` [cloned at ${matches.map(m => (m.dir ? `/workspace/${m.dir}` : '/workspace')).join(', ')}]`
              : '';
            const meta = [r.private ? 'private' : 'public', `default:${r.defaultBranch}`, ...(r.language ? [r.language] : [])].join(', ');
            const desc = r.description ? ` — ${r.description}` : '';
            lines.push(`- ${r.fullName} (${meta})${clonedNote}${desc}`);
          }
        }

        const workspaceRepos = local.filter(r => r.dir !== '' || r.origin);
        if (workspaceRepos.length > 0) {
          lines.push('', `Workspace checkouts (${workspaceRepos.length}):`);
          for (const w of workspaceRepos) {
            const where = w.dir ? `/workspace/${w.dir}` : '/workspace';
            const slug = w.owner && w.repo ? `${w.owner}/${w.repo}` : w.origin ?? 'no remote';
            const stateParts = [
              ...(w.branch ? [w.branch] : []),
              ...(w.dirty ? [`${w.dirty} modified`] : []),
              ...(w.ahead ? [`↑${w.ahead}`] : []),
              ...(w.behind ? [`↓${w.behind}`] : []),
            ];
            lines.push(`- ${where} (${slug})${stateParts.length ? ` [${stateParts.join(', ')}]` : ''}`);
          }
        }
        return { text: lines.join('\n') };
      },
    },
    {
      definition: {
        name: 'github_clone_repo',
        description:
          'Clone a GitHub repository (private or public) into the workspace via `git-proxy` (requires user approval). ' +
          'You can clone multiple repositories into the same `/workspace` by giving each a distinct `dir` (e.g. "api", "frontend").',
        input_schema: {
          type: 'object',
          properties: {
            repo: { type: 'string', description: 'Repository slug ("owner/repo") or https://github.com/owner/repo URL.' },
            dir: { type: 'string', description: 'Target folder relative to /workspace (defaults to the repository name). Pass a custom folder to clone multiple repos or branches.' },
            branch: { type: 'string', description: 'Optional branch or tag to check out instead of the default branch.' },
            depth: { type: 'integer', minimum: 1, maximum: 10000, description: 'Optional shallow clone depth (e.g. 1).' },
          },
          required: ['repo'],
        },
      },
      requiresApproval: true,
      approvalLabel: () => 'github_clone_repo',
      handler: async input => {
        const res = await deps.cloneRepo(deps.owner, {
          repo: input['repo'],
          dir: input['dir'],
          branch: input['branch'],
          depth: input['depth'],
        });
        logApprovalAudit(deps.db, {
          action: 'github_clone_agent',
          toolLabel: 'github_clone_repo',
          toolArgs: JSON.stringify({
            repo: `${res.owner}/${res.repo}`,
            dir: res.dir,
            ...(typeof input['branch'] === 'string' && input['branch'].trim() ? { branch: input['branch'].trim() } : {}),
          }).slice(0, 4000),
          conversationId: deps.convId,
          runId: deps.runId,
        });
        return {
          text: `Cloned ${res.owner}/${res.repo} into ${res.path}.${res.output ? `\n${res.output}` : ''}`,
        };
      },
    },
  ];
}
