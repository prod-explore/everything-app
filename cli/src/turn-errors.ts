import { classifyError, type Incident, type IncidentKind } from './providers/errors.js';
import { EmptyAnswerError, FirstByteTimeoutError } from './llm-loop.js';

/** "90 s", "10 min": how a limit is named in a sentence. */
function spoken(ms: number): string {
  const s = Math.round(ms / 1000);
  return s >= 120 && s % 60 === 0 ? `${s / 60} min` : `${s} s`;
}

/** What can go wrong in a turn: the provider's incidents, plus the two the turn loop itself detects. */
export type TurnIncidentKind = IncidentKind | 'empty_answer' | 'first_byte_timeout';
export type TurnIncident = Omit<Incident, 'kind'> & { kind: TurnIncidentKind };

/** classifyError, aware of the failures that come from the turn loop and not from a provider. */
export function classifyTurnError(err: unknown, redact?: (s: string) => string): TurnIncident {
  if (err instanceof EmptyAnswerError) {
    return { kind: 'empty_answer', message: 'The model returned an empty answer. Retry, or try another model.', transient: true };
  }
  if (err instanceof FirstByteTimeoutError) {
    const retried = err.attempts > 1 ? ' It was already retried once automatically.' : '';
    const message = err.kind === 'idle'
      ? `The model did not start answering within ${spoken(err.ms)}: nothing arrived, not even a keep-alive.${retried} Retry, or try another model.`
      : `The model kept the connection open but had not started answering after ${spoken(err.ms)}.${retried} Retry, or try another model.`;
    return { kind: 'first_byte_timeout', message, transient: true };
  }
  return classifyError(err, redact);
}

const DEFAULT_IDLE_MS = 90_000;
const DEFAULT_FIRST_CONTENT_MS = 600_000;

/** Seconds from the environment as ms: unset = `fallback`, 0 = off, anything else that is not a non-negative number = `fallback`. */
function secondsEnv(raw: string | undefined, fallback: number): number {
  const text = raw?.trim();
  if (text === undefined || text === '') return fallback;
  const s = Number(text);
  if (!Number.isFinite(s) || s < 0) return fallback;
  return Math.round(s * 1000);
}

/**
 * FIRST_BYTE_TIMEOUT_S → ms: how long a streamed model request may be completely silent before it starts answering (keep-alive
 * comments from a gateway count as sound). Unset = 90 s, 0 = off. With a provider that sends no keep-alives this is the time to the
 * first byte, which is where the name comes from.
 */
export function firstByteTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return secondsEnv(env['FIRST_BYTE_TIMEOUT_S'], DEFAULT_IDLE_MS);
}

/**
 * FIRST_CONTENT_TIMEOUT_S → ms: the hard limit on the time to the first text or reasoning, however many keep-alives arrive.
 * Unset = 10 min, 0 = off.
 */
export function firstContentTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return secondsEnv(env['FIRST_CONTENT_TIMEOUT_S'], DEFAULT_FIRST_CONTENT_MS);
}
