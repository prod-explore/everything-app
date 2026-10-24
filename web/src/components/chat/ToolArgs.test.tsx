// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ToolArgs } from './ToolCallCard';

describe('ToolArgs', () => {
  it('shows each argument under its name, text as text and the rest as JSON', () => {
    const { container } = render(<ToolArgs toolName="obsidian__write_note" args={{ path: 'a/b.md', content: 'line one\nline two', options: { overwrite: true } }} />);
    expect(screen.getByText('path')).toBeTruthy();
    expect(screen.getByText('a/b.md')).toBeTruthy();
    expect(container.textContent).toContain('line one\nline two'); // real line break, not an escaped \n
    expect(container.textContent).toContain('"overwrite": true');
  });

  it('renders nothing when the tool took no arguments', () => {
    const { container } = render(<ToolArgs toolName="list_agents" args={{}} />);
    expect(container).toBeEmptyDOMElement();
    const none = render(<ToolArgs toolName="list_agents" args={undefined} />);
    expect(none.container).toBeEmptyDOMElement();
  });
});
