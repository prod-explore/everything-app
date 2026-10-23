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

/** The preset a cron string equals, if any (ignoring extra spaces). */
export function presetFor(cron: string): CronPreset | undefined {
  const norm = cron.trim().replace(/\s+/g, ' ');
  return CRON_PRESETS.find(p => p.cron === norm);
}

/** A readable name for a timetable: the preset's label, else the expression itself. */
export function describeCron(cron: string): string {
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
export function nextLine(s: Pick<Schedule, 'enabled' | 'nextRunAt' | 'timezone'>): string {
  if (!s.enabled) return 'Paused';
  return s.nextRunAt ? `Next: ${formatWhen(s.nextRunAt, s.timezone)}` : 'No upcoming run';
}
