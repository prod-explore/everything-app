import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  findMatchingGrant,
  createApprovalGrant,
  deleteApprovalGrant,
  listApprovalGrants,
  logApprovalAudit,
  getProject,
  type ApprovalGrantRow,
} from './db.js';
import {
  evaluateCommand,
  extractCommand,
  parseCommandPolicy,
  commandGrantLabel,
  grantable,
  type SubcommandVerdict,
} from './command-policy.js';
import { mergeCommandPolicy, type PolicyStore } from './policy-file.js';

/**
 * The approval gate. For every tool call that needs one it decides whether the call runs: by policy (the command
 * policy and policy.json), by a standing grant, or by asking a person (the card in the chat and in Gazeta). Every
 * decision is written to the approval audit log.
 */

/**
 * Patterns that look potentially irreversible/destructive. This is a UI
 * hint, not a security boundary (the real boundary is that the call needs
 * a human "y" at all — enforcement lives outside the model, not in string matching that a
 * determined prompt injection could word around). Deliberately simple and
 * a bit over-eager: false positives just mean an extra warning banner on a
 * safe command, false negatives mean no warning on a genuinely risky one —
 * the asymmetry favors warning too often.
 */
const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+(-\w*r\w*f\w*|-\w*f\w*r\w*)\b/i, // rm -rf, -fr, -Rf, etc.
  /\bgit\s+push\b.*(--force|-f\b)/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bDROP\s+(TABLE|DATABASE)\b/i,
  /\bTRUNCATE\s+TABLE\b/i,
  /:\(\)\s*\{\s*:\s*\|\s*:.*\}\s*;\s*:/, // classic shell fork-bomb shape
  // Browser-agent actions — matched against browser_act's required `label` field,
  // which is copied from the page's own visible element text, not written by the model.
  // Same "over-eager on purpose" tradeoff as the patterns above: a false positive is an
  // extra approval prompt, a false negative is an unreviewed destructive click.
  /\b(delete|remove|close|deactivate|cancel)\s+(my\s+)?(account|subscription|membership)\b/i,
  /\b(place|confirm|submit)\s+(the\s+)?order\b/i,
  /\b(buy|purchase)\s+now\b/i,
  /\b(complete|confirm|authorize)\s+payment\b/i,
  /\bpay\s+now\b/i,
  /\bwire\s+transfer\b/i,
  /\bunsubscribe\b/i,
  /\bsend\s+money\b/i,
  /\bdelete\s+(this\s+)?(post|repo|repository|project|file)\b/i,
];

export function looksDangerous(args: Record<string, unknown>): boolean {
  const text = JSON.stringify(args);
  return DANGEROUS_PATTERNS.some(pattern => pattern.test(text));
}

/**
 * How broadly a single approval grants future auto-approval:
 * - 'once'   — this specific call only, always re-prompts next time
 * - 'chat'   — auto-approve this tool for the rest of this conversation
 * - 'project' — auto-approve this tool across all chats for a specific project
 * - 'always' — auto-approve this tool globally (until revoked)
 *
 * Note: dangerous calls are always forced to 'once' regardless of what the
 * client sends — granting 'always' for a tool never covers destructive variants
 * of that tool. Destructive shell commands (rm, git reset, git push, kill…) are
 * capped at 'chat', and only a chat grant covers them.
 */
export type ApprovalScope = 'once' | 'chat' | 'project' | 'always';

export interface PendingApproval {
  id: string;
  conversationId: string;
  toolLabel: string;
  args: Record<string, unknown>;
  dangerous: boolean;
  createdAt: string;
  timeoutMs?: number; // undefined = no timeout
  /** Shell tools: the per-sub-command verdicts (what the card shows, and which prefixes a non-once approval grants). */
  commands?: SubcommandVerdict[];
  /** Shell tools: the command prefixes a "for this chat" / "always" approval covers (`git commit` = every `git commit …`). */
  covers?: string[];
  /** 'chat' when a sub-command is destructive: the approval can be remembered for this chat at most. */
  maxScope?: 'chat';
  /** Why this call must be approved by hand even though a grant/policy might cover it. */
  warning?: string;
  projectId?: string;
  /** Who is waiting for this and for how long, when it is not a person at the keyboard (a scheduled run). */
  note?: string;
  /** A scheduled run that did not wait: the call was refused at once, the card stays so "Always" can still help the next run. */
  late?: boolean;
}

