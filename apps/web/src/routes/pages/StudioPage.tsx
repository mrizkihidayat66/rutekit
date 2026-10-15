import { RotateCcw, Search, Star } from 'lucide-react';
import { useCallback, useState } from 'react';

import type { Asset, GenerationJob } from '@contracts';

import { Button } from '@web/components/ui/Button.tsx';
import { Input } from '@web/components/ui/Input.tsx';
import { SegmentedControl } from '@web/components/ui/SegmentedControl.tsx';
import { useCreateStudioGeneration } from '@web/hooks/use-tools.ts';
import { useUrlFlag, useUrlParam, useUrlText } from '@web/hooks/use-url-state.ts';
import { cn } from '@web/lib/cn.ts';
import { PageHeader } from '@web/shell/PageHeader.tsx';

import { AssetDetailDrawer } from './studio/AssetDetailDrawer.tsx';
import { GenerationQueue } from './studio/GenerationQueue.tsx';
import { StudioGallery } from './studio/StudioGallery.tsx';
import { StudioPromptCard } from './studio/StudioPromptCard.tsx';
import { StudioSidebar } from './studio/StudioSidebar.tsx';
import {
  SEARCH_PARAM,
  STAR_PARAM,
  STUDIO_PARAM,
  STUDIO_VIEWS,
  VIEW_LABELS,
  VIEW_PARAM,
  buildParameters,
  draftFromAsset,
  draftFromJob,
  emptyDraft,
  type ReuseMode,
  type StudioDraft,
  type StudioView,
} from './studio/studio.ts';

/**
 * The Studio: a prompt, the dials around it, and everything it has made.
 *
 * Three panes share one page rather than being three routes, because moving
 * between them is a glance rather than a journey — you queue a render, watch it
 * in the queue, then go find it in the gallery, all with the same prompt still
 * sitting in the box above. The view is in the URL, so any of the three is a
 * link, and so is the asset the detail drawer has open.
 *
 * The draft lives in component state rather than in the URL. A half-typed prompt
 * is not a place worth returning to, and putting a 400-character string in the
 * address bar would make every keystroke a history entry.
 */

const VIEW_OPTIONS = STUDIO_VIEWS.map((value) => ({ value, label: VIEW_LABELS[value] }));

export function StudioPage() {
  const [view, setView] = useUrlParam<StudioView>(VIEW_PARAM, 'images', STUDIO_VIEWS);
  const [assetParam, setAssetParam] = useUrlParam<string>(STUDIO_PARAM, '');
  const [starred, setStarred] = useUrlFlag(STAR_PARAM, false);
  const [search, setSearch] = useUrlText(SEARCH_PARAM, '');

  const [draft, setDraft] = useState<StudioDraft>(emptyDraft);

  const patchDraft = useCallback((patch: Partial<StudioDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
  }, []);

  const create = useCreateStudioGeneration();
  const assetId = assetParam === '' ? null : assetParam;

  // Switching between the image and video panes is also a statement about what
  // is being made, so the output kind follows it. The queue is not a kind, and
  // leaves the draft alone.
  const changeView = useCallback(
    (next: StudioView) => {
      setView(next);
      if (next !== 'queue') patchDraft({ kind: next === 'videos' ? 'video' : 'image' });
    },
    [setView, patchDraft],
  );

  const generate = useCallback(() => {
    const providerId = draft.providerId;
    const model = draft.model;
    if (providerId === null || model === null || draft.prompt.trim() === '') return;

    create.mutate(
      {
        kind: draft.kind,
        providerId,
        model,
        prompt: draft.prompt,
        negativePrompt: draft.negativePrompt.trim() === '' ? null : draft.negativePrompt,
        parameters: buildParameters(draft),
        count: draft.count,
        // The asset this draft was loaded from, when it was loaded from one. The
        // composer has carried `origin` since FASE B and had nowhere to send it,
        // so refine/variation/upscale could only *say* where a render came from.
        parentAssetId: draft.origin,
      },
      {
        onSuccess: () => {
          setView('queue');
        },
      },
    );
  }, [draft, create, setView]);

  const reuseAsset = useCallback(
    (asset: Asset, mode: ReuseMode) => {
      setDraft(draftFromAsset(asset, mode));
      setAssetParam('');
    },
    [setAssetParam],
  );

  const reuseJob = useCallback((job: GenerationJob) => {
    setDraft(draftFromJob(job));
  }, []);

  const reset = useCallback(() => {
    setDraft(emptyDraft());
  }, []);

  const generateError = create.error === null ? null : create.error.message;

  return (
    <div className="@container flex min-h-full flex-col gap-5 p-5">
      <PageHeader
        title="Studio"
        description="Generate images and video from a prompt, then keep what works."
        actions={
          <Button variant="secondary" size="sm" onClick={reset}>
            <RotateCcw aria-hidden="true" className="size-3.5" />
            New prompt
          </Button>
        }
      />

      <div className="flex flex-col gap-4 @[1000px]:flex-row @[1000px]:items-start">
        <div className="@[1000px]:w-72 @[1000px]:shrink-0">
          <StudioSidebar draft={draft} onChange={patchDraft} disabled={create.isPending} />
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <StudioPromptCard
            draft={draft}
            onChange={patchDraft}
            onGenerate={generate}
            pending={create.isPending}
            disabled={create.isPending}
            error={generateError}
          />

          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl
              value={view}
              options={VIEW_OPTIONS}
              aria-label="Studio view"
              onValueChange={changeView}
            />

            {view === 'queue' ? null : (
              <>
                <Button
                  variant={starred ? 'secondary' : 'ghost'}
                  size="sm"
                  aria-pressed={starred}
                  onClick={() => {
                    setStarred(!starred);
                  }}
                >
                  <Star
                    aria-hidden="true"
                    className={cn('size-3.5', starred && 'fill-current text-warning')}
                  />
                  Starred
                </Button>

                <Input
                  inputSize="sm"
                  type="search"
                  value={search}
                  aria-label="Search assets"
                  placeholder="Search prompts…"
                  leading={<Search aria-hidden="true" />}
                  className="w-full max-w-64"
                  onChange={(event) => {
                    setSearch(event.target.value);
                  }}
                />
              </>
            )}
          </div>

          {view === 'queue' ? (
            <GenerationQueue onOpenAsset={setAssetParam} onReuse={reuseJob} />
          ) : (
            <StudioGallery
              kind={view === 'videos' ? 'video' : 'image'}
              starred={starred}
              search={search}
              onOpen={setAssetParam}
            />
          )}
        </div>
      </div>

      <AssetDetailDrawer
        assetId={assetId}
        onOpenChange={(open) => {
          if (!open) setAssetParam('');
        }}
        onReuse={reuseAsset}
        onNavigate={setAssetParam}
      />
    </div>
  );
}
