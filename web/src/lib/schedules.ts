import type { Schedule, ScheduleRun } from '../types';

export interface CronPreset {
  label: string;
  cron: string;
}

/** The common timetables, so that nobody has to write cron for "every morning". */
export const CRON_PRESETS: CronPreset[] = [
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every day, 08:00', cron: '0 8 * * *' },
  { label: 'Weekdays, 08:00', cron: '0 8 * * 1-5' },
  { label: 'Every Monday, 09:00', cron: '0 9 * * 1' },
  { label: 'First of the month, 09:00', cron: '0 9 1 * *' },
];

/** A one-time schedule is a local date and time ("2026-10-24T08:30:00"), read in the schedule's time zone. */
export function isOnceCron(cron: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(cron.trim());
}

/** The value of a datetime-local input (no seconds) for a one-time schedule. */
export function onceInputValue(cron: string): string {
  return cron.trim().slice(0, 16);
}

/** Tomorrow 09:00 in the viewer's own clock, as a datetime-local value — a sensible starting point for "once". */
export function defaultOnce(now: Date = new Date()): string {
  const d = new Date(now.getTime() + 24 * 3600_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T09:00`;
}

/** How long a run may wait for an answer in Gazeta, as the form offers it. */
export const APPROVAL_WAITS: Array<{ minutes: number; label: string }> = [
  { minutes: 0, label: 'Go on without it (the request waits in Gazeta for next time)' },
  { minutes: 15, label: 'Wait for my answer in Gazeta, up to 15 minutes' },
  { minutes: 30, label: 'Wait for my answer in Gazeta, up to 30 minutes' },
  { minutes: 60, label: 'Wait for my answer in Gazeta, up to 1 hour' },
  { minutes: 120, label: 'Wait for my answer in Gazeta, up to 2 hours' },
  { minutes: 360, label: 'Wait for my answer in Gazeta, up to 6 hours' },
  { minutes: 720, label: 'Wait for my answer in Gazeta, up to 12 hours' },
];

/** The preset a cron string equals, if any (ignoring extra spaces). */
export function presetFor(cron: string): CronPreset | undefined {
  const norm = cron.trim().replace(/\s+/g, ' ');
  return CRON_PRESETS.find(p => p.cron === norm);
}

/** A readable name for a timetable: the preset's label, else the expression itself. */
export function describeCron(cron: string): string {
  if (isOnceCron(cron)) return `Once, ${onceInputValue(cron).replace('T', ' ')}`;
  const alias: Record<string, string> = { '@hourly': 'Every hour', '@daily': 'Every day, 00:00', '@midnight': 'Every day, 00:00', '@weekly': 'Every Sunday, 00:00', '@monthly': 'First of the month, 00:00' };
  return alias[cron.trim()] ?? presetFor(cron)?.label ?? cron;
}

/** The browser's own time zone, falling back to UTC where it cannot say. */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** A few zone names for the picker: the viewer's own first, then the usual ones, without duplicates. */
export function timeZoneChoices(current?: string): string[] {
  const list = [current, localTimeZone(), 'UTC', 'Europe/Warsaw', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo'];
  return [...new Set(list.filter((z): z is string => !!z))];
}

/** An ISO time in a zone ("Mon 24 Oct, 08:00"); the raw text when it cannot be read. */
export function formatWhen(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return d.toLocaleString(undefined, { timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch {
    return d.toLocaleString();
  }
}

export const RUN_STATUS_LABEL: Record<ScheduleRun['status'], string> = {
  running: 'Running',
  done: 'Done',
  error: 'Failed',
  skipped: 'Skipped',
};

export const TRIGGER_LABEL: Record<ScheduleRun['trigger'], string> = {
  schedule: 'on schedule',
  catchup: 'late (the app was off)',
  manual: 'started by you',
};

/** One short line for the list: when it runs next, or why it does not. */
export function nextLine(s: Pick<Schedule, 'enabled' | 'nextRunAt' | 'timezone'> & Partial<Pick<Schedule, 'finished' | 'maxRuns' | 'runCount' | 'cron'>>): string {
  if (!s.enabled) return 'Paused';
  if (s.finished) {
    return s.cron && isOnceCron(s.cron) ? 'Finished — it ran once' : `Finished — ${s.runCount ?? 0} of ${s.maxRuns ?? 0} runs done`;
  }
  const next = s.nextRunAt ? `Next: ${formatWhen(s.nextRunAt, s.timezone)}` : 'No upcoming run';
  return s.maxRuns ? `${next} · run ${Math.min((s.runCount ?? 0) + 1, s.maxRuns)} of ${s.maxRuns}` : next;
}