export interface ApprovalDecision {
  approved: boolean;
  /** Set when the policy (not a human) refused — shown to the model so it doesn't retry blindly. */
  reason?: string;
}

type ConfirmCtx = {
  projectId?: string; modelId?: string; skillId?: string; timeoutSeconds?: number;
  /** Always prompt (once only), with this warning — e.g. after a suspected prompt injection. */
  forcePrompt?: string;
  /** Nobody is at the keyboard (a scheduled run). The request is the same card as in a chat — it shows up in Gazeta. */
  unattended?: boolean;
  /** Unattended only: how long the run waits for an answer. 0 (or nothing) = refuse at once and carry on. */
  unattendedWaitSeconds?: number;
  /** Unattended only: whose run this is (the schedule's name), for the card. */
  origin?: string;
};

/** Requests of runs that did not wait stay in the list this long, and at most this many. */
const LATE_TTL_MS = 7 * 24 * 3600 * 1000;
const LATE_MAX = 50;

export class WebApprovalGate {
  private readonly db: Database.Database;
  // In-memory only: per-turn skill grants (grantChatScope). Persistent grants live in the DB and are
  // looked up on every confirm() so revocation and model/skill scoping take effect immediately.
  private readonly chatAllowed = new Map<string, Set<string>>();
  private readonly pending = new Map<string, { entry: PendingApproval; resolve: (approved: boolean) => void; timer?: ReturnType<typeof setTimeout> }>();

  /** Called when a call starts waiting for a human (not for grants/policy decisions). Must not throw. */
  onPending?: (entry: PendingApproval) => void;

  constructor(db: Database.Database, private readonly policyFile?: PolicyStore) {
    this.db = db;
  }

  isPending(id: string): boolean {
    return this.pending.has(id);
  }

  async confirm(
    conversationId: string,
    toolLabel: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    ctx?: ConfirmCtx,
  ): Promise<boolean> {
    return (await this.confirmDetailed(conversationId, toolLabel, args, signal, ctx)).approved;
  }

