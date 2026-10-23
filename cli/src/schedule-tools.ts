import type Database from 'better-sqlite3';
import type * as Llm from './llm-types.js';
import type { VirtualTool } from './llm-loop.js';
import {
  MAX_WAKE_CHAIN,
  MAX_WAKE_MINUTES,
  ScheduleError,
  WAKE_APPROVAL_WAIT_MIN,
  createSchedule,
  isOnce,
  nextRunAfter,
  normalizeCron,
} from './schedules.js';

/**
 * What the agent can do about time in an ordinary chat, on the same engine as the Scheduled tasks window:
 *  - schedule_wakeup — wake itself up later, once, in THIS chat (no approval: it only continues what is already going on);
 *  - create_scheduled_task — a task of its own (repeating or one-time, a fresh chat each time), which the user has to approve.
 */

export const SCHEDULE_WAKEUP_TOOL: Llm.Tool = {
  name: 'schedule_wakeup',
  description:
    'Wake yourself up later in THIS chat, once, with a prompt — to check on something or to come back to the work after waiting. ' +
    'No approval needed. When it fires you get the prompt as a new message and can use your tools; the user does not have to be there. ' +
    'Give "minutes" (1-20160) or "at" (a date and time: 2026-10-24T08:30 in the user\'s time zone, or with an offset/Z). ' +
    'Write the prompt so it stands on its own: what to check and what to do about it. At most 5 are waiting per chat.',
  input_schema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'What you will be told when you wake up.' },
      minutes: { type: 'integer', description: 'Wake up in this many minutes.' },
      at: { type: 'string', description: 'Or wake up at this moment (ISO 8601).' },
    },
    required: ['prompt'],
  },
};

export const CREATE_SCHEDULED_TASK_TOOL: Llm.Tool = {
  name: 'create_scheduled_task',
  description:
    'Create a scheduled task: a prompt that runs by itself in a fresh chat (free models only) and posts its result to the user\'s Gazeta. ' +
    'The user must approve it. Use "cron" (five fields, at most every 15 minutes) for a repeating task or "at" (2026-10-24T08:30) for a single time; ' +
    '"max_runs" stops a repeating one after that many runs. The prompt has to stand on its own: it runs without this conversation. ' +
    'To come back to THIS chat instead, use schedule_wakeup.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Short name, shown in the task list.' },
      prompt: { type: 'string', description: 'The complete task.' },
      cron: { type: 'string', description: 'Five fields, e.g. "30 8 * * 1-5".' },
      at: { type: 'string', description: 'A single moment, e.g. 2026-10-24T08:30.' },
      timezone: { type: 'string', description: 'IANA name; the default is the user\'s.' },
      max_runs: { type: 'integer', description: 'Stop after this many runs.' },
    },
    required: ['name', 'prompt'],
  },
};

export interface ScheduleToolDeps {
  db: Database.Database;
  convId: string;
  projectId: string | null;
  /** The user's time zone (an IANA name). */
  timezone: string;
  /** Set when this turn is itself a wake-up: how many wake-ups in a row led here. */
  wakeChain?: number;
  onChange: (scheduleId: string) => void;
  now?: () => Date;
}

/** The line that tells the model the date (it has no clock) and what the two tools are for. */
export function schedulingPrompt(now: Date, timezone: string, wakeOnly = false): string {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = (t: string) => day.find(p => p.type === t)?.value ?? '';
  return (
    `Today is ${part('weekday')} ${part('year')}-${part('month')}-${part('day')} (time zone ${timezone}). ` +
    (wakeOnly
      ? 'To look at something again later, use schedule_wakeup.'
      : 'To come back later yourself, use schedule_wakeup (once, in this chat, no approval); for a repeating or separate job use create_scheduled_task (the user approves it).')
  );
}

const fail = (text: string) => ({ text, isError: true as const });

const OFFSET_RE = /(Z|[+-]\d{2}:?\d{2})$/i;

function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** A moment as the schedule engine stores it: local text in a zone. An absolute instant is kept as UTC. */
type When = { cron: string; timezone: string };

const utcWhen = (d: Date): When => ({ cron: d.toISOString().slice(0, 19), timezone: 'UTC' });

/** "In N minutes", or "at …" — with or without an offset. Returns a sentence for the model when it makes no sense. */
function resolveMoment(input: Record<string, unknown>, tz: string, now: Date): When | string {
  const minutes = input['minutes'];
  const at = typeof input['at'] === 'string' ? input['at'].trim() : '';
  if (minutes !== undefined && at) return 'Give either "minutes" or "at", not both.';
  if (minutes !== undefined) {
    if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > MAX_WAKE_MINUTES) {
      return `"minutes" must be a whole number from 1 to ${MAX_WAKE_MINUTES}.`;
    }
    return utcWhen(new Date(now.getTime() + minutes * 60_000));
  }
  if (!at) return 'Say when: "minutes" or "at".';
  if (OFFSET_RE.test(at)) {
    const t = Date.parse(at);
    if (Number.isNaN(t)) return `"${at}" is not a date and time (use 2026-10-24T08:30, or with an offset: 2026-10-24T08:30+02:00).`;
    return utcWhen(new Date(t));
  }
  if (!isOnce(at)) return `"${at}" is not a date and time (use 2026-10-24T08:30, or with an offset: 2026-10-24T08:30+02:00).`;
  return { cron: normalizeCron(at), timezone: tz };
}

