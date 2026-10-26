import type { PendingApproval } from '../../types';

/** What remembering a shell approval covers: every command with these prefixes, not the whole shell. */
export function GrantCoverage({ approval, scopes }: { approval: PendingApproval; scopes: string }) {
  if (!approval.covers?.length) return null;
  return (
    <p className="mb-2 text-xs text-fg-tertiary">
      {scopes} covers{' '}
      {approval.covers.map((p, i) => (
        <span key={p}>
          {i > 0 && (i === approval.covers!.length - 1 ? ' and ' : ', ')}
          all <code className="font-mono text-fg">{p} …</code> commands
        </span>
      ))}
      .{approval.maxScope === 'chat' && ' This command is destructive, so it can be approved once or for this chat only.'}
    </p>
  );
}
