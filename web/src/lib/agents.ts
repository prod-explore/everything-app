import type { RunStatus } from '../types';

/** Run states that still count as "active" for a worker agent (the Agents panel's Active list and the button's badge). */
export const ACTIVE_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(['running', 'waiting_input', 'waiting_children']);
