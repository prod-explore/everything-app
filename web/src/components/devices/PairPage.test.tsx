import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeCode } from '../../lib/devices';
import { PairPage } from './PairPage';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const pairing = (over = {}) => ({
  userCode: 'ABCD-2345', name: 'Desktop PC', platform: 'windows', agentVersion: '0.3.1', ip: '203.0.113.7',
  createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 9 * 60_000 + 30_000).toISOString(), ...over,
});

function stub(handler: (url: string, method: string, body?: unknown) => Response) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    return handler(url, method, body);
  }));
  return calls;
}

beforeEach(() => window.history.pushState({}, '', '/devices/pair?code=ABCD-2345'));
afterEach(() => { vi.unstubAllGlobals(); window.history.pushState({}, '', '/'); });

describe('normalizeCode', () => {
  it('accepts codes with or without the dash, in any case', () => {
    expect(normalizeCode('abcd2345')).toBe('ABCD-2345');
    expect(normalizeCode(' ABCD-2345 ')).toBe('ABCD-2345');
  });
  it('rejects anything else', () => {
    expect(normalizeCode('ABC')).toBeNull();
    expect(normalizeCode('ABCD-23I5')).toBeNull();
  });
});

describe('PairPage', () => {
  it('shows the request and approves with the device name unchanged', async () => {
    const calls = stub((_u, method) => (method === 'GET' ? json(pairing()) : json({ deviceId: 'd1' })));
    render(<PairPage />);
    expect(await screen.findByText('ABCD-2345')).toBeInTheDocument();
    expect(screen.getByText('Windows')).toBeInTheDocument();
    expect(screen.getByText('203.0.113.7')).toBeInTheDocument();
    expect(screen.getByText('0.3.1')).toBeInTheDocument();
    expect(screen.getByRole('timer')).toHaveTextContent(/^9:[23]\d$/);
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Desktop PC is paired — you can close this tab.')).toBeInTheDocument();
    expect(calls.at(-1)).toMatchObject({ url: '/api/devices/pair/ABCD-2345/approve', method: 'POST', body: {} });
    expect(screen.getByRole('link', { name: 'Back to the app' })).toHaveAttribute('href', '/');
  });

  it('sends an edited name', async () => {
    const calls = stub((_u, method) => (method === 'GET' ? json(pairing()) : json({ deviceId: 'd1' })));
    render(<PairPage />);
    const input = await screen.findByLabelText('Device name');
    await userEvent.clear(input);
    await userEvent.type(input, 'Gaming PC');
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Gaming PC is paired — you can close this tab.')).toBeInTheDocument();
    expect(calls.at(-1)?.body).toEqual({ name: 'Gaming PC' });
  });

  it('denies', async () => {
    const calls = stub((_u, method) => (method === 'GET' ? json(pairing()) : json({})));
    render(<PairPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Deny' }));
    expect(await screen.findByText(/Pairing denied/)).toBeInTheDocument();
    expect(calls.at(-1)).toMatchObject({ url: '/api/devices/pair/ABCD-2345/deny', method: 'POST' });
  });

  it('says so when the code is unknown or expired, and lets the user enter another', async () => {
    const calls = stub((url) => (url.endsWith('ABCD-2345') ? json({ error: 'not found' }, 404) : json(pairing({ userCode: 'WXYZ-6789' }))));
    render(<PairPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('unknown or has expired');
    await userEvent.type(screen.getByLabelText('Code shown on the device'), 'wxyz6789{Enter}');
    expect(await screen.findByText('WXYZ-6789')).toBeInTheDocument();
    expect(calls.at(-1)?.url).toBe('/api/devices/pair/WXYZ-6789');
  });

  it('shows a server error', async () => {
    stub(() => json({ error: 'database down' }, 500));
    render(<PairPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('database down');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('shows an error when approving fails and stays on the page', async () => {
    stub((_u, method) => (method === 'GET' ? json(pairing()) : json({ error: 'too many devices' }, 409)));
    render(<PairPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('too many devices');
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
  });

  it('asks for the code when there is none in the URL', async () => {
    window.history.pushState({}, '', '/devices/pair');
    const calls = stub(() => json(pairing()));
    render(<PairPage />);
    expect(calls).toHaveLength(0);
    await userEvent.type(screen.getByLabelText('Code shown on the device'), 'nope{Enter}');
    expect(await screen.findByText('A code looks like ABCD-2345.')).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText('Code shown on the device'));
    await userEvent.type(screen.getByLabelText('Code shown on the device'), 'ABCD2345{Enter}');
    await waitFor(() => expect(calls[0]?.url).toBe('/api/devices/pair/ABCD-2345'));
  });

  it('disables approving once the pairing has expired', async () => {
    stub(() => json(pairing({ expiresAt: new Date(Date.now() - 1000).toISOString() })));
    render(<PairPage />);
    expect(await screen.findByText('expired')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
  });
});
