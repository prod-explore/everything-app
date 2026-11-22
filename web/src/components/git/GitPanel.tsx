import { useCallback, useEffect, useMemo, useState } from 'react';
import { FolderGit2, GitBranch, Lock, Plus, RefreshCw } from 'lucide-react';
import { githubApi, githubConnect, scm, scmRepos } from '../../api-workspace';
import type { ScmRepo } from '../../types-workspace';
import { DockPanel, PanelMessage } from '../shared/DockPanel';
import { GitHubBody, type GitHubTab } from '../github/GitHubPanel';
import { ScmBody } from '../scm/SourceControlPanel';

type ScmTab = 'changes' | 'history' | 'branches';
type GitTab = ScmTab | GitHubTab;

const TABS: { id: GitTab; label: string }[] = [
  { id: 'changes', label: 'Changes' },
  { id: 'history', label: 'History' },
  { id: 'branches', label: 'Branches' },
  { id: 'pulls', label: 'PRs' },
  { id: 'issues', label: 'Issues' },
  { id: 'actions', label: 'Actions' },
];
const isScmTab = (t: GitTab): t is ScmTab => t === 'changes' || t === 'history' || t === 'branches';

interface AccountRepo {
  owner: string;
  repo: string;
  private: boolean;
  defaultBranch: string;
  description: string | null;
}

/** One entry of the shared repository selector: a checkout in the sandbox and/or a GitHub repository. */
interface RepoEntry {
  key: string;
  /** Directory under /workspace when it is checked out in the sandbox; null = GitHub-only (not cloned). */
  dir: string | null;
  owner: string | null;
  repo: string | null;
  branch?: string | null;
  dirty?: number;
  ahead?: number;
  behind?: number;
  private?: boolean;
}

function repoLabel(r: RepoEntry): string {
  if (r.dir !== null) {
    const place = r.dir ? `/workspace/${r.dir}` : '/workspace';
    const slug = r.owner && r.repo ? ` (${r.owner}/${r.repo})` : '';
    const branch = r.branch ? ` [${r.branch}]` : '';
    return `${place}${slug}${branch}`;
  }
  if (r.owner && r.repo) return `${r.owner}/${r.repo}${r.private ? ' [private]' : ''} (not cloned)`;
  return '/workspace';
}

function defaultFolderName(urlOrSlug: string): string {
  return urlOrSlug.trim().replace(/\/+$/, '').replace(/\.git$/, '').split(/[/:]/).pop() ?? '';
}

/**
 * Unified Git panel for multi-repo workspaces: Source Control and GitHub in one dock panel.
 * Supports cloning multiple repositories into distinct folders under `/workspace`, quick switching
 * with per-repo branch/dirty/ahead-behind badges, and browsing connected private/public GitHub repos.
 */