  async confirmDetailed(
    conversationId: string,
    toolLabel: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    ctx?: ConfirmCtx,
  ): Promise<ApprovalDecision> {
    if (signal?.aborted) return { approved: false };
    const dangerous = looksDangerous(args) || !!ctx?.forcePrompt;
    const grantCtx = { conversationId, projectId: ctx?.projectId, modelId: ctx?.modelId, skillId: ctx?.skillId };
    const audit = (action: string) => logApprovalAudit(this.db, { action, toolLabel, toolArgs: JSON.stringify(args), conversationId });

    // Shell commands: classified per sub-command by the project's command policy.
    // A tool-level grant on run_bash deliberately does NOT apply here: it would approve any command the tool can run.
    const command = extractCommand(toolLabel, args);
    let commands: SubcommandVerdict[] | undefined;
    if (command !== null) {
      const project = ctx?.projectId ? getProject(this.db, ctx.projectId) : null;
      const projectRaw = project?.policy?.['commands'];
      const projectPolicy = parseCommandPolicy(projectRaw);
      const projectHasMode = !!projectRaw && typeof projectRaw === 'object' && 'mode' in (projectRaw as object);
      const policy = this.policyFile ? mergeCommandPolicy(this.policyFile.get().commands, projectPolicy, projectHasMode) : projectPolicy;
      const chatSet = this.chatAllowed.get(conversationId);
      const verdict = evaluateCommand(command, policy, (prefix, { chatOnly }) =>
        !!chatSet?.has(commandGrantLabel(prefix)) ||
        !!findMatchingGrant(this.db, commandGrantLabel(prefix), chatOnly ? { ...grantCtx, scopes: ['chat'] } : grantCtx));
      if (verdict.decision === 'deny') {
        audit('policy_denied');
        const blocked = verdict.subcommands.filter(s => s.decision === 'deny').map(s => s.command);
        return { approved: false, reason: `blocked by the project command policy: ${blocked.join('; ')}` };
      }
      if (verdict.decision === 'allow' && !dangerous) {
        audit('auto_approved');
        return { approved: true };
      }
      commands = verdict.subcommands;
    } else if (!dangerous) {
      const chatSet = this.chatAllowed.get(conversationId);
      if (chatSet?.has(toolLabel)) return { approved: true };
      if (findMatchingGrant(this.db, toolLabel, grantCtx)) {
        audit('auto_approved');
        return { approved: true };
      }
    }

    const id = randomUUID();
    const unattended = ctx?.unattended === true;
    const waitSeconds = unattended ? Math.max(0, ctx?.unattendedWaitSeconds ?? 0) : 0;
    const timeoutMs = unattended ? (waitSeconds > 0 ? waitSeconds * 1000 : undefined) : ctx?.timeoutSeconds ? ctx.timeoutSeconds * 1000 : undefined;
    const entry: PendingApproval = {
      id, conversationId, projectId: ctx?.projectId, toolLabel, args, dangerous, createdAt: new Date().toISOString(), timeoutMs, commands, warning: ctx?.forcePrompt,
    };
    if (commands) {
      if (!dangerous) entry.covers = this.grantLabels(entry).map(l => l.slice(commandGrantLabel('').length));
      if (commands.some(c => c.decision === 'ask' && c.destructive)) entry.maxScope = 'chat';
    }
    const who = ctx?.origin ? `Scheduled task "${ctx.origin}"` : 'A scheduled run';

    if (unattended && waitSeconds === 0) {
      // Nobody is there and the run does not wait: refuse now, but leave the request in the list (Gazeta) so "Always" can still help the next run.
      audit('unattended_denied');
      this.leaveForLater({
        ...entry,
        late: true,
        note: entry.maxScope === 'chat'
          ? `${who} did not wait for this and went on without it. It is destructive, so it can only be approved while a run waits for it.`
          : `${who} did not wait for this and went on without it. Choose "Always" to let it do this on its next runs.`,
      });
      return {
        approved: false,
        reason: 'this scheduled run does not wait for approvals, so the call was refused (the request is in the user\'s Gazeta for next time). Carry on without it and say in your final answer what you could not do',
      };
    }
    if (unattended) entry.note = `${who} is paused on this call. If nobody answers within ${Math.round(waitSeconds / 60)} min, it goes on without it.`;

    return new Promise<ApprovalDecision>(resolve => {
      const onAbort = () => settle(false);
      let timer: ReturnType<typeof setTimeout> | undefined;

      const settle = (approved: boolean, reason?: string) => {
        signal?.removeEventListener('abort', onAbort);
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        logApprovalAudit(this.db, {
          action: approved ? 'granted' : 'denied',
          toolLabel,
          toolArgs: JSON.stringify(args),
          conversationId,
        });
        resolve({ approved, ...(reason ? { reason } : {}) });
      };

      if (timeoutMs) {
        timer = setTimeout(
          () => settle(false, unattended ? `nobody answered within ${Math.round(timeoutMs / 60000)} min. Carry on without this call and say in your final answer what you could not do` : undefined),
          timeoutMs,
        );
      }
      this.pending.set(id, { entry, resolve: settle, timer });
      signal?.addEventListener('abort', onAbort, { once: true });
      try { this.onPending?.(entry); } catch { /* a notification problem never blocks the approval */ }
    });
  }

