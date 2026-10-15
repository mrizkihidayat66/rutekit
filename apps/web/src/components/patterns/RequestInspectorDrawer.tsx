import { Check, Minus, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

import type {
  RequestDetail,
  RequestPayloadPanel,
  RequestTimelineStep,
  RouteTraceStep,
} from '@contracts';

import { Badge } from '@web/components/ui/Badge.tsx';
import { Drawer } from '@web/components/ui/Drawer.tsx';
import { Skeleton, SkeletonText } from '@web/components/ui/Skeleton.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@web/components/ui/Tabs.tsx';
import {
  formatBytes,
  formatCount,
  formatDateTime,
  formatDurationMs,
  formatUsd,
} from '@web/lib/format.ts';
import { cn } from '@web/lib/cn.ts';
import type { CSSVars } from '@web/lib/css-vars.ts';

import { CopyButton } from './CopyButton.tsx';
import { TONE_GRAPHIC, type Tone } from './tone.ts';

/**
 * The request inspector: what came in, what was sent upstream, what came back,
 * and how the router got there.
 *
 * This is the view that makes the router debuggable. A failing request has an
 * obvious "why" — the client body, the canonical form after alias/combo
 * rewriting, the exact upstream request, the raw upstream response, and the
 * response handed back to the client — and all five are shown side by side
 * rather than inferred. Alongside them, the route trace names each hop that
 * changed the target, and the timeline shows where the latency went.
 *
 * Payloads are redacted and expire server-side (SEC-6); the panel says so
 * instead of presenting a trimmed body as if it were whole.
 */

export interface RequestInspectorDrawerProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly detail: RequestDetail | null;
  readonly isLoading: boolean;
  readonly isError?: boolean;
  /** At-a-glance header, e.g. `<RequestSummary>`, shown above the tabs. */
  readonly children?: ReactNode;
}

const STATUS_TONE = (status: number): Tone => {
  if (status < 300) return 'success';
  if (status < 400) return 'info';
  if (status < 500) return 'warning';
  return 'danger';
};

const TRACE_TONE: Record<RouteTraceStep['kind'], Tone> = {
  alias: 'accent',
  combo: 'info',
  mapping: 'neutral',
  filter: 'warning',
  account: 'success',
};

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[0.6875rem] uppercase tracking-wide text-text-subtle">{label}</dt>
      <dd className="mt-0.5 truncate text-xs text-text">{children}</dd>
    </div>
  );
}

