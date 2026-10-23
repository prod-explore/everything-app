import { useEffect, useId, useState } from 'react';
import { previewSchedule } from '../../api';
import { APPROVAL_WAITS, CRON_PRESETS, defaultOnce, formatWhen, isOnceCron, localTimeZone, onceInputValue, presetFor, timeZoneChoices } from '../../lib/schedules';
import type { ModelOption, ProjectListItem, Schedule, SchedulePreview, ScheduleInput } from '../../types';
import { Button } from '../shared/Button';
import { ModelOptions } from '../shared/ModelOptions';

const INPUT_CLASS =
  'w-full rounded-button border border-border bg-bg px-3 py-2 text-sm text-fg outline-none placeholder:text-fg-tertiary focus:border-border-hover';
const CUSTOM = '__custom__';
const ONCE = '__once__';
type Mode = 'preset' | 'custom' | 'once';
const MAX_PROMPT = 8000;

const EMPTY: ScheduleInput = {
  name: '',
  prompt: '',
  cron: CRON_PRESETS[1]!.cron,
  timezone: localTimeZone(),
  model: null,
  projectId: null,
  allowPaid: false,
  enabled: true,
  maxRuns: null,
  approvalWaitMin: 0,
};

function Field({ label, hint, htmlFor, children }: { label: string; hint?: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-xs font-medium text-fg-secondary">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-fg-tertiary">{hint}</p>}
    </div>
  );
}