  /** A request of a run that has already gone on: it waits in the list for "Always", then drops out (or after a week). */
  private leaveForLater(entry: PendingApproval): void {
    const late = [...this.pending.values()].filter(p => p.entry.late);
    while (late.length >= LATE_MAX) {
      const oldest = late.shift()!;
      if (oldest.timer) clearTimeout(oldest.timer);
      this.pending.delete(oldest.entry.id);
    }
    const drop = () => { this.pending.delete(entry.id); };
    const timer = setTimeout(drop, LATE_TTL_MS);
    timer.unref?.();
    this.pending.set(entry.id, {
      entry,
      timer,
      resolve: approved => {
        clearTimeout(timer);
        drop();
        logApprovalAudit(this.db, { action: approved ? 'granted' : 'denied', toolLabel: entry.toolLabel, toolArgs: JSON.stringify(entry.args), conversationId: entry.conversationId });
      },
    });
    try { this.onPending?.(entry); } catch { /* a notification problem never blocks the approval */ }
  }

  private grantChatScopeInMemory(conversationId: string, toolLabel: string): void {
    let chatSet = this.chatAllowed.get(conversationId);
    if (!chatSet) {
      chatSet = new Set();
      this.chatAllowed.set(conversationId, chatSet);
    }
    chatSet.add(toolLabel);
  }

  grantChatScope(conversationId: string, toolLabel: string): void {
    // In-memory only — skill per-turn grants aren't persisted. They end with the turn: the server calls
    // clearChatScope before granting afresh from the skills attached at that moment, and again when the turn ends.
    this.grantChatScopeInMemory(conversationId, toolLabel);
  }

  /** Drops every per-turn skill grant of this conversation. */
  clearChatScope(conversationId: string): void {
    this.chatAllowed.delete(conversationId);
  }

  listPending(): PendingApproval[] {
    return [...this.pending.values()].map(p => p.entry);
  }

  resolve(
    id: string,
    approved: boolean,
    scope: ApprovalScope = 'once',
    ctx?: { conversationId?: string; projectId?: string; subjectType?: 'model' | 'skill'; subjectId?: string },
  ): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    // A destructive command is remembered for this chat at most, whatever the client sent.
    if (p.entry.maxScope === 'chat' && (scope === 'project' || scope === 'always')) scope = 'chat';
    // The run of a late request is long gone: only a standing grant means anything.
    if (p.entry.late && scope !== 'always') scope = 'once';
    if (approved && !p.entry.dangerous) {
      if (scope !== 'once') {
        const projectId = ctx?.projectId ?? null;
        // A project grant without a project id can never match (findMatchingGrant compares ids),
        // so narrow it to this chat instead of storing a dead row.
        const effective = scope === 'project' && !projectId ? 'chat' : scope;
        // A subject needs both halves; a half-filled one would never match either.
        const scoped = ctx?.subjectType && ctx?.subjectId;
        const labels = this.grantLabels(p.entry);
        for (const toolLabel of labels) createApprovalGrant(this.db, {
          toolLabel,
          scope: effective,
          subjectType: scoped ? ctx.subjectType! : null,
          subjectId: scoped ? ctx.subjectId! : null,
          conversationId: effective === 'chat' ? (ctx?.conversationId ?? p.entry.conversationId) : null,
          projectId: effective === 'project' ? projectId : null,
          expiresAt: null,
        });
      }
    }
    p.resolve(approved);
    return true;
  }

  /** What "allow for good" would cover for this call: the sub-command prefixes the human saw for a shell tool, else the tool itself. A dangerous call is never covered. */
  grantLabels(req: { toolLabel: string; dangerous: boolean; commands?: SubcommandVerdict[] }): string[] {
    if (req.dangerous) return [];
    return req.commands
      ? [...new Set(req.commands.filter(grantable).map(c => commandGrantLabel(c.prefix)))]
      : [req.toolLabel];
  }

  /** Returns all persisted grants (from DB), optionally filtered. */
  listGrants(filter?: { conversationId?: string; projectId?: string; scope?: string }): ApprovalGrantRow[] {
    return listApprovalGrants(this.db, filter);
  }

  /** Revokes a persisted grant by ID. */
  revokeGrant(grantId: string): boolean {
    const deleted = deleteApprovalGrant(this.db, grantId);
    if (deleted) {
      logApprovalAudit(this.db, { grantId, action: 'revoked', toolLabel: '(revoked)' });
    }
    return deleted;
  }
}
