import { Bot, FolderTree, GitBranch, Globe } from 'lucide-react';
import type { DockTool } from '../../App';

/** Desktop-only icon strip on the far right: browser and the tools (agents, files, Git). */
export function RightRail({
  browserOpen,
  onToggleBrowser,
  tools: open,
  onToggleTool,
}: {
  browserOpen: boolean;
  onToggleBrowser: () => void;
  /** Tools currently open in the dock; any number of them can be open at once. */
  tools: DockTool[];
  onToggleTool: (tool: DockTool) => void;
}) {
  const button = (active: boolean, label: string, onClick: () => void, icon: React.ReactNode) => (
    <button
      key={label}
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`flex h-9 w-9 items-center justify-center rounded-button transition-colors ${
        active ? 'bg-bg-secondary text-fg' : 'text-fg-tertiary hover:bg-bg-secondary hover:text-fg'
      }`}
    >
      {icon}
    </button>
  );
  const tools: { id: DockTool; label: string; icon: React.ReactNode }[] = [
    { id: 'agents', label: 'Agents', icon: <Bot size={18} /> },
    { id: 'files', label: 'Files', icon: <FolderTree size={18} /> },
    { id: 'git', label: 'Git', icon: <GitBranch size={18} /> },
  ];
  return (
    <nav className="hidden w-12 shrink-0 flex-col items-center gap-1 border-l border-border bg-bg py-2 md:flex" aria-label="Panels">
      {button(browserOpen, browserOpen ? 'Hide browser' : 'Show browser', onToggleBrowser, <Globe size={18} />)}
      <div className="my-1 h-px w-6 bg-border" />
      {tools.map(t => button(open.includes(t.id), open.includes(t.id) ? `Hide ${t.label}` : t.label, () => onToggleTool(t.id), t.icon))}
    </nav>
  );
}
