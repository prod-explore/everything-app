import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RightRail } from './RightRail';

const noop = () => {};
const rail = (agentCount?: number) => render(<RightRail browserOpen={false} onToggleBrowser={noop} tools={[]} onToggleTool={noop} agentCount={agentCount} />);

describe('RightRail agents badge', () => {
  it('shows the number of running agents on the Agents button only', () => {
    rail(3);
    const agents = screen.getByRole('button', { name: 'Agents' });
    expect(agents).toHaveTextContent('3');
    expect(agents).toHaveAttribute('title', 'Agents — 3 running');
    expect(screen.getByRole('button', { name: 'Files' })).not.toHaveTextContent(/\d/);
  });

  it('shows nothing when no agent is running', () => {
    rail(0);
    expect(screen.getByRole('button', { name: 'Agents' })).not.toHaveTextContent(/\d/);
  });

  it('caps the visible number at 9+', () => {
    rail(14);
    expect(screen.getByRole('button', { name: 'Agents' })).toHaveTextContent('9+');
  });
});
