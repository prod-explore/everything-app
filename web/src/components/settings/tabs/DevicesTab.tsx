import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, Laptop, Pencil, Trash2, X } from 'lucide-react';
import { devicesApi, listApprovalGrants, revokeApprovalGrant } from '../../../api';
import type { ApprovalGrantRow, DeviceInfo, DevicePolicy } from '../../../types';
import { grantText, parseDeviceGrant } from '../../../lib/devices';
import { relativeTime } from '../../../lib/time';
import { Badge } from '../../shared/Badge';
import { Button } from '../../shared/Button';

const field = 'w-full rounded-button border border-border bg-bg px-3 py-1.5 text-sm text-fg outline-none focus:border-border-hover';
const POLL_MS = 5000;

const PLATFORM: Record<DeviceInfo['platform'], string> = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };

type Option<V extends string> = { value: V; label: string; hint: string };

const SHELL_OPTIONS: Option<DevicePolicy['shell']>[] = [
  { value: 'allowlist', label: 'Allowlist', hint: 'Read-only commands and prefixes you allowed run; everything else asks.' },
  { value: 'strict', label: 'Strict', hint: 'Every command asks, except prefixes you allowed.' },
  { value: 'auto', label: 'Auto', hint: 'Commands run without asking. Destructive patterns and the block list still apply.' },
];
const FILES_OPTIONS: Option<DevicePolicy['filesWrite']>[] = [
  { value: 'ask', label: 'Ask', hint: 'Writing, editing and creating folders asks first. Reading never does.' },
  { value: 'auto', label: 'Auto', hint: 'Changes inside the folders the device shares happen without asking.' },
];
const BROWSER_OPTIONS: Option<DevicePolicy['browserAct']>[] = [
  { value: 'ask', label: 'Ask', hint: 'Clicking, typing and submitting on a page asks first. Opening a site is still gated per domain.' },
  { value: 'auto', label: 'Auto', hint: 'The assistant clicks and types without asking, in the accounts you are logged in to in that browser.' },
];

/**
 * Devices tab: the computers paired with this server (tray app → Pair device → approve in the browser).
 * The device decides what it can expose; the levels here decide what is asked before it happens (ADR 0019).
 */
export function DevicesTab() {
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);
  const [grants, setGrants] = useState<ApprovalGrantRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDevices((await devicesApi.list()).devices);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const loadGrants = useCallback(async () => {
    try { setGrants((await listApprovalGrants()).grants.filter(g => g.toolLabel.startsWith('cmd@device-'))); } catch { /* the list is a convenience */ }
  }, []);

  useEffect(() => {
    void load();
    void loadGrants();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load, loadGrants]);

  /** Replaces one row with the server's answer to a PATCH, without waiting for the next poll. */
  const replace = useCallback((d: DeviceInfo) => setDevices(cur => cur && cur.map(x => (x.id === d.id ? d : x))), []);

  return (
    <div className="space-y-4">
      <section>
        <h3 className="mb-1 text-sm font-medium text-fg">Devices</h3>
        <p className="mb-2 text-xs text-fg-tertiary">
          Computers the assistant can work on: a terminal, files and the browser. What a device exposes is set on the device itself; the levels below decide what is asked before it happens.
        </p>
        {devices === null ? (
          <p className="text-sm text-fg-tertiary">{error ? '' : 'Loading devices…'}</p>
        ) : devices.length === 0 ? (
          <EmptyDevices />
        ) : (
          <ul className="space-y-2">
            {devices.map(d => (
              <DeviceRow
                key={d.id}
                device={d}
                grants={grants.filter(g => g.toolLabel.startsWith(`cmd@${d.connectionName}:`))}
                onChange={replace}
                onRevoked={() => { void load(); void loadGrants(); }}
                onGrantRevoked={() => void loadGrants()}
              />
            ))}
          </ul>
        )}
        <p aria-live="polite" className="mt-2 text-xs text-danger">{error && <span role="alert">{error}</span>}</p>
      </section>
    </div>
  );
}

