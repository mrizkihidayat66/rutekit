import { Card, CardHeader } from '@web/components/ui/Card.tsx';

/**
 * A miniature of the console, for judging a background against.
 *
 * The settings on this page apply to the whole app, so the page is already its
 * own preview — but "the whole app" is a poor thing to stare at while dragging a
 * slider, because the thing you are changing is behind everything else. This
 * frame is small, fixed, and sits still: a rail, a topbar and two cards, all
 * built from the same tokens as the real chrome.
 *
 * It is deliberately transparent where the real chrome is not. Every card in the
 * miniature is `bg-surface-1`, which under a glass setting resolves to a
 * translucent tint — so the miniature shows the background *through* the
 * surfaces, which is the entire question the operator is asking.
 */
export function AppearancePreview() {
  return (
    <Card>
      <CardHeader
        title="Preview"
        description="A stand-in for the console, so you can judge the background without hunting for a card."
      />

      <div className="mt-3 rounded-card border border-dashed border-border p-2.5">
        <div className="flex gap-2.5">
          <div className="flex w-16 shrink-0 flex-col gap-2 rounded-control border border-border bg-surface-1 p-2">
            <span className="size-5 rounded-key bg-accent" />
            <span className="h-1.5 w-full rounded-pill bg-surface-3" />
            <span className="h-1.5 w-4/5 rounded-pill bg-surface-3" />
            <span className="h-1.5 w-full rounded-pill bg-surface-3" />
            <span className="h-1.5 w-3/5 rounded-pill bg-surface-3" />
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex h-6 items-center gap-1.5 rounded-control border border-border bg-surface-1 px-2">
              <span className="h-1.5 w-10 rounded-pill bg-surface-3" />
              <span className="ml-auto size-3 rounded-key bg-surface-3" />
            </div>

            <div className="flex flex-col gap-2 rounded-card border border-border bg-surface-1 p-2.5">
              <span className="h-2 w-20 rounded-pill bg-surface-3" />
              <span className="h-1.5 w-full rounded-pill bg-surface-3" />
              <span className="h-1.5 w-4/5 rounded-pill bg-surface-3" />
              <div className="mt-0.5 flex gap-1.5">
                <span className="h-4 w-14 rounded-control bg-accent" />
                <span className="h-4 w-14 rounded-control border border-border bg-surface-2" />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1.5 rounded-card border border-border bg-surface-1 p-2">
                <span className="h-1.5 w-12 rounded-pill bg-surface-3" />
                <span className="h-3 w-16 rounded-key bg-surface-3" />
              </div>
              <div className="flex flex-col gap-1.5 rounded-card border border-border bg-surface-1 p-2">
                <span className="h-1.5 w-12 rounded-pill bg-surface-3" />
                <span className="h-3 w-16 rounded-key bg-surface-3" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}
