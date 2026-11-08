import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeviceInfo } from '../../../types';
import { DevicesTab } from './DevicesTab';

const device = (over: Partial<DeviceInfo> = {}): DeviceInfo => ({
  id: 'd1', name: 'Desktop PC', connectionName: 'device-pc', platform: 'windows', agentVersion: '0.3.1',
  online: true, connectedAt: new Date(Date.now() - 5 * 60_000).toISOString(), lastSeenAt: new Date().toISOString(), createdAt: '2026-11-01T10:00:00Z',
  policy: { shell: 'allowlist', filesWrite: 'ask', browserAct: 'ask' },
  report: {
    name: 'Desktop PC', platform: 'windows', arch: 'x64', hostname: 'PC1', agentVersion: '0.3.1',
    shell: { enabled: true, kind: 'posix', path: 'C:\\Program Files\\Git\\bin\\bash.exe' },
    files: { enabled: true, roots: ['C:\\Projects'], write: true },
    browser: { enabled: true, mode: 'profile', product: 'brave', executable: null },
  },
  tools: ['shell_run', 'shell_read', 'fs_read'],
  ...over,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function stubApi(devices: DeviceInfo[], grants: unknown[] = []) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === '/api/devices' && method === 'GET') return json({ devices });
    if (url.startsWith('/api/approval/grants') && method === 'GET') return json({ grants });
    if (url.startsWith('/api/devices/') && method === 'PATCH') {
      const patch = JSON.parse(String(init!.body)) as Partial<DeviceInfo> & { policy?: object };
      return json({ ...devices[0], ...patch, policy: { ...devices[0]!.policy, ...patch.policy } });
    }
    if (url.startsWith('/api/devices/') && method === 'DELETE') return json({});
    return json({}, 404);
  }));
  return calls;
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('DevicesTab', () => {
  it('explains how to add a device when there are none', async () => {
    stubApi([]);
    render(<DevicesTab />);
    expect(await screen.findByText('No devices yet.')).toBeInTheDocument();
    expect(screen.getByText(/Pair device/)).toBeInTheDocument();
  });

  it('shows status, what the device exposes and its tool count', async () => {
    stubApi([device()]);
    render(<DevicesTab />);
    const row = await screen.findByRole('listitem', { name: 'Desktop PC' });
    expect(within(row).getByText('online')).toBeInTheDocument();
    expect(within(row).getByText('3 tools')).toBeInTheDocument();
    expect(within(row).getByText(/Windows · agent 0\.3\.1 · connected 5 min ago/)).toBeInTheDocument();
    expect(within(row).getByText(/Files: C:\\Projects \(read and write\)/)).toBeInTheDocument();
    expect(within(row).getByText(/Browser: brave, your profile/)).toBeInTheDocument();
    expect(within(row).queryByText(/PowerShell, which/)).not.toBeInTheDocument();
  });

  it('shows an offline device with its last seen time', async () => {
    stubApi([device({ online: false, tools: [], lastSeenAt: new Date(Date.now() - 3 * 3600_000).toISOString() })]);
    render(<DevicesTab />);
    expect(await screen.findByText('offline')).toBeInTheDocument();
    expect(screen.getByText(/last seen 3 h ago/)).toBeInTheDocument();
  });

  it('sends only the changed level when a policy is picked', async () => {
    const calls = stubApi([device()]);
    render(<DevicesTab />);
    const group = await screen.findByRole('radiogroup', { name: 'Acting in the browser' });
    await userEvent.click(within(group).getByRole('radio', { name: 'Auto' }));
    await waitFor(() => expect(calls.find(c => c.method === 'PATCH')).toBeDefined());
    expect(calls.find(c => c.method === 'PATCH')).toMatchObject({ url: '/api/devices/d1', body: { policy: { browserAct: 'auto' } } });
    await waitFor(() => expect(within(group).getByRole('radio', { name: 'Auto' })).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByText(/in the accounts you are logged in to/)).toBeInTheDocument();
  });

  it('warns that Allowlist behaves like Strict on PowerShell', async () => {
    const d = device();
    d.report!.shell = { enabled: true, kind: 'powershell', path: 'C:\\pwsh.exe' };
    stubApi([d]);
    render(<DevicesTab />);
    expect(await screen.findByRole('note')).toHaveTextContent('Allowlist behaves like Strict');
  });

  it('does not show the PowerShell note once the level is not Allowlist', async () => {
    const d = device({ policy: { shell: 'auto', filesWrite: 'ask', browserAct: 'ask' } });
    d.report!.shell = { enabled: true, kind: 'powershell', path: 'C:\\pwsh.exe' };
    stubApi([d]);
    render(<DevicesTab />);
    await screen.findByText('Desktop PC');
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('renames inline', async () => {
    const calls = stubApi([device()]);
    render(<DevicesTab />);
    await userEvent.click(await screen.findByRole('button', { name: 'Rename Desktop PC' }));
    const input = screen.getByRole('textbox', { name: 'New name for Desktop PC' });
    await userEvent.clear(input);
    await userEvent.type(input, 'Work PC{Enter}');
    await waitFor(() => expect(calls.find(c => c.method === 'PATCH')?.body).toEqual({ name: 'Work PC' }));
    expect(await screen.findByText('Work PC')).toBeInTheDocument();
  });

  it('revokes only after confirmation', async () => {
    const calls = stubApi([device()]);
    render(<DevicesTab />);
    await userEvent.click(await screen.findByRole('button', { name: 'Revoke Desktop PC' }));
    expect(calls.some(c => c.method === 'DELETE')).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(calls.some(c => c.method === 'DELETE')).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Revoke Desktop PC' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm revoke' }));
    await waitFor(() => expect(calls.find(c => c.method === 'DELETE')?.url).toBe('/api/devices/d1'));
  });

  it('lists remembered device commands readably', async () => {
    stubApi([device()], [
      { id: 'g1', toolLabel: 'cmd@device-pc:git push', scope: 'always', subjectType: null, subjectId: null, conversationId: null, projectId: null, createdAt: '', expiresAt: null },
      { id: 'g2', toolLabel: 'cmd@device-laptop:ls', scope: 'always', subjectType: null, subjectId: null, conversationId: null, projectId: null, createdAt: '', expiresAt: null },
    ]);
    render(<DevicesTab />);
    expect(await screen.findByText('$ git push')).toBeInTheDocument();
    expect(screen.queryByText('$ ls')).not.toBeInTheDocument();
  });

  it('polls the list every 5 seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = stubApi([device()]);
    render(<DevicesTab />);
    await screen.findByText('Desktop PC');
    const before = calls.filter(c => c.url === '/api/devices').length;
    await vi.advanceTimersByTimeAsync(5100);
    expect(calls.filter(c => c.url === '/api/devices').length).toBeGreaterThan(before);
  });

  it('reports a failed load', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'boom' }, 500)));
    render(<DevicesTab />);
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
  });
});
