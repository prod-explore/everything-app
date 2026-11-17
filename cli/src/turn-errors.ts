import { classifyError, type Incident, type IncidentKind } from './providers/errors.js';
import { EmptyAnswerError, FirstByteTimeoutError } from './llm-loop.js';

/** What can go wrong in a turn: the provider's incidents, plus the two the turn loop itself detects. */
export type TurnIncidentKind = IncidentKind | 'empty_answer' | 'first_byte_timeout';
export type TurnIncident = Omit<Incident, 'kind'> & { kind: TurnIncidentKind };

/** classifyError, aware of the failures that come from the turn loop and not from a provider. */
export function classifyTurnError(err: unknown, redact?: (s: string) => string): TurnIncident {
  if (err instanceof EmptyAnswerError) {
    return { kind: 'empty_answer', message: 'The model returned an empty answer. Retry, or try another model.', transient: true };
  }
  if (err instanceof FirstByteTimeoutError) {
    return { kind: 'first_byte_timeout', message: `The model did not start answering within ${Math.round(err.ms / 1000)} s. Retry, or try another model.`, transient: true };
  }
  return classifyError(err, redact);
}

/** FIRST_BYTE_TIMEOUT_S → ms: unset = 90 s, 0 = off, anything else that is not a positive number = the default. */
export function firstByteTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['FIRST_BYTE_TIMEOUT_S']?.trim();
  if (raw === undefined || raw === '') return 90_000;
  const s = Number(raw);
  if (!Number.isFinite(s) || s < 0) return 90_000;
  return Math.round(s * 1000);
}
