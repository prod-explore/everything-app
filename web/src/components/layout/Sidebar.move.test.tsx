import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ConversationSummary, ProjectListItem } from '../../types';
import { Sidebar } from './Sidebar';

const chat = (over: Partial<ConversationSummary> = {}): ConversationSummary => ({ id: 'c1', title: 'Plan the trip', updatedAt: '2026-10-23 10:00:00', messageCount: 2, projectId: null, ...over });
const project = (over: Partial<ProjectListItem> = {}): ProjectListItem => ({ id: 'p1', name: 'Work', conversationCount: 0, ...over }) as ProjectListItem;

function setup(conversations: ConversationSummary[], projects: ProjectListItem[], view: 'chats' | 'projects' = 'chats', selectedProjectId: string | null = null) {
  const handlers = { onMoveToProject: vi.fn(), onNewProjectFromChat: vi.fn() };
  render(
    <Sidebar
      conversations={conversations}
      projects={projects}
      selectedId={null}
      selectedProjectId={selectedProjectId}
      view={view}
      onViewChange={vi.fn()}
      onSelect={vi.fn()}
      onCreate={vi.fn()}
      onRename={vi.fn()}
      onDelete={vi.fn()}
      onOpenGazeta={vi.fn()}
      onOpenSchedules={vi.fn()}
      onOpenSettings={vi.fn()}
      onCreateProject={vi.fn()}
      onSelectProject={vi.fn()}
      onEditProject={vi.fn()}
      gazetaCount={0}
      {...handlers}
    />,
  );
  return handlers;
}

describe('Sidebar: move a chat to a project', () => {
  it('offers the projects of the user, and moves a quick chat into the one picked', async () => {
    const h = setup([chat()], [project(), project({ id: 'p2', name: 'Home' }), project({ id: 'pg', name: 'Secret', ghost: true } as never)]);
    await userEvent.click(screen.getByRole('button', { name: 'Move Plan the trip to a project' }));
    const menu = screen.getByRole('menu', { name: 'Move to project' });
    expect(within(menu).getAllByRole('menuitem').map(i => i.textContent?.trim())).toEqual(['Work', 'Home', 'New project from this chat']);
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Home' }));
    expect(h.onMoveToProject).toHaveBeenCalledWith('c1', 'p2');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('starts a project from the chat', async () => {
    const h = setup([chat()], []);
    await userEvent.click(screen.getByRole('button', { name: 'Move Plan the trip to a project' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'New project from this chat' }));
    expect(h.onNewProjectFromChat).toHaveBeenCalledWith('c1');
  });

  it('a chat in a project can go to another one or back out, but not "into" its own', async () => {
    const h = setup([chat({ projectId: 'p1' })], [project(), project({ id: 'p2', name: 'Home' })], 'projects', 'p1');
    await userEvent.click(screen.getByRole('button', { name: 'Move Plan the trip to a project' }));
    const menu = screen.getByRole('menu', { name: 'Move to project' });
    expect(within(menu).queryByRole('menuitem', { name: 'Work' })).toBeNull();
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'No project (quick chat)' }));
    expect(h.onMoveToProject).toHaveBeenCalledWith('c1', null);
  });

  it('a ghost chat cannot be moved, so it is not offered', () => {
    setup([chat({ ghost: true })], [project()]);
    expect(screen.queryByRole('button', { name: /to a project/ })).toBeNull();
  });

  it('closes on Escape and on a click elsewhere', async () => {
    setup([chat()], [project()]);
    const open = () => userEvent.click(screen.getByRole('button', { name: 'Move Plan the trip to a project' }));
    await open();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    await open();
    await userEvent.click(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
