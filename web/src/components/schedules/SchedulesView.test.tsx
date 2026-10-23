import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Schedule, ScheduleRun } from '../../types';

const api = vi.hoisted(() => ({
  listSchedules: vi.fn(),
  listScheduleRuns: vi.fn(),
  previewSchedule: vi.fn(),
  createSchedule: vi.fn(),
  updateSchedule: vi.fn(),
  deleteSchedule: vi.fn(),
  runScheduleNow: vi.fn(),
  getModels: vi.fn(),
}));
vi.mock('../../api', () => api);

import { SchedulesView } from './SchedulesView';

const sched = (over: Partial<Schedule> = {}): Schedule => ({
  id: 's1',
  name: 'Job offers',
  prompt: 'Look for new offers',
  cron: '0 8 * * *',
  timezone: 'UTC',
  model: null,
  projectId: null,
  allowPaid: false,
  enabled: true,
  nextRunAt: '2026-07-02T08:00:00.000Z',
  lastRunAt: '2026-07-01T08:00:00.000Z',
  createdAt: '2026-06-01T00:00:00.000Z',
  lastRun: null,
  ...over,
});

const run = (over: Partial<ScheduleRun> = {}): ScheduleRun => ({
  id: 'r1',
  scheduleId: 's1',
  conversationId: 'c1',
  trigger: 'schedule',
  status: 'done',
  startedAt: '2026-07-01T08:00:00.000Z',
  finishedAt: '2026-07-01T08:02:00.000Z',
  summary: 'Found 3 new offers',
  error: null,
  ...over,
});

const open = (props: Partial<React.ComponentProps<typeof SchedulesView>> = {}) =>
  render(<SchedulesView onClose={vi.fn()} projects={[]} {...props} />);

beforeEach(() => {
  api.listSchedules.mockResolvedValue({ schedules: [] });
  api.listScheduleRuns.mockResolvedValue({ runs: [] });
  api.previewSchedule.mockResolvedValue({ ok: true, next: ['2026-07-02T08:00:00.000Z', '2026-07-03T08:00:00.000Z'] });
  api.getModels.mockResolvedValue({ models: [] });
  api.createSchedule.mockResolvedValue(sched());
  api.updateSchedule.mockResolvedValue(sched());
  api.deleteSchedule.mockResolvedValue({ ok: true });
  api.runScheduleNow.mockResolvedValue({ ok: true });
});

