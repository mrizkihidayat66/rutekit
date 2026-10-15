import { FileText, TriangleAlert } from 'lucide-react';

import type { CliSnippet } from '@contracts';

import { Badge } from '@web/components/ui/Badge.tsx';
import { CopyButton } from '@web/components/patterns/CopyButton.tsx';

/**
 * One block of config, with the file it belongs in and a copy control.
 *
 * The body is rendered in a `<pre>` rather than highlighted. There is no
 * highlighter in this project, and a hand-rolled one for four languages would be
 * a second parser to keep correct for no gain — the snippet is short, the shape
 * is the point, and a monospaced block is what an operator is going to paste
 * anyway.
 *
 * The filename is shown above the block rather than beside the copy button
 * because it changes what the block *is*: the same JSON is a VS Code setting in
 * one card and a file in another, and pasting it in the wrong place is the
 * mistake this label exists to prevent.
 */
export interface SnippetBlockProps {
  readonly snippet: CliSnippet;
}

export function SnippetBlock({ snippet }: SnippetBlockProps) {
  return (
    <div className="rounded-card border border-border bg-surface-2">
      <header className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <h4 className="truncate text-xs font-semibold text-text">{snippet.label}</h4>
          {snippet.filename === null ? null : (
            <span className="flex min-w-0 items-center gap-1 text-[0.6875rem] text-text-subtle">
              <FileText aria-hidden="true" className="size-3 shrink-0" />
              <span className="truncate font-mono">{snippet.filename}</span>
            </span>
          )}
        </div>
        <CopyButton value={snippet.body} label={`${snippet.label} snippet`} iconOnly />
      </header>

      <pre className="overflow-x-auto px-3 py-3 font-mono text-[0.6875rem] leading-relaxed text-text">
        <code>{snippet.body}</code>
      </pre>
    </div>
  );
}

/**
 * A warning that a snippet's shape has not been checked against the client.
 *
 * Shown rather than kept internal. An unverified snippet that is subtly wrong —
 * a key name that is off by a hyphen — fails in a way that looks like rutekit
 * being broken, and the operator has no way to tell the two apart. Saying so up
 * front turns a silent misconfiguration into a thing to watch for, and points at
 * the client's own documentation as the tie-breaker.
 */
export function UnverifiedNotice() {
  return (
    <p className="flex items-start gap-2 rounded-card border border-warning/40 bg-warning/10 px-3 py-2 text-[0.6875rem] text-warning-text">
      <TriangleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
      <span>
        This client&rsquo;s file format has not been checked against its own documentation — the
        three values below are right, but the keys around them are worth confirming before you rely
        on them.
      </span>
    </p>
  );
}

export function SurfaceBadge({ label, path }: { readonly label: string; readonly path: string }) {
  return (
    <Badge tone="neutral" size="sm">
      {label} · <span className="font-mono">{path}</span>
    </Badge>
  );
}