const clock = (d: Date, tz: string): string =>
  new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d);

function inWords(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 90) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ${min % 60} min`;
  return `${Math.round(h / 24)} days`;
}

export function wakeupTool(deps: ScheduleToolDeps): VirtualTool {
  const now = () => deps.now?.() ?? new Date();
  return {
    definition: SCHEDULE_WAKEUP_TOOL,
    handler: async input => {
      const prompt = typeof input['prompt'] === 'string' ? input['prompt'].trim() : '';
      if (!prompt) return fail('schedule_wakeup needs a "prompt": what you will be told when you wake up.');
      const chain = (deps.wakeChain ?? 0) + 1;
      if (chain > MAX_WAKE_CHAIN) {
        return fail(`You have woken yourself ${MAX_WAKE_CHAIN} times in a row without a message from the user. Stop here: say what is still open (post_report, or your answer) and let the user decide.`);
      }
      const t = now();
      const when = resolveMoment(input, deps.timezone, t);
      if (typeof when === 'string') return fail(when);
      const at = nextRunAfter(when.cron, when.timezone, t);
      if (!at) return fail(`That moment has already passed. Now it is ${clock(t, deps.timezone)} (${deps.timezone}).`);
      if (at.getTime() - t.getTime() > MAX_WAKE_MINUTES * 60_000) return fail(`That is too far away: a wake-up can be at most ${MAX_WAKE_MINUTES / 1440} days ahead. Use create_scheduled_task for a later date.`);
      try {
        const s = createSchedule(deps.db, {
          name: `Wake-up: ${prompt.replace(/\s+/g, ' ').slice(0, 60)}`,
          prompt,
          cron: when.cron,
          timezone: when.timezone,
          projectId: deps.projectId,
          allowPaid: true, // it continues a chat the user already runs on a model of their choice
          approvalWaitMin: WAKE_APPROVAL_WAIT_MIN,
          conversationId: deps.convId,
          chain,
        }, t);
        deps.onChange(s.id);
      } catch (err) {
        if (err instanceof ScheduleError) return fail(err.message);
        throw err;
      }
      return { text: `Wake-up set for ${clock(at, deps.timezone)} (${deps.timezone}), in ${inWords(at.getTime() - t.getTime())}. You will get this chat back with: "${prompt.slice(0, 200)}". Nothing else is needed now; finish your answer.` };
    },
  };
}

export function createTaskTool(deps: ScheduleToolDeps): VirtualTool {
  const now = () => deps.now?.() ?? new Date();
  return {
    definition: CREATE_SCHEDULED_TASK_TOOL,
    requiresApproval: true,
    handler: async input => {
      const name = typeof input['name'] === 'string' ? input['name'].trim() : '';
      const prompt = typeof input['prompt'] === 'string' ? input['prompt'].trim() : '';
      if (!name || !prompt) return fail('create_scheduled_task needs a "name" and a "prompt".');
      const cron = typeof input['cron'] === 'string' ? input['cron'].trim() : '';
      const at = typeof input['at'] === 'string' ? input['at'].trim() : '';
      if (!!cron === !!at) return fail('Give either "cron" (a repeating task) or "at" (a single time), not both and not neither.');
      const tzIn = typeof input['timezone'] === 'string' ? input['timezone'].trim() : '';
      if (tzIn && !validZone(tzIn)) return fail(`"${tzIn}" is not a time zone (use a name such as Europe/Warsaw).`);
      const tz = tzIn || deps.timezone;
      const t = now();
      let when: When;
      if (cron) when = { cron, timezone: tz };
      else {
        const w = resolveMoment({ at }, tz, t);
        if (typeof w === 'string') return fail(w);
        when = w;
      }
      const maxRuns = input['max_runs'] === undefined ? null : input['max_runs'];
      try {
        const s = createSchedule(deps.db, {
          name, prompt, cron: when.cron, timezone: when.timezone, projectId: deps.projectId, allowPaid: false, maxRuns: maxRuns as number | null, approvalWaitMin: 0,
        }, t);
        deps.onChange(s.id);
        const next = s.nextRunAt ? new Date(s.nextRunAt) : null;
        return {
          text: `Created the scheduled task "${s.name}". ${next ? `Next run: ${clock(next, tz)} (${tz}), in ${inWords(next.getTime() - t.getTime())}.` : ''} ` +
            'It runs in a fresh chat on free models and posts its result to Gazeta; the user can change or delete it under "Scheduled tasks".',
        };
      } catch (err) {
        if (err instanceof ScheduleError) return fail(`${err.message} (Now it is ${clock(t, tz)} in ${tz}.)`);
        throw err;
      }
    },
  };
}