function EmptyDevices() {
  return (
    <div className="flex flex-col items-center gap-2 rounded-button border border-dashed border-border px-4 py-6 text-center">
      <Laptop size={28} strokeWidth={1.5} className="text-fg-tertiary" />
      <p className="text-sm text-fg">No devices yet.</p>
      <ol className="list-inside list-decimal space-y-0.5 text-left text-xs text-fg-tertiary">
        <li>Install the EverythingApp tray app on the computer.</li>
        <li>Set the server URL to <code className="font-mono text-fg-secondary">{window.location.origin}</code>.</li>
        <li>Click <strong>Pair device</strong>. The browser opens here, where you approve it.</li>
      </ol>
    </div>
  );
}

function Segmented<V extends string>({ label, value, options, disabled, onPick }: {
  label: string; value: V; options: Option<V>[]; disabled: boolean; onPick: (v: V) => void;
}) {
  const current = options.find(o => o.value === value);
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-fg-secondary">{label}</div>
      <div role="radiogroup" aria-label={label} className="inline-flex overflow-hidden rounded-button border border-border">
        {options.map(o => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            disabled={disabled}
            onClick={() => { if (o.value !== value) onPick(o.value); }}
            className={`px-3 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              o.value === value ? 'bg-fg text-bg' : 'text-fg-secondary hover:text-fg'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
      {current && <p className="mt-1 text-xs text-fg-tertiary">{current.hint}</p>}
    </div>
  );
}

function exposure(d: DeviceInfo): string[] {
  const r = d.report;
  if (!r) return [];
  const out: string[] = [];
  out.push(r.shell.enabled ? `Terminal: ${r.shell.kind === 'powershell' ? 'PowerShell' : 'POSIX shell'} (${r.shell.path})` : 'Terminal: off');
  out.push(r.files.enabled ? `Files: ${r.files.roots.length ? r.files.roots.join(', ') : 'no folders'} (${r.files.write ? 'read and write' : 'read-only'})` : 'Files: off');
  out.push(r.browser.enabled ? `Browser: ${r.browser.product}, ${r.browser.mode === 'profile' ? 'your profile' : 'dedicated profile'}` : 'Browser: off');
  return out;
}

/** Where a remembered command applies: a chat grant ends with its chat, "always" lasts until forgotten here. */
const GRANT_SCOPE_LABEL: Record<ApprovalGrantRow['scope'], string> = { chat: 'this chat', project: 'project', always: 'always' };

function DeviceRow({ device: d, grants, onChange, onRevoked, onGrantRevoked }: {
  device: DeviceInfo;
  grants: ApprovalGrantRow[];
  onChange: (d: DeviceInfo) => void;
  onRevoked: () => void;
  onGrantRevoked: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(d.name);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (renaming) renameRef.current?.focus(); }, [renaming]);

  async function run(fn: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  const setPolicy = (policy: Partial<DevicePolicy>) => run(async () => onChange(await devicesApi.update(d.id, { policy })));
  const saveName = () => run(async () => {
    const next = name.trim();
    if (next && next !== d.name) onChange(await devicesApi.update(d.id, { name: next }));
    setRenaming(false);
  });
  const revoke = () => run(async () => { await devicesApi.revoke(d.id); onRevoked(); });

  const lines = exposure(d);
  const powershell = d.report?.shell.kind === 'powershell' && d.report.shell.enabled;

  return (
    <li className="rounded-button border border-border" aria-label={d.name}>
      <div className="space-y-1 px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          {renaming ? (
            <form className="flex min-w-0 flex-1 items-center gap-1" onSubmit={e => { e.preventDefault(); void saveName(); }}>
              <input
                ref={renameRef}
                className={field}
                value={name}
                maxLength={40}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setName(d.name); setRenaming(false); } }}
                aria-label={`New name for ${d.name}`}
              />
              <button type="submit" disabled={busy || !name.trim()} className="rounded p-1 text-fg-secondary hover:text-fg disabled:opacity-40" aria-label="Save name"><Check size={14} /></button>
              <button type="button" onClick={() => { setName(d.name); setRenaming(false); }} className="rounded p-1 text-fg-tertiary hover:text-fg" aria-label="Cancel rename"><X size={14} /></button>
            </form>
          ) : (
            <>
              <span className="min-w-0 truncate text-sm font-medium text-fg">{d.name}</span>
              <button onClick={() => { setName(d.name); setRenaming(true); }} className="rounded p-1 text-fg-tertiary hover:text-fg" aria-label={`Rename ${d.name}`}><Pencil size={12} /></button>
            </>
          )}
          <Badge tone={d.online ? 'success' : 'neutral'}>{d.online ? 'online' : 'offline'}</Badge>
          {d.online && <Badge>{d.tools.length} {d.tools.length === 1 ? 'tool' : 'tools'}</Badge>}
        </div>
        <p className="text-xs text-fg-tertiary">
          {PLATFORM[d.platform]} · agent {d.agentVersion} · {d.online ? 'connected' : 'last seen'} {relativeTime(d.online ? d.connectedAt : d.lastSeenAt) || 'never'}
        </p>
        {lines.length > 0 ? (
          <ul className="space-y-0.5 text-xs text-fg-secondary">
            {lines.map(l => <li key={l} className="break-all">{l}</li>)}
          </ul>
        ) : (
          <p className="text-xs text-fg-tertiary">Nothing reported yet — the device has not connected since it was paired.</p>
        )}
      </div>

      <div className="space-y-3 border-t border-border px-3 py-2">
        <Segmented label="Terminal commands" value={d.policy.shell} options={SHELL_OPTIONS} disabled={busy} onPick={v => void setPolicy({ shell: v })} />
        {powershell && d.policy.shell === 'allowlist' && (
          <p role="note" className="flex items-start gap-1.5 rounded-button border border-border px-2 py-1.5 text-xs text-fg-secondary">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            This device uses PowerShell, which the command policy cannot parse. Allowlist behaves like Strict here: only prefixes you allowed run unasked.
          </p>
        )}
        <Segmented label="Writing files" value={d.policy.filesWrite} options={FILES_OPTIONS} disabled={busy} onPick={v => void setPolicy({ filesWrite: v })} />
        <Segmented label="Acting in the browser" value={d.policy.browserAct} options={BROWSER_OPTIONS} disabled={busy} onPick={v => void setPolicy({ browserAct: v })} />

        {grants.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-medium text-fg-secondary">Remembered commands</div>
            <ul className="divide-y divide-border rounded-button border border-border">
              {grants.map(g => (
                <li key={g.id} className="flex items-center gap-2 px-2 py-1 text-xs">
                  <span className="min-w-0 flex-1 truncate font-mono text-fg" title={grantText(g.toolLabel)}>$ {parseDeviceGrant(g.toolLabel)?.command ?? g.toolLabel}</span>
                  <span className="shrink-0 text-fg-tertiary">{GRANT_SCOPE_LABEL[g.scope]}</span>
                  <button
                    onClick={() => void run(async () => { await revokeApprovalGrant(g.id); onGrantRevoked(); })}
                    className="rounded p-1 text-fg-tertiary hover:text-danger"
                    aria-label={`Forget ${grantText(g.toolLabel)}`}
                  ><Trash2 size={12} /></button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          {confirming ? (
            <>
              <span className="text-xs text-fg-secondary">Revoke {d.name}? It disconnects at once and must be paired again.</span>
              <Button variant="danger" disabled={busy} onClick={() => void revoke()}>Confirm revoke</Button>
              <Button variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>Cancel</Button>
            </>
          ) : (
            <button onClick={() => setConfirming(true)} className="ml-auto flex items-center gap-1 text-xs text-fg-tertiary hover:text-danger" aria-label={`Revoke ${d.name}`}>
              <Trash2 size={12} /> Revoke
            </button>
          )}
        </div>
        <p aria-live="polite" className="text-xs text-danger">{error && <span role="alert">{error}</span>}</p>
      </div>
    </li>
  );
}
