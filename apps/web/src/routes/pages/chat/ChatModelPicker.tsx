import { ChevronsUpDown } from 'lucide-react';

import { Popover, PopoverContent, PopoverTrigger } from '@web/components/ui/Popover.tsx';
import { useModels, useProviders } from '@web/hooks/use-providers.ts';
import { cn } from '@web/lib/cn.ts';

import { ChatOptionList, type ChatOption } from './ChatOptionList.tsx';
import { THINKING_LEVELS, thinkingLabel, type ChatConfig } from './chat.ts';

/**
 * Provider, model and effort behind a single button.
 *
 * These three used to be a row of labelled selects in a bordered band, which
 * spent a whole strip of the page on something set once and then left alone.
 * Here they sit behind one trigger that names the current choice, so the
 * transcript keeps the space and the header stays a single line.
 *
 * The three are a chain rather than independent filters: a model is something a
 * provider serves, so choosing a new provider clears the model instead of
 * carrying a name across to an endpoint that may not answer to it.
 *
 * `''` is the "any" and "default" choice, and maps to `null` in the config. A
 * select cannot spell its empty value that way — which is why the previous
 * version needed sentinels — but these are buttons, so it can.
 */

/** Paged pickers: the header wants the whole list, not the first screen of it. */
const PICKER_QUERY = { q: '', sort: null, direction: 'asc', limit: 200 } as const;

const ANY_PROVIDER = 'Any provider';
const DEFAULT_MODEL = 'Provider default';

export interface ChatModelPickerProps {
  readonly config: ChatConfig;
  readonly onConfigChange: (next: ChatConfig) => void;
}

export function ChatModelPicker({ config, onConfigChange }: ChatModelPickerProps) {
  const providers = useProviders({ ...PICKER_QUERY, category: null, status: null, tier: 'all' });
  const models = useModels({
    ...PICKER_QUERY,
    providerId: config.providerId,
    capability: null,
    source: null,
    minContext: null,
  });

  const providerItems = (providers.data?.pages ?? []).flatMap((page) => page.items);
  const modelItems = (models.data?.pages ?? []).flatMap((page) => page.items);

  const providerOptions: readonly ChatOption[] = [
    { value: '', label: ANY_PROVIDER },
    ...providerItems.map((provider) => ({ value: provider.id, label: provider.name })),
  ];
  const modelOptions: readonly ChatOption[] = [
    { value: '', label: DEFAULT_MODEL },
    ...modelItems.map((model) => ({
      value: model.id,
      label: model.displayName,
      detail: model.providerId,
    })),
  ];

  // A chosen entry can sit past the page that was fetched, so the stored id is
  // the fallback: calling it "Provider default" would be a plain lie.
  const providerLabel =
    providerItems.find((provider) => provider.id === config.providerId)?.name ??
    (config.providerId ?? ANY_PROVIDER);
  const modelLabel =
    modelItems.find((model) => model.id === config.model)?.displayName ??
    (config.model ?? DEFAULT_MODEL);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Provider, model and thinking level"
          className={cn(
            'inline-flex h-7 max-w-[24rem] min-w-0 items-center gap-1.5 rounded-control border border-border bg-surface-2 px-2.5 text-xs text-text-muted',
            'transition duration-(--dur-micro) ease-out outline-none',
            'hover:bg-surface-3 hover:text-text focus-visible:ring-2 focus-visible:ring-focus',
          )}
        >
          <span className="truncate">
            {`${providerLabel} · ${modelLabel} · ${thinkingLabel(config.thinkingLevel)}`}
          </span>
          <ChevronsUpDown aria-hidden="true" className="size-3 shrink-0" />
        </button>
      </PopoverTrigger>

      <PopoverContent className="flex w-[min(20rem,90vw)] flex-col gap-3">
        <ChatOptionList
          label="Provider"
          options={providerOptions}
          selected={config.providerId ?? ''}
          pending={providers.isPending}
          searchPlaceholder="Find a provider"
          emptyLabel="No provider matched."
          onSelect={(value) => {
            onConfigChange({ ...config, providerId: value === '' ? null : value, model: null });
          }}
        />

        <ChatOptionList
          label="Model"
          options={modelOptions}
          selected={config.model ?? ''}
          pending={models.isPending}
          searchPlaceholder="Find a model"
          emptyLabel="No model matched."
          onSelect={(value) => {
            onConfigChange({ ...config, model: value === '' ? null : value });
          }}
        />

        <div className="flex flex-col gap-1.5">
          <span className="text-[0.6875rem] font-medium tracking-wide text-text-subtle uppercase">
            Thinking
          </span>
          <div role="group" aria-label="Thinking level" className="flex flex-wrap gap-1">
            {THINKING_LEVELS.map((level) => {
              const active = config.thinkingLevel === level;
              return (
                <button
                  key={level}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    onConfigChange({ ...config, thinkingLevel: level });
                  }}
                  className={cn(
                    'rounded-pill border px-2 py-0.5 text-[0.6875rem] outline-none',
                    'transition duration-(--dur-micro) ease-out focus-visible:ring-2 focus-visible:ring-focus',
                    active
                      ? 'border-accent bg-surface-2 text-text'
                      : 'border-border text-text-muted hover:bg-surface-2 hover:text-text',
                  )}
                >
                  {thinkingLabel(level)}
                </button>
              );
            })}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
