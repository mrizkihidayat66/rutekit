import { code } from '@streamdown/code';
import { createMathPlugin } from '@streamdown/math';
import { mermaid } from '@streamdown/mermaid';
import { Streamdown } from 'streamdown';

import { cn } from '@web/lib/cn.ts';

import 'streamdown/styles.css';
import 'katex/dist/katex.min.css';

/**
 * The three renderers a reply can need, configured once.
 *
 * `singleDollarTextMath` is on because `$x$` is what people actually type for
 * inline math, and leaving it off renders a price as prose. KaTeX's error colour
 * is pointed at the console's own danger token rather than the plugin's default,
 * which names a variable this theme does not define — so a broken expression
 * would render in whatever colour the browser falls back to.
 */
const PLUGINS = {
  code,
  math: createMathPlugin({ singleDollarTextMath: true, errorColor: 'var(--color-danger-text)' }),
  mermaid,
} as const;

/**
 * Markdown that is safe to render while it is still being written.
 *
 * A streamed answer is not valid markdown for most of its life: the fence is
 * open, the table has no closing row, the link has no target yet. `Streamdown`
 * is built for exactly that — it renders the incomplete document as if it were
 * complete, then re-renders as more arrives — which is why it is here rather
 * than a plain markdown renderer with a "still loading" fallback.
 *
 * `mode="streaming"` turns on the caret and the fade-in, so a token that arrives
 * looks like it arrived rather than like the paragraph was replaced.
 *
 * The stylesheets are imported here and not at the app root because they belong
 * to this renderer; the route is a lazy chunk, so they are paid for by the one
 * page that draws markdown and by no other.
 */
export function ChatMarkdown({ children, streaming = false }: { children: string; streaming?: boolean }) {
  return (
    <Streamdown
      mode={streaming ? 'streaming' : 'static'}
      isAnimating={streaming}
      plugins={PLUGINS}
      className={cn(
        'text-sm leading-relaxed text-text',
        // The renderer emits its own elements; these give them the console's
        // rhythm without restyling every tag it can produce.
        '[&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0',
        '[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5',
        '[&_li]:my-0.5',
        '[&_h1]:mt-4 [&_h2]:mt-4 [&_h3]:mt-4 [&_h1]:mb-2 [&_h2]:mb-2 [&_h3]:mb-2',
        '[&_h1]:text-base [&_h2]:text-sm [&_h3]:text-sm [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold',
        '[&_a]:text-info-text [&_a]:underline [&_a]:underline-offset-2',
        '[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-text-muted',
        '[&_hr]:my-4 [&_hr]:border-border',
        '[&_table]:my-3 [&_table]:w-full [&_table]:text-xs',
        '[&_th]:border [&_th]:border-border [&_th]:bg-surface-2 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-medium',
        '[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1',
        '[&_code:not(pre_code)]:rounded-key [&_code:not(pre_code)]:bg-surface-3 [&_code:not(pre_code)]:px-1 [&_code:not(pre_code)]:py-0.5',
        '[&_code:not(pre_code)]:font-mono [&_code:not(pre_code)]:text-[0.8125rem]',
      )}
    >
      {children}
    </Streamdown>
  );
}
