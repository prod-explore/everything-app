import { useCallback, useEffect, useRef, useState } from 'react';
import { AlarmClock, History, MessageSquare, Pause, Pencil, Play, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { createSchedule, deleteSchedule, listScheduleRuns, listSchedules, runScheduleNow, updateSchedule } from '../../api';
import { useModels } from '../../hooks/useModels';
import { RUN_STATUS_LABEL, TRIGGER_LABEL, describeCron, formatWhen, nextLine } from '../../lib/schedules';
import type { ProjectListItem, Schedule, ScheduleInput, ScheduleRun } from '../../types';
import { Button } from '../shared/Button';
import { EmptyState } from '../shared/EmptyState';
import { Modal } from '../shared/Modal';
import { ScheduleForm } from './ScheduleForm';

/** Re-read while open: the live event only reaches a client that has a chat open. */
const POLL_MS = 15_000;

const STATUS_CLASS: Record<ScheduleRun['status'], string> = {
  running: 'text-accent',
  done: 'text-fg-secondary',
  error: 'text-danger',
  skipped: 'text-fg-tertiary',
};

function RunLine({ run, timeZone, onOpenConversation }: { run: ScheduleRun; timeZone: string; onOpenConversation?: (id: string) => void }) {
  const detail = run.error ?? run.summary;
  return (
    <li className="flex items-start gap-2 py-1.5 text-xs">
      <span className={`w-14 shrink-0 font-medium ${STATUS_CLASS[run.status]}`}>{RUN_STATUS_LABEL[run.status]}</span>
      <span className="min-w-0 flex-1">
        <span className="text-fg-secondary">{formatWhen(run.startedAt, timeZone)}</span>
        <span className="text-fg-tertiary"> · {TRIGGER_LABEL[run.trigger]}</span>
        {detail && <span className={`mt-0.5 block whitespace-pre-wrap break-words ${run.error ? 'text-danger' : 'text-fg-tertiary'}`}>{detail}</span>}
      </span>
      {run.conversationId && onOpenConversation && (
        <button
          onClick={() => onOpenConversation(run.conversationId!)}
          className="flex shrink-0 items-center gap-1 rounded-button px-2 py-1 text-fg-tertiary hover:bg-bg-tertiary hover:text-fg"
          aria-label="Open the chat of this run"
          title="Open the chat of this run"
        >
          <MessageSquare size={13} /> Chat
        </button>
      )}
    </li>
  );
}

function ScheduleRow({
  schedule,
  projectName,
  historyOpen,
  runs,
  busy,
  onToggleHistory,
  onToggleEnabled,
  onRunNow,
  onEdit,
  onDelete,
  onOpenConversation,
}: {
  schedule: Schedule;
  projectName?: string;
  historyOpen: boolean;
  runs: ScheduleRun[] | undefined;
  busy: boolean;
  onToggleHistory: () => void;
  onToggleEnabled: () => void;
  onRunNow: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onOpenConversation?: (id: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const last = schedule.lastRun;
  const running = last?.status === 'running';
  // A wake-up is the assistant's own alarm in a chat: it has no history of its own, nothing to edit or run by hand.
  const wake = schedule.conversationId !== null;
  const zone = wake ? Intl.DateTimeFormat().resolvedOptions().timeZone : schedule.timezone;
  const btn = 'rounded-full p-1.5 text-fg-tertiary hover:bg-bg-tertiary hover:text-fg disabled:opacity-40';
  return (
    <li className="rounded-container border border-border bg-bg p-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className={`truncate text-sm font-medium ${schedule.enabled ? 'text-fg' : 'text-fg-tertiary'}`}>{schedule.name}</p>
          <p className="mt-0.5 text-xs text-fg-secondary">
            {wake ? (
              'The assistant will continue this chat'
            ) : (
              <>
                {describeCron(schedule.cron)} <span className="text-fg-tertiary">· {schedule.timezone}</span>
              </>
            )}
          </p>
          <p className="mt-0.5 text-xs text-fg-tertiary">
            {nextLine({ ...schedule, timezone: zone })}
            {projectName && <> · {projectName}</>}
            {schedule.allowPaid && <> · paid models allowed</>}
            {schedule.approvalWaitMin > 0 && <> · waits up to {schedule.approvalWaitMin} min for approvals</>}
          </p>
          {last && (
            <p className={`mt-0.5 text-xs ${STATUS_CLASS[last.status]}`}>
              Last: {RUN_STATUS_LABEL[last.status].toLowerCase()}, {formatWhen(last.startedAt, schedule.timezone)}
              {last.error && <span className="text-danger"> — {last.error.length > 90 ? `${last.error.slice(0, 90)}…` : last.error}</span>}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center">
          {wake && onOpenConversation && (
            <button onClick={() => onOpenConversation(schedule.conversationId!)} className={btn} aria-label={`Open the chat of ${schedule.name}`} title="Open the chat">
              <MessageSquare size={15} />
            </button>
          )}
          {!wake && (
            <button onClick={onRunNow} disabled={busy || running} className={btn} aria-label={`Run ${schedule.name} now`} title={running ? 'Running now' : 'Run now'}>
              <Play size={15} />
            </button>
          )}
          <button onClick={onToggleEnabled} disabled={busy} className={btn} aria-label={schedule.enabled ? `Pause ${schedule.name}` : `Resume ${schedule.name}`} title={schedule.enabled ? 'Pause' : 'Resume'}>
            {schedule.enabled ? <Pause size={15} /> : <RefreshCw size={15} />}
          </button>
          {!wake && (
            <>
              <button onClick={onToggleHistory} className={`${btn} ${historyOpen ? 'text-fg' : ''}`} aria-label={`History of ${schedule.name}`} aria-expanded={historyOpen} title="History">
                <History size={15} />
              </button>
              <button onClick={onEdit} disabled={busy} className={btn} aria-label={`Edit ${schedule.name}`} title="Edit">
                <Pencil size={15} />
              </button>
            </>
          )}
          <button onClick={() => setConfirming(true)} disabled={busy} className={btn} aria-label={`${wake ? 'Cancel' : 'Delete'} ${schedule.name}`} title={wake ? 'Cancel' : 'Delete'}>
            <Trash2 size={15} />
          </button>
        </div>
      </div>
      {confirming && (
        <div className="mt-2 flex items-center justify-end gap-2 text-xs text-fg-secondary" role="alert">
          {wake ? 'Cancel this wake-up? The chat stays as it is.' : 'Delete this task and its history? The chats it started stay.'}
          <Button variant="danger" className="!px-3 !py-1 text-xs" onClick={onDelete}>
            {wake ? 'Cancel wake-up' : 'Delete'}
          </Button>
          <Button variant="ghost" className="!px-3 !py-1 text-xs" onClick={() => setConfirming(false)}>
            Keep
          </Button>
        </div>
      )}
      {historyOpen && (
        <div className="mt-2 border-t border-border pt-1">
          {runs === undefined ? (
            <p className="py-2 text-xs text-fg-tertiary">Loading…</p>
          ) : runs.length === 0 ? (
            <p className="py-2 text-xs text-fg-tertiary">It has not run yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {runs.map(r => (
                <RunLine key={r.id} run={r} timeZone={schedule.timezone} onOpenConversation={onOpenConversation} />
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

export function SchedulesView({
  onClose,
  onOpenConversation,
  projects,
  refreshKey = 0,
}: {
  onClose: () => void;
  onOpenConversation?: (conversationId: string) => void;
  projects: ProjectListItem[];
  /** Bumped when the server says a schedule changed. */
  refreshKey?: number;
}) {
  const { models } = useModels();
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [runs, setRuns] = useState<Record<string, ScheduleRun[]>>({});
  const [openHistory, setOpenHistory] = useState<string | null>(null);
  const [editing, setEditing] = useState<Schedule | 'new' | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // The effect below must re-read when the server says something changed, not every time a history is opened.
  const openHistoryRef = useRef<string | null>(null);
  useEffect(() => {
    openHistoryRef.current = openHistory;
  }, [openHistory]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { schedules: list } = await listSchedules();
      setSchedules(list);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadRuns = useCallback(async (id: string) => {
    try {
      const { runs: list } = await listScheduleRuns(id);
      setRuns(prev => ({ ...prev, [id]: list }));
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    if (openHistoryRef.current) void loadRuns(openHistoryRef.current);
  }, [load, loadRuns, refreshKey]);

  useEffect(() => {
    if (editing) return;
    const timer = setInterval(() => {
      void load();
      if (openHistory) void loadRuns(openHistory);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [editing, load, loadRuns, openHistory]);

  async function act(id: string, fn: () => Promise<unknown>) {
    setBusyId(id);
    setError(null);
    try {
      await fn();
      await load();
      if (openHistory === id) await loadRuns(id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  function toggleHistory(id: string) {
    if (openHistory === id) { setOpenHistory(null); return; }
    setOpenHistory(id);
    void loadRuns(id);
  }

  async function save(input: ScheduleInput) {
    if (editing && editing !== 'new') await updateSchedule(editing.id, input);
    else await createSchedule(input);
    setEditing(null);
    await load();
  }

  const projectNames = new Map(projects.map(p => [p.id, p.name]));
  const open = onOpenConversation
    ? (id: string) => {
        onOpenConversation(id);
        onClose();
      }
    : undefined;

  return (
    <Modal
      title={editing ? (editing === 'new' ? 'New scheduled task' : 'Edit scheduled task') : 'Scheduled tasks'}
      onClose={onClose}
      wide
      headerExtra={
        !editing && (
          <button
            onClick={() => void load()}
            disabled={loading}
            className="rounded-full p-1 text-fg-secondary hover:bg-bg-tertiary hover:text-fg disabled:opacity-40"
            aria-label="Refresh"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </button>
        )
      }
    >
      {editing ? (
        <ScheduleForm initial={editing === 'new' ? undefined : editing} models={models} projects={projects} onSave={save} onCancel={() => setEditing(null)} />
      ) : (
        <>
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="text-xs text-fg-tertiary">An agent that runs on a timetable and leaves its result in Gazeta — no chat left open.</p>
            <Button className="flex shrink-0 items-center gap-1 !px-3 !py-1.5 text-xs" onClick={() => setEditing('new')}>
              <Plus size={14} /> New task
            </Button>
          </div>
          {error && (
            <p className="mb-3 text-xs text-danger" role="alert">
              {error}
            </p>
          )}
          {schedules === null ? (
            <p className="py-6 text-center text-xs text-fg-tertiary">Loading…</p>
          ) : schedules.length === 0 ? (
            <EmptyState icon={AlarmClock} message="Nothing scheduled. Add a task, for example “every morning, look for new job offers”." />
          ) : (
            <ul className="space-y-3">
              {schedules.map(s => (
                <ScheduleRow
                  key={s.id}
                  schedule={s}
                  projectName={s.projectId ? projectNames.get(s.projectId) : undefined}
                  historyOpen={openHistory === s.id}
                  runs={runs[s.id]}
                  busy={busyId === s.id}
                  onToggleHistory={() => toggleHistory(s.id)}
                  onToggleEnabled={() => void act(s.id, () => updateSchedule(s.id, { enabled: !s.enabled }))}
                  onRunNow={() => void act(s.id, () => runScheduleNow(s.id))}
                  onEdit={() => setEditing(s)}
                  onDelete={() => void act(s.id, () => deleteSchedule(s.id))}
                  onOpenConversation={open}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </Modal>
  );
}