/** Create or edit a scheduled task. `initial` = the task being edited; nothing = a new one. */
export function ScheduleForm({
  initial,
  models,
  projects,
  onSave,
  onCancel,
}: {
  initial?: Schedule;
  models: ModelOption[];
  projects: ProjectListItem[];
  /** Rejects with the server's message; the form shows it and stays open. */
  onSave: (input: ScheduleInput) => Promise<void>;
  onCancel: () => void;
}) {
  const uid = useId();
  const [draft, setDraft] = useState<ScheduleInput>(() =>
    initial
      ? { name: initial.name, prompt: initial.prompt, cron: initial.cron, timezone: initial.timezone, model: initial.model, projectId: initial.projectId, allowPaid: initial.allowPaid, enabled: initial.enabled, maxRuns: initial.maxRuns, approvalWaitMin: initial.approvalWaitMin }
      : EMPTY,
  );
  const [mode, setMode] = useState<Mode>(() => (isOnceCron(draft.cron) ? 'once' : presetFor(draft.cron) ? 'preset' : 'custom'));
  const [preview, setPreview] = useState<SchedulePreview | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof ScheduleInput>(key: K, value: ScheduleInput[K]) => setDraft(d => ({ ...d, [key]: value }));

  // Ask the server what this timetable means (it owns the cron parser), a moment after the person stops typing.
  useEffect(() => {
    if (!draft.cron.trim()) { setPreview(null); return; }
    let live = true;
    const timer = setTimeout(() => {
      previewSchedule(draft.cron, draft.timezone)
        .then(p => live && setPreview(p))
        .catch(() => live && setPreview(null));
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [draft.cron, draft.timezone]);

  const zones = timeZoneChoices(draft.timezone);
  const missing = !draft.name.trim() ? 'Give it a name.' : !draft.prompt.trim() ? 'Say what the agent should do.' : !draft.cron.trim() ? 'Pick a date and time.' : null;
  // A timetable the server rejects is already spelled out in the preview box; it only blocks saving.
  const problem = missing ?? (preview && !preview.ok ? preview.error : null);
  const projectsUsable = projects.filter(p => !p.ghost);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (problem) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({ ...draft, name: draft.name.trim(), cron: draft.cron.trim() });
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }

  return (
    <form onSubmit={e => void submit(e)} className="space-y-4" aria-label={initial ? 'Edit scheduled task' : 'New scheduled task'}>
      <Field label="Name" htmlFor={`${uid}-name`}>
        <input id={`${uid}-name`} value={draft.name} maxLength={80} onChange={e => set('name', e.target.value)} placeholder="Morning job-board check" className={INPUT_CLASS} autoFocus />
      </Field>

      <Field
        label="What should the agent do?"
        htmlFor={`${uid}-prompt`}
        hint={`${draft.prompt.length}/${MAX_PROMPT} — it runs on its own, so be specific about what to look at and what to report. It cannot ask you anything while it runs.`}
      >
        <textarea
          id={`${uid}-prompt`}
          value={draft.prompt}
          maxLength={MAX_PROMPT}
          onChange={e => set('prompt', e.target.value)}
          rows={5}
          placeholder="Check these job boards for new Python backend roles in Warsaw and report the new ones with links."
          className={`${INPUT_CLASS} resize-y`}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Repeats" htmlFor={`${uid}-preset`}>
          <select
            id={`${uid}-preset`}
            value={mode === 'once' ? ONCE : mode === 'custom' ? CUSTOM : presetFor(draft.cron)?.cron ?? CUSTOM}
            onChange={e => {
              const v = e.target.value;
              if (v === ONCE) { setMode('once'); setDraft(d => ({ ...d, cron: isOnceCron(d.cron) ? d.cron : defaultOnce(), maxRuns: null })); }
              else if (v === CUSTOM) setMode('custom');
              else { setMode('preset'); set('cron', v); }
            }}
            className={INPUT_CLASS}
          >
            {CRON_PRESETS.map(p => (
              <option key={p.cron} value={p.cron}>
                {p.label}
              </option>
            ))}
            <option value={ONCE}>Once, at a date and time…</option>
            <option value={CUSTOM}>Custom (cron)…</option>
          </select>
        </Field>
        <Field label="Time zone" htmlFor={`${uid}-tz`}>
          <select id={`${uid}-tz`} value={draft.timezone} onChange={e => set('timezone', e.target.value)} className={INPUT_CLASS}>
            {zones.map(z => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {mode === 'once' && (
        <Field label="Date and time" htmlFor={`${uid}-once`} hint="In the time zone chosen above. It runs once and is then finished.">
          <input id={`${uid}-once`} type="datetime-local" value={onceInputValue(draft.cron)} onChange={e => set('cron', e.target.value)} className={INPUT_CLASS} />
        </Field>
      )}

      {mode === 'custom' && (
        <Field label="Cron expression" htmlFor={`${uid}-cron`} hint="minute hour day-of-month month day-of-week, e.g. 30 7 * * 1-5. Not more often than every 15 minutes.">
          <input id={`${uid}-cron`} value={draft.cron} onChange={e => set('cron', e.target.value)} className={`${INPUT_CLASS} font-mono`} spellCheck={false} />
        </Field>
      )}

      <div className="min-h-10 rounded-button border border-border bg-bg px-3 py-2 text-xs" aria-live="polite">
        {preview?.ok ? (
          <>
            <p className="mb-1 text-fg-secondary">Next runs</p>
            <ul className="space-y-0.5 text-fg-tertiary">
              {preview.next.map(t => (
                <li key={t}>{formatWhen(t, draft.timezone)}</li>
              ))}
            </ul>
          </>
        ) : preview ? (
          <p className="text-danger" role="alert">
            {preview.error}
          </p>
        ) : (
          <p className="text-fg-tertiary">Checking the schedule…</p>
        )}
      </div>

      {mode !== 'once' && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-fg-secondary">
          <label className="flex cursor-pointer items-center gap-2">
            <input type="checkbox" checked={draft.maxRuns !== null} onChange={e => set('maxRuns', e.target.checked ? 5 : null)} className="h-4 w-4 accent-[var(--color-fg)]" />
            Stop after
          </label>
          <input
            type="number"
            min={1}
            max={1000}
            aria-label="Number of runs"
            disabled={draft.maxRuns === null}
            value={draft.maxRuns ?? ''}
            onChange={e => set('maxRuns', e.target.value === '' ? 1 : Math.max(1, Math.min(1000, Math.trunc(Number(e.target.value)) || 1)))}
            className="w-20 rounded-button border border-border bg-bg px-2 py-1 text-sm text-fg outline-none focus:border-border-hover disabled:opacity-40"
          />
          <span>runs</span>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Model" htmlFor={`${uid}-model`} hint="By default the model of the Agents slot, and only a free one unless you allow paid models below.">
          <select id={`${uid}-model`} value={draft.model ?? ''} onChange={e => set('model', e.target.value || null)} className={INPUT_CLASS}>
            <option value="">Automatic (Agents slot)</option>
            <ModelOptions models={models} current={draft.model} />
          </select>
        </Field>
        <Field label="Project" htmlFor={`${uid}-project`} hint="Its files, notes and rules are what the agent works with.">
          <select id={`${uid}-project`} value={draft.projectId ?? ''} onChange={e => set('projectId', e.target.value || null)} className={INPUT_CLASS}>
            <option value="">No project</option>
            {projectsUsable.map(p => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="space-y-2">
        <label className="flex cursor-pointer items-start gap-2 text-sm text-fg-secondary">
          <input type="checkbox" checked={draft.allowPaid} onChange={e => set('allowPaid', e.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--color-fg)]" />
          <span>
            Allow paid models
            <span className="block text-xs text-fg-tertiary">Off: a run on a model that costs money is refused. Every run is a full agent turn, so this is the one to keep an eye on.</span>
          </span>
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-fg-secondary">
          <input type="checkbox" checked={draft.enabled} onChange={e => set('enabled', e.target.checked)} className="h-4 w-4 accent-[var(--color-fg)]" />
          Enabled
        </label>
      </div>

      <Field
        label="When the agent needs an approval"
        htmlFor={`${uid}-wait`}
        hint="Nobody is at the keyboard during a run. What you already allowed for good (“Always”, or policy.json) just works; anything else is asked in Gazeta, with a notification. “Always allow” there is remembered, so the next runs do not stop at the same thing."
      >
        <select id={`${uid}-wait`} value={draft.approvalWaitMin} onChange={e => set('approvalWaitMin', Number(e.target.value))} className={INPUT_CLASS}>
          {!APPROVAL_WAITS.some(w => w.minutes === draft.approvalWaitMin) && <option value={draft.approvalWaitMin}>{`Wait for my answer in Gazeta, up to ${draft.approvalWaitMin} minutes`}</option>}
          {APPROVAL_WAITS.map(w => (
            <option key={w.minutes} value={w.minutes}>
              {w.label}
            </option>
          ))}
        </select>
      </Field>

      <p className="rounded-button bg-bg px-3 py-2 text-xs text-fg-tertiary">The result of each run lands in Gazeta, and the chat it ran in stays in your list.</p>

      {(error || (missing && (draft.name || draft.prompt))) && (
        <p className="text-xs text-danger" role="alert">
          {error ?? missing}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving || !!problem}>
          {saving ? 'Saving…' : initial ? 'Save' : 'Create'}
        </Button>
      </div>
    </form>
  );
}
