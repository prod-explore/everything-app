import { useEffect, useState } from 'react';
import { ApiError, devicesApi } from '../../api';
import type { PendingPairing } from '../../types';
import { normalizeCode } from '../../lib/devices';
import { Button } from '../shared/Button';

const PLATFORM = { windows: 'Windows', macos: 'macOS', linux: 'Linux' } as const;

function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

type Phase =
  | { kind: 'enter' }
  | { kind: 'loading' }
  | { kind: 'ready'; pairing: PendingPairing }
  | { kind: 'missing' }
  | { kind: 'done'; result: 'approved' | 'denied'; name: string }
  | { kind: 'failed'; message: string };

/**
 * /devices/pair?code=XXXX-XXXX — the page a device's tray app opens. Behind the normal login. The user checks that the
 * code matches the one on the device (the defence against a pairing someone else started), then approves or denies.
 */
export function PairPage() {
  const initial = new URLSearchParams(window.location.search).get('code');
  const [code, setCode] = useState<string | null>(initial ? normalizeCode(initial) : null);
  const [phase, setPhase] = useState<Phase>(initial ? (normalizeCode(initial) ? { kind: 'loading' } : { kind: 'missing' }) : { kind: 'enter' });

  const [attempt, setAttempt] = useState(0);
  const pick = (c: string) => { setCode(c); setAttempt(a => a + 1); };

  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    setPhase({ kind: 'loading' });
    devicesApi.pairing(code).then(
      pairing => { if (!cancelled) setPhase({ kind: 'ready', pairing }); },
      (e: unknown) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 401) return; // the app shell shows the login
        setPhase(e instanceof ApiError && e.status === 404 ? { kind: 'missing' } : { kind: 'failed', message: (e as Error).message });
      },
    );
    return () => { cancelled = true; };
  }, [code, attempt]);

  return (
    <div className="flex min-h-full flex-col items-center justify-center bg-bg p-4 sm:p-6">
      <main className="w-full max-w-md rounded-container border border-border bg-bg-secondary p-5 sm:p-6" aria-labelledby="pair-title">
        <h1 id="pair-title" className="mb-4 text-lg font-medium text-fg">Pair a device</h1>
        {phase.kind === 'enter' && <EnterCode onSubmit={pick} />}
        {phase.kind === 'loading' && <p role="status" className="text-sm text-fg-tertiary">Looking up the pairing…</p>}
        {phase.kind === 'missing' && (
          <div className="space-y-3">
            <p role="alert" className="text-sm text-fg">This code is unknown or has expired.</p>
            <p className="text-xs text-fg-tertiary">A pairing lasts 10 minutes. Click <strong>Pair device</strong> in the tray app again, or enter the code from the device:</p>
            <EnterCode onSubmit={pick} />
          </div>
        )}
        {phase.kind === 'failed' && (
          <div className="space-y-3">
            <p role="alert" className="break-words text-sm text-danger">{phase.message}</p>
            <Button variant="ghost" onClick={() => setAttempt(a => a + 1)}>Try again</Button>
          </div>
        )}
        {phase.kind === 'ready' && (
          <Review pairing={phase.pairing} onDone={(result, name) => setPhase({ kind: 'done', result, name })} onGone={() => setPhase({ kind: 'missing' })} />
        )}
        {phase.kind === 'done' && (
          <div className="space-y-3" role="status">
            <p className="text-sm text-fg">
              {phase.result === 'approved' ? `${phase.name} is paired — you can close this tab.` : 'Pairing denied. The device was not connected.'}
            </p>
            <a href="/" className="inline-block text-sm text-fg-secondary underline hover:text-fg">Back to the app</a>
          </div>
        )}
      </main>
    </div>
  );
}

