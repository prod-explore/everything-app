import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { GitPanel } from './GitPanel';

const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', fetchMock);

function jsonResponse(data: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));
}

describe('GitPanel multi-repo workspace UX', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('shows multi-repo workspace pills with branch/dirty badges, account private/public drawer, and valid clone URL', async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    let localRepos = [
      { dir: 'api', origin: 'https://github.com/miki/api.git', owner: 'miki', repo: 'api', branch: 'main', dirty: 2, ahead: 1, behind: 0 },
      { dir: 'web', origin: 'https://github.com/miki/web.git', owner: 'miki', repo: 'web', branch: 'feat/ui', dirty: 0, ahead: 0, behind: 0 },
    ];

    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, body });

      if (url === '/api/github/status') return jsonResponse({ connected: true, method: 'app', login: 'miki', appConfigured: true, vaultEnabled: true });
      if (url.endsWith('/scm-repos')) return jsonResponse({ repos: localRepos });
      if (url.includes('/github/user/repos')) {
        return jsonResponse([
          { name: 'api', owner: { login: 'miki' }, private: true, default_branch: 'main', description: 'Private API' },
          { name: 'mobile', owner: { login: 'miki' }, private: true, default_branch: 'main', description: 'Private Mobile' },
          { name: 'docs', owner: { login: 'miki' }, private: false, default_branch: 'main', description: 'Public docs' },
        ]);
      }
      if (url.includes('/scm/status')) return jsonResponse({ branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, files: [] });
      if (url.includes('/scm/sync') && body?.action === 'clone') {
        localRepos = [
          ...localRepos,
          { dir: 'mobile', origin: 'https://github.com/miki/mobile.git', owner: 'miki', repo: 'mobile', branch: 'main', dirty: 0, ahead: 0, behind: 0 },
        ];
        return jsonResponse({ output: 'Cloned', dir: 'mobile' });
      }
      if (url.includes('/github/repos/')) return jsonResponse([]);
      return jsonResponse({});
    });

    render(<GitPanel projectId="p1" onClose={() => {}} onConnect={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('2 cloned')).toBeTruthy();
      expect(screen.getByText('Fetch all')).toBeTruthy();
      expect(screen.getByText('api')).toBeTruthy();
      expect(screen.getByText('web')).toBeTruthy();
    });

    // Open Clone drawer -> shows both private & public repos and clones mobile with full URL.
    fireEvent.click(screen.getByLabelText('Clone repository'));
    await waitFor(() => {
      expect(screen.getByText('miki/mobile')).toBeTruthy();
      expect(screen.getByText('miki/docs')).toBeTruthy();
    });

    const cloneButtons = screen.getAllByRole('button', { name: 'Clone' });
    // First "Clone" is form submit; next repo-row "Clone" corresponds to miki/mobile (since api is already cloned -> "Clone copy…").
    fireEvent.click(cloneButtons[1]!);

    await waitFor(() => {
      const cloneCall = calls.find(c => c.url.endsWith('/scm/sync') && (c.body as { action?: string })?.action === 'clone');
      expect(cloneCall?.body).toEqual({ action: 'clone', url: 'https://github.com/miki/mobile' });
      expect(screen.getByText('3 cloned')).toBeTruthy();
    });
  });

  it('offers an always-available Clone into sandbox banner for uncloned GitHub repos without dead-code tab traps', async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ url, body });
      if (url === '/api/github/status') return jsonResponse({ connected: true, method: 'app', login: 'miki', appConfigured: true, vaultEnabled: true });
      if (url.endsWith('/scm-repos')) return jsonResponse({ repos: [] });
      if (url.includes('/github/user/repos')) {
        return jsonResponse([{ name: 'solo', owner: { login: 'miki' }, private: true, default_branch: 'main', description: null }]);
      }
      if (url.includes('/scm/sync')) return jsonResponse({ output: 'ok', dir: 'solo' });
      if (url.includes('/scm/status')) return jsonResponse({ error: 'fatal: not a git repository' }, 502);
      if (url.includes('/github/repos/')) return jsonResponse([]);
      return jsonResponse({});
    });

    render(<GitPanel projectId="p1" onClose={() => {}} onConnect={() => {}} />);

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Repository' })).toBeTruthy();
    });
    const select = screen.getByRole('combobox', { name: 'Repository' }) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'gh:miki/solo' } });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Clone into sandbox' })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Clone into sandbox' }));

    await waitFor(() => {
      const syncCall = calls.find(c => c.url.endsWith('/scm/sync'));
      expect(syncCall?.body).toEqual({ action: 'clone', url: 'https://github.com/miki/solo' });
    });
  });
});
