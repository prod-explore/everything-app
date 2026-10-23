import { ComposerPrimitive } from '@assistant-ui/react';
import { Square } from 'lucide-react';

export function StopButton() {
  return (
    <ComposerPrimitive.Cancel
      className="flex size-[42px] shrink-0 items-center justify-center rounded-button border border-danger/40 text-danger hover:bg-danger/10"
      title="Stop (kill switch)"
    >
      <Square size={16} />
    </ComposerPrimitive.Cancel>
  );
}
