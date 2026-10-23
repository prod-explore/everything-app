import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tabLabel } from '../../lib/browserTabs';
import { BrowserPanel } from './BrowserPanel';

/** A WebSocket the test can talk through: it records what the panel sends and lets the test play the server. */
class FakeSocket {
  static last: FakeSocket | null = null;
  static OPEN = 1;
  readyState = 1;
  binaryType = '';
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  constructor() { FakeSocket.last = this; }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() {}
  serverSays(msg: object) { act(() => this.onmessage?.({ data: JSON.stringify(msg) })); }
  open() { act(() => this.onopen?.()); }
}

const status = (tabs: Array<{ id: number; url: string; title?: string; active?: boolean }>) => ({
  type: 'status',
  session: true,
  url: tabs.find(t => t.active)?.url ?? '',
  takeover: false,
  tabs: tabs.map(t => ({ title: '', active: false, ...t })),
});

beforeEach(() => {
  FakeSocket.last = null;
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  URL.createObjectURL = () => 'blob:x';
  URL.revokeObjectURL = () => {};
});
afterEach(() => vi.unstubAllGlobals());

function panel() {
  render(<BrowserPanel conversationId="c1" onClose={() => {}} fill />);
  const ws = FakeSocket.last!;
  ws.open();
  return ws;
}
const commands = (ws: FakeSocket) => ws.sent.filter(m => (m as { type: string }).type === 'tab');

describe('tabLabel', () => {
  it('prefers the title, then the site, then "New tab"', () => {
    expect(tabLabel({ title: ' Docs ', url: 'https://a.example/x' })).toBe('Docs');
    expect(tabLabel({ title: '', url: 'https://a.example/x' })).toBe('a.example');
    expect(tabLabel({ title: '', url: 'about:blank' })).toBe('New tab');
    expect(tabLabel({ title: '', url: '' })).toBe('New tab');
  });
});

describe('BrowserPanel tabs', () => {
  it('lists the tabs, marks the active one, and shows nothing before a session exists', () => {
    const ws = panel();
    expect(screen.queryByRole('tablist')).toBeNull();
    ws.serverSays(status([{ id: 1, url: 'https://a.example/', title: 'Alpha' }, { id: 2, url: 'https://b.example/', active: true }]));
    expect(screen.getByRole('tab', { name: 'Alpha' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: 'b.example' })).toHaveAttribute('aria-selected', 'true');
  });

  it('picking another tab asks the server to switch; picking the active one does nothing', () => {
    const ws = panel();
    ws.serverSays(status([{ id: 1, url: 'https://a.example/', title: 'Alpha' }, { id: 2, url: 'https://b.example/', title: 'Bravo', active: true }]));
    fireEvent.click(screen.getByRole('tab', { name: 'Bravo' }));
    expect(commands(ws)).toEqual([]);
    fireEvent.click(screen.getByRole('tab', { name: 'Alpha' }));
    expect(commands(ws)).toEqual([{ type: 'tab', action: 'switch', id: 1 }]);
  });

  it('closes a tab, but offers no close button on the only tab', () => {
    const ws = panel();
    ws.serverSays(status([{ id: 1, url: 'https://a.example/', title: 'Alpha', active: true }]));
    expect(screen.queryByRole('button', { name: /Close tab/ })).toBeNull();
    ws.serverSays(status([{ id: 1, url: 'https://a.example/', title: 'Alpha', active: true }, { id: 4, url: 'https://d.example/', title: 'Delta' }]));
    fireEvent.click(screen.getByRole('button', { name: 'Close tab Delta' }));
    expect(commands(ws)).toEqual([{ type: 'tab', action: 'close', id: 4 }]);
  });

  it('opens a new tab with an address, or blank', () => {
    const ws = panel();
    ws.serverSays(status([{ id: 1, url: 'https://a.example/', active: true }]));
    fireEvent.click(screen.getByRole('button', { name: 'New tab' }));
    fireEvent.change(screen.getByLabelText('New tab address'), { target: { value: ' example.com ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(commands(ws)).toEqual([{ type: 'tab', action: 'new', url: 'example.com' }]);
    expect(screen.queryByLabelText('New tab address')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'New tab' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(commands(ws).at(-1)).toEqual({ type: 'tab', action: 'new', url: undefined });
  });

  it('shows why a tab could not be opened (the limit), and the message goes away by itself', () => {
    vi.useFakeTimers();
    try {
      const ws = panel();
      ws.serverSays(status([{ id: 1, url: 'https://a.example/', active: true }]));
      ws.serverSays({ type: 'error', message: 'Tab limit reached (6 open tabs).' });
      expect(screen.getByRole('alert')).toHaveTextContent('Tab limit reached');
      act(() => { vi.advanceTimersByTime(6100); });
      expect(screen.queryByRole('alert')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
