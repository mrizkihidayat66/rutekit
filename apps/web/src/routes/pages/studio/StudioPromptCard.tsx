import { Sparkles, X } from 'lucide-react';

import { Badge } from '@web/components/ui/Badge.tsx';
import { Button } from '@web/components/ui/Button.tsx';
import { Card } from '@web/components/ui/Card.tsx';
import { Textarea } from '@web/components/ui/Textarea.tsx';
import { cn } from '@web/lib/cn.ts';

import { KIND_LABELS, type StudioDraft } from './studio.ts';

/**
 * Prompt first, because that is the only field that matters.
 *
 * Everything else in the Studio has a sensible default and can be left alone; the
 * prompt is the work. So it gets the top of the page, the widest box, and the
 * button — while the dials sit to the side for the attempts that need them.
 *
 * The negative prompt is here rather than in the parameter panel for the same
 * reason: it is half of what the operator is saying, not a knob on the machine.
 */

export interface StudioPromptCardProps {
  readonly draft: StudioDraft;
  readonly onChange: (patch: Partial<StudioDraft>) => void;
  readonly onGenerate: () => void;
  readonly pending: boolean;
  readonly error: string | null;
  readonly disabled?: boolean;
}

export function StudioPromptCard({
  draft,
  onChange,
  onGenerate,
  pending,
  error,
  disabled = false,
}: StudioPromptCardProps) {
  const ready = draft.prompt.trim() !== '' && draft.providerId !== null && draft.model !== null;
  const blocked = disabled || !ready;

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-sm font-semibold text-text">Prompt</h2>
        {draft.origin === null ? null : (
          <span className="text-[0.6875rem] text-text-subtle">
            seeded from <span className="font-mono text-text-muted">{draft.origin}</span>
          </span>
        )}
        {draft.upscale ? (
          <Badge tone="accent" size="sm">
            2× upscale
            <button
              type="button"
              aria-label="Remove the upscale"
              className="ml-0.5 rounded-key outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
              onClick={() => {
                onChange({ upscale: false });
              }}
            >
              <X aria-hidden="true" className="size-3" />
            </button>
          </Badge>
        ) : null}
      </div>

      <Textarea
        autoGrow
        value={draft.prompt}
        aria-label="Prompt"
        placeholder="Describe the image or shot you want — subject, style, lighting, framing."
        disabled={disabled}
        onChange={(event) => {
          onChange({ prompt: event.target.value });
        }}
      />

      <Textarea
        autoGrow
        value={draft.negativePrompt}
        aria-label="Negative prompt"
        placeholder="Negative prompt (optional) — what to keep out."
        disabled={disabled}
        className="text-xs"
        onChange={(event) => {
          onChange({ negativePrompt: event.target.value });
        }}
      />

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
        <p className="text-[0.6875rem] text-text-subtle">
          {draft.model === null
            ? 'Pick a provider and a model to continue.'
            : `${KIND_LABELS[draft.kind]} · ${draft.model} · ${draft.aspect} · seed ${draft.seed}`}
        </p>
        <Button loading={pending} disabled={blocked} onClick={onGenerate}>
          <Sparkles aria-hidden="true" className="size-3.5" />
          {draft.count === 1 ? `Generate ${KIND_LABELS[draft.kind].toLowerCase()}` : `Generate ${draft.count}`}
        </Button>
      </div>

      {error === null ? null : (
        <p role="alert" className={cn('text-xs text-danger-text')}>
          {error}
        </p>
      )}
    </Card>
  );
}