function PayloadPanel({ panel }: { readonly panel: RequestPayloadPanel }) {
  return (
    <section className="rounded-card border border-border bg-surface-2">
      <header className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="truncate text-xs font-semibold text-text">{panel.label}</h3>
          {panel.byteSize === null ? null : (
            <span className="shrink-0 text-[0.6875rem] tabular-nums text-text-subtle">
              {formatBytes(panel.byteSize)}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {panel.redacted ? (
            <Badge tone="warning" size="sm">
              redacted
            </Badge>
          ) : null}
          {panel.truncated ? (
            <Badge tone="neutral" size="sm">
              truncated
            </Badge>
          ) : null}
          {panel.body === null ? null : (
            <CopyButton value={panel.body} label={`${panel.label} body`} />
          )}
        </div>
      </header>
      {panel.body === null ? (
        <p className="px-3 py-6 text-center text-xs text-text-subtle">
          No capture for this stage — it was not recorded or has expired.
        </p>
      ) : (
        <pre className="scrollbar-none max-h-80 overflow-auto px-3 py-2.5 font-mono text-[0.6875rem] leading-relaxed text-text-muted">
          {panel.body}
        </pre>
      )}
    </section>
  );
}

function RouteTrace({ steps }: { readonly steps: readonly RouteTraceStep[] }) {
  if (steps.length === 0) {
    return (
      <StateView
        kind="empty"
        title="No routing steps"
        description="This request was routed directly."
      />
    );
  }
  return (
    <ol className="space-y-0">
      {steps.map((step, index) => (
        <li key={`${step.kind}-${String(index)}`} className="flex gap-3">
          <div className="flex flex-col items-center">
            <span
              className={cn(
                'mt-1.5 size-2 shrink-0 rounded-pill bg-current',
                TONE_GRAPHIC[TRACE_TONE[step.kind]],
              )}
              aria-hidden="true"
            />
            {index === steps.length - 1 ? null : (
              <span className="w-px flex-1 bg-border" aria-hidden="true" />
            )}
          </div>
          <div className="pb-4">
            <div className="flex items-center gap-2">
              <span className="text-[0.6875rem] uppercase tracking-wide text-text-subtle">
                {step.kind}
              </span>
              <span className="text-xs font-medium text-text">{step.label}</span>
            </div>
            {step.detail === null ? null : (
              <p className="mt-0.5 font-mono text-[0.6875rem] text-text-muted">{step.detail}</p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

function Timeline({ steps }: { readonly steps: readonly RequestTimelineStep[] }) {
  if (steps.length === 0) {
    return <StateView kind="empty" title="No timing recorded" />;
  }
  const total = Math.max(1, ...steps.map((step) => step.atMs + step.durationMs));

  return (
    <ol className="space-y-1.5">
      {steps.map((step) => {
        const left = (step.atMs / total) * 100;
        const width = Math.max(0.5, (step.durationMs / total) * 100);
        return (
          <li
            key={step.stage}
            className="grid grid-cols-[7rem_minmax(0,1fr)_4.5rem] items-center gap-3"
          >
            <span className="truncate text-xs text-text-muted" title={step.stage}>
              {step.stage}
            </span>
            <span className="relative h-2 rounded-pill bg-surface-3">
              <span
                className="absolute inset-y-0 left-(--seg-left) w-(--seg-w) rounded-pill bg-accent"
                style={{ '--seg-left': `${left}%`, '--seg-w': `${width}%` } as CSSVars}
              />
            </span>
            <span className="text-right text-[0.6875rem] tabular-nums text-text-subtle">
              {formatDurationMs(step.durationMs)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function RequestInspectorDrawer({
  open,
  onOpenChange,
  detail,
  isLoading,
  isError = false,
  children,
}: RequestInspectorDrawerProps) {
  const request = detail?.request ?? null;

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      width="lg"
      title={request === null ? 'Request' : `${request.method} ${request.path}`}
      description={request === null ? undefined : formatDateTime(request.at)}
    >
      {isError ? (
        <StateView
          kind="error"
          title="Could not load this request"
          description="The capture may have expired."
        />
      ) : isLoading || detail === null ? (
        <div
          className="space-y-4"
          role="status"
          aria-live="polite"
          aria-label="Loading request detail"
        >
          <SkeletonText lines={2} />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : (
        <div className="space-y-4">
          {children}
          <Tabs defaultValue="payloads">
            <TabsList>
              <TabsTrigger value="payloads">Payloads</TabsTrigger>
              <TabsTrigger value="route">Route</TabsTrigger>
              <TabsTrigger value="timeline">Timeline</TabsTrigger>
            </TabsList>

            <TabsContent value="payloads" className="mt-4 space-y-3">
              {detail.panels.length === 0 ? (
                <StateView
                  kind="empty"
                  title="No capture"
                  description="This request was not captured, or the capture has expired."
                />
              ) : (
                detail.panels.map((panel) => <PayloadPanel key={panel.stage} panel={panel} />)
              )}
            </TabsContent>

            <TabsContent value="route" className="mt-4">
              <RouteTrace steps={detail.routeTrace} />
            </TabsContent>

            <TabsContent value="timeline" className="mt-4">
              <Timeline steps={detail.timeline} />
            </TabsContent>
          </Tabs>
        </div>
      )}
    </Drawer>
  );
}

/** The at-a-glance header the pages put above the drawer's tabs. */
export function RequestSummary({ request }: { readonly request: RequestDetail['request'] }) {
  const tone = STATUS_TONE(request.status);
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-card border border-border bg-surface-2 p-3 @[420px]:grid-cols-3">
      <Field label="Status">
        <span className="inline-flex items-center gap-1.5">
          <Badge tone={tone} size="sm" dot>
            {request.status}
          </Badge>
          {request.errorKind === null ? null : (
            <span className="truncate text-text-muted">{request.errorKind}</span>
          )}
        </span>
      </Field>
      <Field label="Latency">{formatDurationMs(request.latencyMs)}</Field>
      <Field label="TTFT">
        {request.ttftMs === null ? (
          <Minus aria-hidden="true" className="size-3 text-text-subtle" />
        ) : (
          formatDurationMs(request.ttftMs)
        )}
      </Field>
      <Field label="Tokens">
        {request.inputTokens === null && request.outputTokens === null
          ? '—'
          : `${formatCount(request.inputTokens ?? 0)} in · ${formatCount(request.outputTokens ?? 0)} out`}
      </Field>
      <Field label="Cost">{request.costUsd === null ? '—' : formatUsd(request.costUsd)}</Field>
      <Field label="Streamed">
        <span className="inline-flex items-center gap-1">
          {request.streamed ? (
            <Check aria-hidden="true" className="size-3 text-success" />
          ) : (
            <TriangleAlert aria-hidden="true" className="size-3 text-text-subtle" />
          )}
          {request.streamed ? 'Yes' : 'No'}
        </span>
      </Field>
      <Field label="Provider">{request.providerId ?? '—'}</Field>
      <Field label="Model">{request.model ?? '—'}</Field>
      <Field label="Account">{request.accountId ?? '—'}</Field>
    </dl>
  );
}
