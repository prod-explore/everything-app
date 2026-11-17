import { memo, useState } from 'react';
import type { TextMessagePartComponent } from '@assistant-ui/react';
import { Check, Copy } from 'lucide-react';
import Markdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import 'katex/dist/katex.min.css';
import { escapeCurrencyDollars } from '../../lib/markdownMath';
import { useThrottledText } from '../../hooks/useThrottledText';

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="absolute right-2 top-2 rounded-lg border border-border bg-bg-secondary p-1 text-fg-tertiary opacity-0 transition-opacity hover:text-fg group-hover:opacity-100"
      aria-label="Copy code"
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

function extractText(node: unknown): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (node && typeof node === 'object' && 'props' in node) {
    return extractText((node as { props?: { children?: unknown } }).props?.children);
  }
  return '';
}

export const MarkdownText: TextMessagePartComponent = ({ text, status }) => <MarkdownBody text={useThrottledText(text, status?.type === 'running')} />;

/** Errors in a formula show as the plain source in a quiet grey, never as an alarming red box. */
const KATEX = { throwOnError: false, errorColor: 'currentColor' } as const;

/** The same renderer outside assistant-ui's message-part context (Gazeta reports, agent transcripts). */
export const MarkdownBody = memo(function MarkdownBody({ text }: { text: string }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[[rehypeKatex, KATEX], rehypeHighlight]}
      components={{
        table: ({ children, ...props }) => (
          <div className="my-3 overflow-x-auto">
            <table {...props}>{children}</table>
          </div>
        ),
        a: props => <a {...props} target="_blank" rel="noreferrer" className="underline decoration-fg-tertiary" />,
        pre: ({ children, ...props }) => (
          <pre {...props} className="group relative">
            <CopyButton text={extractText(children)} />
            {children}
          </pre>
        ),
        code: ({ className, children, ...props }) => {
          const isBlock = Boolean(className); // rehype-highlight only sets a className on fenced blocks
          return isBlock ? (
            <code className={className} {...props}>
              {children}
            </code>
          ) : (
            <code className="rounded bg-bg px-1 py-0.5 font-mono text-xs" {...props}>
              {children}
            </code>
          );
        },
      }}
    >
      {escapeCurrencyDollars(text)}
    </Markdown>
  );
});
