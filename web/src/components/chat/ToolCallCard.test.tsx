// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ToolCallMessagePartProps } from '@assistant-ui/react';
import { describe, expect, it } from 'vitest';
import { ToolCallCard } from './ToolCallCard';

const props = (over: Record<string, unknown> = {}): ToolCallMessagePartProps =>
  ({ toolCallId: 'c1', toolName: 'crm__find_contact', args: { query: 'Kowalski', filters: { active: true } }, argsText: '', result: 'found 1', isError: false, status: { type: 'complete' }, ...over }) as unknown as ToolCallMessagePartProps;

describe('ToolCallCard', () => {
  it('lists an unknown tool by its own name and keeps the payload behind the click, as plain JSON', async () => {
    render(<ToolCallCard {...props()} />);
    expect(screen.getByText('crm__find_contact')).toBeTruthy();
    expect(screen.queryByText(/payload/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /crm__find_contact/ }));
    expect(screen.getByText('crm__find_contact · payload')).toBeTruthy();
    expect(screen.getByText(/"query": "Kowalski"/)).toBeTruthy();
    expect(screen.getByText('found 1')).toBeTruthy();
  });

  it('shows the error text of a failed call', async () => {
    render(<ToolCallCard {...props({ result: 'Error moving note', isError: true })} />);
    await userEvent.click(screen.getByRole('button', { name: /crm__find_contact/ }));
    expect(screen.getByText('Error moving note')).toBeTruthy();
  });
});