export function GitPanel({ projectId, onClose, onConnect }: { projectId: string; onClose: () => void; onConnect: () => void }) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [local, setLocal] = useState<ScmRepo[] | null>(null);
  const [remote, setRemote] = useState<AccountRepo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<GitTab>('changes');
  const [refreshKey, setRefreshKey] = useState(0);
  const [showCloneDrawer, setShowCloneDrawer] = useState(false);
  const [fetchingAll, setFetchingAll] = useState(false);
  const [bannerBusy, setBannerBusy] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(null);

  useEffect(() => {
    githubConnect.status().then(s => setConnected(s.connected)).catch(() => setConnected(true));
  }, []);

  const loadLocal = useCallback(async (preferDir?: string) => {
    try {
      const r = await scmRepos.list(projectId);
      setLocal(r.repos);
      if (preferDir !== undefined) setSelected(`dir:${preferDir}`);
    } catch {
      setLocal(l => l ?? []);
    }
  }, [projectId]);

  useEffect(() => { void loadLocal(); }, [loadLocal]);

  useEffect(() => {
    let cancelled = false;
    githubApi<Array<{ name: string; owner: { login: string }; private?: boolean; default_branch?: string; description?: string | null }>>(
      projectId,
      '/user/repos?visibility=all&affiliation=owner,collaborator,organization_member&sort=pushed&direction=desc&per_page=100',
    )
      .then(list => {
        if (!cancelled && Array.isArray(list)) {
          setRemote(list.map(r => ({
            owner: r.owner.login,
            repo: r.name,
            private: r.private === true,
            defaultBranch: r.default_branch ?? 'main',
            description: r.description ?? null,
          })));
        }
      })
      .catch(() => { /* not connected / offline: only sandbox repos are listed */ });
    return () => { cancelled = true; };
  }, [projectId, connected]);

  const clonedRepos = useMemo(
    () => (local ?? []).filter(r => r.dir !== '' || Boolean(r.origin)),
    [local],
  );

  const entries = useMemo<RepoEntry[]>(() => {
    const out: RepoEntry[] = [];
    const seen = new Set<string>();
    const remoteBySlug = new Map(remote.map(r => [`${r.owner}/${r.repo}`.toLowerCase(), r]));
    const addLocal = (r: ScmRepo) => {
      const slug = r.owner && r.repo ? `${r.owner}/${r.repo}`.toLowerCase() : null;
      if (slug) seen.add(slug);
      out.push({
        key: `dir:${r.dir}`,
        dir: r.dir,
        owner: r.owner,
        repo: r.repo,
        branch: r.branch,
        dirty: r.dirty,
        ahead: r.ahead,
        behind: r.behind,
        private: slug ? remoteBySlug.get(slug)?.private : undefined,
      });
    };
    for (const r of local ?? []) if (r.dir !== '') addLocal(r);
    addLocal((local ?? []).find(r => r.dir === '') ?? { dir: '', origin: null, owner: null, repo: null });
    for (const r of remote) {
      const id = `${r.owner}/${r.repo}`.toLowerCase();
      if (!seen.has(id)) {
        seen.add(id);
        out.push({ key: `gh:${id}`, dir: null, owner: r.owner, repo: r.repo, private: r.private });
      }
    }
    return out;
  }, [local, remote]);

  const current = useMemo(() => {
    const explicit = entries.find(e => e.key === selected);
    if (explicit) return explicit;
    return entries.find(e => e.dir) ?? entries[0] ?? null;
  }, [entries, selected]);

  const hasGithub = !!(current?.owner && current.repo);
  const disabled = (t: GitTab): boolean => (isScmTab(t) ? current?.dir === null : !hasGithub);

  useEffect(() => {
    setBannerError(null);
    if (!current) return;
    if (disabled(tab)) setTab(current.dir === null ? 'pulls' : 'changes');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when the repository changes, not on every tab switch
  }, [current?.key]);

  const fetchAll = async () => {
    if (fetchingAll || clonedRepos.length === 0) return;
    setFetchingAll(true);
    try {
      await Promise.allSettled(clonedRepos.map(r => scm.sync(projectId, r.dir, 'fetch')));
      setRefreshKey(k => k + 1);
      await loadLocal();
    } finally {
      setFetchingAll(false);
    }
  };

  const cloneSelectedGithubRepo = async () => {
    if (!current || !current.owner || !current.repo || bannerBusy) return;
    setBannerBusy(true);
    setBannerError(null);
    const url = `https://github.com/${current.owner}/${current.repo}`;
    try {
      const res = await scm.sync(projectId, '', 'clone', url);
      const target = res.dir ?? current.repo;
      setTab('changes');
      await loadLocal(target);
    } catch (e) {
      setBannerError((e as Error).message);
    } finally {
      setBannerBusy(false);
    }
  };

  const loading = local === null;

  return (
    <DockPanel
      title="Git"
      icon={<GitBranch size={16} />}
      onClose={onClose}
      actions={
        <div className="flex items-center gap-1">
          {clonedRepos.length >= 2 && (
            <button
              onClick={() => void fetchAll()}
              disabled={fetchingAll}
              className="rounded px-1.5 py-0.5 text-[11px] text-fg-tertiary hover:bg-bg-secondary hover:text-fg disabled:opacity-50"
              title="Fetch all workspace repositories"
            >
              {fetchingAll ? 'Fetching…' : 'Fetch all'}
            </button>
          )}
          <button
            onClick={() => setShowCloneDrawer(v => !v)}
            aria-pressed={showCloneDrawer}
            aria-label="Clone repository"
            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] ${showCloneDrawer ? 'bg-bg-secondary text-fg' : 'text-fg-tertiary hover:bg-bg-secondary hover:text-fg'}`}
          >
            <Plus size={12} />
            <span>Clone</span>
          </button>
          <button
            onClick={() => { setRefreshKey(k => k + 1); void loadLocal(); }}
            className="rounded p-1 text-fg-tertiary hover:text-fg"
            aria-label="Refresh"
          >
            <RefreshCw size={14} />
          </button>
        </div>
      }
    >
      <div className="space-y-1.5 border-b border-border px-3 py-1.5 text-xs">
        <div className="flex items-center gap-1.5">
          <label className="sr-only" htmlFor="git-repo">Repository</label>
          <select
            id="git-repo"
            value={current?.key ?? ''}
            onChange={e => { setSelected(e.target.value); setShowCloneDrawer(false); }}
            className="min-w-0 flex-1 rounded border border-border bg-bg px-1 py-0.5 text-fg"
          >
            {entries.map(r => <option key={r.key} value={r.key}>{repoLabel(r)}</option>)}
          </select>
          <span className="shrink-0 rounded bg-bg-secondary px-1.5 py-0.5 text-[10px] text-fg-tertiary" title="Repositories checked out in /workspace">
            {clonedRepos.length} cloned
          </span>
        </div>

        {clonedRepos.length > 0 && (
          <div className="flex flex-wrap gap-1" aria-label="Workspace repositories">
            {clonedRepos.map(r => {
              const key = `dir:${r.dir}`;
              const active = current?.key === key && !showCloneDrawer;
              const name = r.dir || '/workspace';
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => { setSelected(key); setShowCloneDrawer(false); }}
                  className={`inline-flex max-w-full items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] transition-colors ${
                    active ? 'border-fg bg-bg-secondary text-fg font-medium' : 'border-border text-fg-secondary hover:border-border-hover hover:text-fg'
                  }`}
                >
                  <FolderGit2 size={11} className="shrink-0 text-fg-tertiary" />
                  <span className="truncate">{name}</span>
                  {r.branch && <span className="text-[10px] text-fg-tertiary">({r.branch})</span>}
                  {(r.dirty ?? 0) > 0 && <span className="text-[10px] text-amber-500">•{r.dirty}</span>}
                  {((r.ahead ?? 0) > 0 || (r.behind ?? 0) > 0) && (
                    <span className="text-[10px] text-fg-tertiary">
                      {(r.ahead ?? 0) > 0 ? `↑${r.ahead}` : ''}
                      {(r.behind ?? 0) > 0 ? `↓${r.behind}` : ''}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {!showCloneDrawer && (
          <div className="flex flex-wrap rounded-button border border-border" role="tablist" aria-label="Git views">
            {TABS.map(t => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                disabled={disabled(t.id)}
                title={disabled(t.id) ? (isScmTab(t.id) ? 'Clone this repository into the sandbox first' : 'This folder has no GitHub remote') : undefined}
                onClick={() => setTab(t.id)}
                className={`flex-1 px-2 py-0.5 ${tab === t.id ? 'bg-bg-secondary text-fg' : 'text-fg-tertiary'} disabled:cursor-not-allowed disabled:opacity-40`}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {showCloneDrawer ? (
        <MultiRepoCloneDrawer
          projectId={projectId}
          connected={connected}
          remote={remote}
          clonedRepos={clonedRepos}
          onConnect={onConnect}
          onCloned={async dirName => {
            setShowCloneDrawer(false);
            setTab('changes');
            setRefreshKey(k => k + 1);
            await loadLocal(dirName);
          }}
        />
      ) : loading ? (
        <PanelMessage>Loading…</PanelMessage>
      ) : !current ? (
        <PanelMessage>No repositories found. Click + Clone or log in to GitHub in Settings.</PanelMessage>
      ) : (
        <>
          {current.dir === null && current.owner && current.repo && (
            <div className="space-y-1.5 border-b border-border bg-bg-secondary/50 px-3 py-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="text-fg-secondary">
                  <strong>{current.owner}/{current.repo}</strong> is not cloned in <code className="text-[11px]">/workspace</code> yet.
                </span>
                <button
                  onClick={() => void cloneSelectedGithubRepo()}
                  disabled={bannerBusy}
                  className="shrink-0 rounded-button bg-fg px-2.5 py-1 text-[11px] font-medium text-bg disabled:opacity-50"
                >
                  {bannerBusy ? 'Cloning…' : 'Clone into sandbox'}
                </button>
              </div>
              {bannerError && <p className="text-[11px] text-danger">{bannerError}</p>}
            </div>
          )}

          {isScmTab(tab) ? (
            current.dir !== null ? (
              <ScmBody
                key={`${current.key}:${tab}`}
                projectId={projectId}
                dir={current.dir}
                tab={tab}
                refreshKey={refreshKey}
                onCloned={async name => {
                  setRefreshKey(k => k + 1);
                  await loadLocal(name);
                }}
              />
            ) : (
              <PanelMessage>Clone the repository above to inspect Changes, History, and Branches.</PanelMessage>
            )
          ) : connected === false ? (
            <div className="space-y-3 p-4 text-center">
              <PanelMessage>GitHub is not connected yet.</PanelMessage>
              <button onClick={onConnect} className="rounded-button bg-fg px-4 py-2 text-sm font-medium text-bg hover:opacity-90">Connect GitHub</button>
            </div>
          ) : hasGithub ? (
            <GitHubBody key={`${current.key}:${tab}:${refreshKey}`} projectId={projectId} repo={{ owner: current.owner!, repo: current.repo! }} tab={tab as GitHubTab} />
          ) : (
            <PanelMessage>This folder has no GitHub remote.</PanelMessage>
          )}
        </>
      )}
    </DockPanel>
  );
}

/** Drawer to clone one or more repositories (from URL or from the connected GitHub account's private/public list). */
function MultiRepoCloneDrawer({
  projectId,
  connected,
  remote,
  clonedRepos,
  onConnect,
  onCloned,
}: {
  projectId: string;
  connected: boolean | null;
  remote: AccountRepo[];
  clonedRepos: ScmRepo[];
  onConnect: () => void;
  onCloned: (dirName: string) => Promise<void>;
}) {
  const [url, setUrl] = useState('');
  const [dir, setDir] = useState('');
  const [branch, setBranch] = useState('');
  const [filter, setFilter] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const clonedBySlug = useMemo(() => {
    const m = new Map<string, ScmRepo[]>();
    for (const r of clonedRepos) {
      if (!r.owner || !r.repo) continue;
      const slug = `${r.owner}/${r.repo}`.toLowerCase();
      const arr = m.get(slug) ?? [];
      arr.push(r);
      m.set(slug, arr);
    }
    return m;
  }, [clonedRepos]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return remote;
    return remote.filter(r =>
      `${r.owner}/${r.repo}`.toLowerCase().includes(q) || (r.description ?? '').toLowerCase().includes(q),
    );
  }, [remote, filter]);

  async function doClone(targetUrl: string, targetDir?: string, targetBranch?: string, key = 'form') {
    if (busyKey) return;
    setBusyKey(key);
    setError(null);
    try {
      const res = await scm.sync(projectId, '', 'clone', targetUrl, {
        ...(targetDir?.trim() ? { dir: targetDir.trim() } : {}),
        ...(targetBranch?.trim() ? { branch: targetBranch.trim() } : {}),
      });
      const resolvedDir = res.dir ?? (targetDir?.trim() || defaultFolderName(targetUrl));
      setUrl('');
      setDir('');
      setBranch('');
      await onCloned(resolvedDir);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="space-y-3 p-3 text-xs">
      <form
        className="space-y-2 rounded border border-border p-2"
        onSubmit={e => {
          e.preventDefault();
          if (!url.trim()) return;
          void doClone(url.trim(), dir, branch, 'form');
        }}
      >
        <div className="font-medium text-fg">Clone repository into /workspace</div>
        <input
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder="owner/repo or https://github.com/owner/repo"
          aria-label="GitHub repository URL or owner/repo"
          className="w-full rounded border border-border bg-bg px-2 py-1 text-fg outline-none focus:border-border-hover"
        />
        <div className="grid grid-cols-2 gap-1.5">
          <input
            value={dir}
            onChange={e => setDir(e.target.value)}
            placeholder="Folder (optional, e.g. api)"
            aria-label="Target folder under /workspace"
            className="rounded border border-border bg-bg px-2 py-1 text-fg outline-none focus:border-border-hover"
          />
          <input
            value={branch}
            onChange={e => setBranch(e.target.value)}
            placeholder="Branch (optional)"
            aria-label="Branch name"
            className="rounded border border-border bg-bg px-2 py-1 text-fg outline-none focus:border-border-hover"
          />
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-fg-tertiary">Credentials stay in git-proxy. Multiple repos share this workspace.</span>
          <button
            type="submit"
            disabled={!url.trim() || !!busyKey}
            className="shrink-0 rounded-button bg-fg px-3 py-1 font-medium text-bg disabled:opacity-50"
          >
            {busyKey === 'form' ? 'Cloning…' : 'Clone'}
          </button>
        </div>
        {error && <p className="text-[11px] text-danger">{error}</p>}
      </form>

      {connected === false ? (
        <div className="space-y-2 rounded border border-border p-3 text-center">
          <p className="text-fg-tertiary">Connect GitHub to browse your private and public repositories.</p>
          <button onClick={onConnect} className="rounded-button bg-fg px-3 py-1 font-medium text-bg">Connect GitHub</button>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-fg-secondary">Your GitHub repositories</span>
            <input
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder="Filter…"
              aria-label="Filter GitHub repositories"
              className="w-36 rounded border border-border bg-bg px-2 py-0.5 text-[11px] text-fg outline-none focus:border-border-hover"
            />
          </div>
          {filtered.length === 0 ? (
            <p className="py-2 text-center text-fg-tertiary">{remote.length ? 'No matching repositories.' : 'No repositories loaded.'}</p>
          ) : (
            <ul className="divide-y divide-border rounded border border-border">
              {filtered.slice(0, 30).map(r => {
                const slug = `${r.owner}/${r.repo}`;
                const existing = clonedBySlug.get(slug.toLowerCase()) ?? [];
                const key = `gh:${slug}`;
                return (
                  <li key={slug} className="flex items-center justify-between gap-2 px-2 py-1.5">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        {r.private && <Lock size={11} className="shrink-0 text-fg-tertiary" aria-label="Private" />}
                        <span className="truncate font-medium text-fg">{slug}</span>
                        <span className="rounded bg-bg-secondary px-1 py-0.2 text-[10px] text-fg-tertiary">
                          {r.private ? 'Private' : 'Public'}
                        </span>
                        {existing.length > 0 && (
                          <span className="truncate text-[10px] text-fg-tertiary">
                            in {existing.map(x => (x.dir ? `/workspace/${x.dir}` : '/workspace')).join(', ')}
                          </span>
                        )}
                      </div>
                      {r.description && <p className="truncate text-[11px] text-fg-tertiary">{r.description}</p>}
                    </div>
                    <button
                      type="button"
                      disabled={!!busyKey}
                      onClick={() => {
                        if (existing.length > 0) {
                          setUrl(slug);
                          setDir(`${r.repo}-2`);
                          return;
                        }
                        void doClone(`https://github.com/${slug}`, undefined, undefined, key);
                      }}
                      className="shrink-0 rounded-button border border-border px-2 py-0.5 text-[11px] text-fg hover:border-border-hover disabled:opacity-50"
                    >
                      {busyKey === key ? 'Cloning…' : existing.length > 0 ? 'Clone copy…' : 'Clone'}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