describe('SchedulesView list', () => {
  it('invites the first task when there are none', async () => {
    open();
    expect(await screen.findByText(/Nothing scheduled/)).toBeInTheDocument();
  });

  it('shows a task with its timetable, next run and last result', async () => {
    api.listSchedules.mockResolvedValue({ schedules: [sched({ lastRun: run({ status: 'error', error: 'model refused' }) })] });
    open();
    expect(await screen.findByText('Job offers')).toBeInTheDocument();
    expect(screen.getByText(/Every day, 08:00/)).toBeInTheDocument();
    expect(screen.getByText(/Next:/)).toBeInTheDocument();
    expect(screen.getByText(/model refused/)).toBeInTheDocument();
  });

  it('shows a paused task as paused and offers to resume it', async () => {
    api.listSchedules.mockResolvedValue({ schedules: [sched({ enabled: false, nextRunAt: null })] });
    open();
    expect(await screen.findByText('Paused')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Resume Job offers' }));
    expect(api.updateSchedule).toHaveBeenCalledWith('s1', { enabled: true });
  });

  it('"Run now" starts a run, and is not offered while one is going', async () => {
    api.listSchedules.mockResolvedValue({ schedules: [sched()] });
    open();
    await userEvent.click(await screen.findByRole('button', { name: 'Run Job offers now' }));
    expect(api.runScheduleNow).toHaveBeenCalledWith('s1');

    api.listSchedules.mockResolvedValue({ schedules: [sched({ lastRun: run({ status: 'running', finishedAt: null }) })] });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run Job offers now' })).toBeDisabled());
  });

  it('asks before deleting, and keeps the task on "Keep"', async () => {
    api.listSchedules.mockResolvedValue({ schedules: [sched()] });
    open();
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Job offers' }));
    expect(api.deleteSchedule).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(screen.queryByText(/Delete this task/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Delete Job offers' }));
    await userEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Delete' }));
    expect(api.deleteSchedule).toHaveBeenCalledWith('s1');
  });

  it('shows the history of a task and opens the chat of a run', async () => {
    api.listSchedules.mockResolvedValue({ schedules: [sched()] });
    api.listScheduleRuns.mockResolvedValue({ runs: [run(), run({ id: 'r2', conversationId: null, status: 'skipped', summary: 'The previous run was still going.' })] });
    const onOpenConversation = vi.fn();
    const onClose = vi.fn();
    open({ onOpenConversation, onClose });
    await userEvent.click(await screen.findByRole('button', { name: 'History of Job offers' }));
    expect(await screen.findByText('Found 3 new offers')).toBeInTheDocument();
    expect(screen.getByText('Skipped')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open the chat of this run' }));
    expect(onOpenConversation).toHaveBeenCalledWith('c1');
    expect(onClose).toHaveBeenCalled();
  });

  it('shows the server\'s refusal instead of swallowing it', async () => {
    api.listSchedules.mockResolvedValue({ schedules: [sched()] });
    api.runScheduleNow.mockRejectedValue(new Error('This schedule is already running.'));
    open();
    await userEvent.click(await screen.findByRole('button', { name: 'Run Job offers now' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already running');
  });
});

describe('Schedule form', () => {
  async function openForm() {
    open();
    await userEvent.click(await screen.findByRole('button', { name: /New task/ }));
    return screen.findByRole('form', { name: 'New scheduled task' });
  }

  it('cannot be saved without a name and a prompt', async () => {
    await openForm();
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Name'), 'Stocks');
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('What should the agent do?'), 'Report the price of AAPL');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled());
  });

  it('creates a task from a preset and shows the next runs', async () => {
    await openForm();
    await userEvent.type(screen.getByLabelText('Name'), 'Stocks');
    await userEvent.type(screen.getByLabelText('What should the agent do?'), 'Report the price of AAPL');
    await userEvent.selectOptions(screen.getByLabelText('Repeats'), '0 8 * * 1-5');
    expect(await screen.findByText('Next runs')).toBeInTheDocument();
    await waitFor(() => expect(api.previewSchedule).toHaveBeenCalledWith('0 8 * * 1-5', expect.any(String)));
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(api.createSchedule).toHaveBeenCalled());
    expect(api.createSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Stocks', prompt: 'Report the price of AAPL', cron: '0 8 * * 1-5', model: null, projectId: null, allowPaid: false, enabled: true }),
    );
    // back on the list afterwards
    expect(await screen.findByRole('button', { name: /New task/ })).toBeInTheDocument();
  });

  it('blocks a cron expression the server calls invalid and says why', async () => {
    api.previewSchedule.mockImplementation(async (cron: string) =>
      cron === 'nonsense' ? { ok: false, error: 'That is not a valid cron expression.' } : { ok: true, next: ['2026-07-02T08:00:00.000Z'] },
    );
    await openForm();
    await userEvent.type(screen.getByLabelText('Name'), 'X');
    await userEvent.type(screen.getByLabelText('What should the agent do?'), 'Y');
    await userEvent.selectOptions(screen.getByLabelText('Repeats'), '__custom__');
    const cron = screen.getByLabelText('Cron expression');
    await userEvent.clear(cron);
    await userEvent.type(cron, 'nonsense');
    expect(await screen.findByText('That is not a valid cron expression.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
  });

  it('stays open and shows the server\'s message when saving fails', async () => {
    api.createSchedule.mockRejectedValue(new Error('"model" is not a model of this app.'));
    await openForm();
    await userEvent.type(screen.getByLabelText('Name'), 'X');
    await userEvent.type(screen.getByLabelText('What should the agent do?'), 'Y');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText(/is not a model of this app/)).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'New scheduled task' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled();
  });

  it('edits an existing task, starting from its values', async () => {
    api.listSchedules.mockResolvedValue({ schedules: [sched({ cron: '*/30 * * * *', allowPaid: true })] });
    open();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Job offers' }));
    const form = await screen.findByRole('form', { name: 'Edit scheduled task' });
    expect(within(form).getByLabelText('Name')).toHaveValue('Job offers');
    expect(within(form).getByLabelText('Cron expression')).toHaveValue('*/30 * * * *');
    expect(within(form).getByLabelText(/Allow paid models/)).toBeChecked();
    await userEvent.clear(within(form).getByLabelText('Name'));
    await userEvent.type(within(form).getByLabelText('Name'), 'Renamed');
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateSchedule).toHaveBeenCalledWith('s1', expect.objectContaining({ name: 'Renamed', cron: '*/30 * * * *', allowPaid: true })));
  });
});