function EnterCode({ onSubmit }: { onSubmit: (code: string) => void }) {
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState(false);
  return (
    <form
      className="space-y-2"
      onSubmit={e => {
        e.preventDefault();
        const c = normalizeCode(value);
        if (c) onSubmit(c); else setInvalid(true);
      }}
    >
      <label htmlFor="pair-code" className="block text-sm text-fg-secondary">Code shown on the device</label>
      <input
        id="pair-code"
        autoFocus
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        placeholder="XXXX-XXXX"
        value={value}
        onChange={e => { setValue(e.target.value); setInvalid(false); }}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? 'pair-code-error' : undefined}
        className="w-full rounded-button border border-border bg-bg px-3 py-2 font-mono text-base tracking-widest text-fg outline-none placeholder:text-fg-tertiary focus:border-border-hover"
      />
      {invalid && <p id="pair-code-error" role="alert" className="text-xs text-danger">A code looks like ABCD-2345.</p>}
      <Button type="submit" disabled={!value.trim()}>Continue</Button>
    </form>
  );
}

function Review({ pairing, onDone, onGone }: {
  pairing: PendingPairing;
  onDone: (result: 'approved' | 'denied', name: string) => void;
  onGone: () => void;
}) {
  const [name, setName] = useState(pairing.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [left, setLeft] = useState(() => Date.parse(pairing.expiresAt) - Date.now());

  useEffect(() => {
    const t = setInterval(() => setLeft(Date.parse(pairing.expiresAt) - Date.now()), 1000);
    return () => clearInterval(t);
  }, [pairing.expiresAt]);
  const expired = Number.isFinite(left) && left <= 0;

  async function answer(approve: boolean) {
    setBusy(true); setError(null);
    try {
      if (approve) {
        const finalName = name.trim() || pairing.name;
        await devicesApi.approve(pairing.userCode, finalName !== pairing.name ? finalName : undefined);
        onDone('approved', finalName);
      } else {
        await devicesApi.deny(pairing.userCode);
        onDone('denied', pairing.name);
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) onGone(); else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-fg-secondary">A device wants to connect to this server. Check that this code matches the one on the device, and only then approve.</p>
      <div className="rounded-button border border-border bg-bg px-3 py-4 text-center">
        <div className="mb-1 text-xs text-fg-tertiary">Code</div>
        <div className="select-all font-mono text-3xl tracking-[0.2em] text-fg" aria-label={`Pairing code ${pairing.userCode.split('').join(' ')}`}>{pairing.userCode}</div>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-fg-tertiary">Platform</dt><dd className="text-fg">{PLATFORM[pairing.platform] ?? pairing.platform}</dd>
        <dt className="text-fg-tertiary">Agent</dt><dd className="text-fg">{pairing.agentVersion}</dd>
        <dt className="text-fg-tertiary">Requested from</dt><dd className="break-all font-mono text-fg">{pairing.ip}</dd>
        <dt className="text-fg-tertiary">Expires in</dt>
        <dd className={expired ? 'text-danger' : 'text-fg'}>{expired ? 'expired' : <span role="timer" aria-label="Time left">{countdown(left)}</span>}</dd>
      </dl>
      <div>
        <label htmlFor="pair-name" className="mb-1 block text-xs text-fg-tertiary">Device name</label>
        <input
          id="pair-name"
          value={name}
          maxLength={40}
          onChange={e => setName(e.target.value)}
          className="w-full rounded-button border border-border bg-bg px-3 py-1.5 text-sm text-fg outline-none focus:border-border-hover"
        />
      </div>
      <div className="flex gap-2">
        <Button variant="ghost" className="flex-1" disabled={busy || expired} onClick={() => void answer(false)}>Deny</Button>
        <Button className="flex-1" disabled={busy || expired || !name.trim()} onClick={() => void answer(true)}>Approve</Button>
      </div>
      <p aria-live="polite" className="text-xs text-danger">{error && <span role="alert">{error}</span>}</p>
      <p className="text-xs text-fg-tertiary">Approving gives this device a token for its own connection only. You set what it may do afterwards under Settings → Devices.</p>
    </div>
  );
}
