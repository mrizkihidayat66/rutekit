import {
  AlertTriangle,
  ArrowRight,
  Copy,
  Plus,
  Search,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { ThemeToggle } from '@web/components/ThemeToggle.tsx';
import { Badge, type BadgeTone } from '@web/components/ui/Badge.tsx';
import { Button } from '@web/components/ui/Button.tsx';
import type { ButtonSize, ButtonVariant } from '@web/components/ui/button-variants.ts';
import { Card, CardBody, CardFooter, CardHeader } from '@web/components/ui/Card.tsx';
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@web/components/ui/Dialog.tsx';
import { Drawer } from '@web/components/ui/Drawer.tsx';
import { Field } from '@web/components/ui/Field.tsx';
import { Input } from '@web/components/ui/Input.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '@web/components/ui/Popover.tsx';
import { SimpleSelect } from '@web/components/ui/Select.tsx';
import { Skeleton, SkeletonText } from '@web/components/ui/Skeleton.tsx';
import { Slider } from '@web/components/ui/Slider.tsx';
import { StateView, type StateKind } from '@web/components/ui/StateView.tsx';
import { Switch } from '@web/components/ui/Switch.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@web/components/ui/Tabs.tsx';
import { Textarea } from '@web/components/ui/Textarea.tsx';
import { Tooltip } from '@web/components/ui/Tooltip.tsx';
import { cn } from '@web/lib/cn.ts';
import type { CSSVars } from '@web/lib/css-vars.ts';

const COLOR_TOKENS = [
  { token: 'page', label: 'Page' },
  { token: 'surface-1', label: 'Surface 1' },
  { token: 'surface-2', label: 'Surface 2' },
  { token: 'surface-3', label: 'Surface 3' },
  { token: 'border', label: 'Border' },
  { token: 'border-strong', label: 'Border strong' },
  { token: 'text', label: 'Text' },
  { token: 'text-muted', label: 'Text muted' },
  { token: 'text-subtle', label: 'Text subtle' },
  { token: 'accent', label: 'Accent' },
  { token: 'accent-contrast', label: 'Accent contrast' },
  { token: 'success', label: 'Success' },
  { token: 'danger', label: 'Danger' },
  { token: 'warning', label: 'Warning' },
  { token: 'info', label: 'Info' },
  { token: 'focus', label: 'Focus' },
] as const;

const STATE_TOKENS = [
  'active',
  'banned',
  'disabled',
  'exhausted',
  'error',
  'pending',
  'rate-limited',
] as const;

const RADIUS_TOKENS = [
  { token: 'control', label: 'Control · 10px' },
  { token: 'card', label: 'Card · 18px' },
  { token: 'sidebar', label: 'Sidebar · 20px' },
  { token: 'pill', label: 'Pill · 9999px' },
] as const;

const SHADOWS = [
  { token: 'card', label: 'card' },
  { token: 'popover', label: 'popover' },
  { token: 'dialog', label: 'dialog' },
  { token: 'glow', label: 'glow' },
] as const;

const ANIMATIONS = [
  { token: 'fade-in', label: 'fade-in' },
  { token: 'scale-in', label: 'scale-in' },
  { token: 'slide-up', label: 'slide-up' },
  { token: 'rise', label: 'rise' },
  { token: 'pulse-soft', label: 'pulse-soft' },
  { token: 'spin-slow', label: 'spin-slow' },
] as const;

const BUTTON_VARIANTS: ButtonVariant[] = ['primary', 'secondary', 'outline', 'ghost', 'danger'];
const BUTTON_SIZES: ButtonSize[] = ['sm', 'md', 'lg', 'icon'];
const BADGE_TONES: BadgeTone[] = ['neutral', 'accent', 'success', 'danger', 'warning', 'info'];
const STATE_KINDS: StateKind[] = ['empty', 'no-results', 'loading', 'error', 'offline', 'locked'];

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-6">
      <div className="mb-3">
        <h2 className="font-head text-lg font-semibold tracking-tight text-text">{title}</h2>
        {description ? <p className="mt-0.5 text-xs text-text-muted">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Swatch({ token, label }: { token: string; label: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div
        className="h-14 rounded-control border border-border bg-(--swatch)"
        style={{ '--swatch': `var(--color-${token})` } as CSSVars}
      />
      <div className="flex flex-col leading-tight">
        <span className="text-xs font-medium text-text">{label}</span>
        <span className="font-mono text-[0.6875rem] text-text-subtle">{token}</span>
      </div>
    </div>
  );
}

function MotionSample({ token, label, replayKey }: { token: string; label: string; replayKey: number }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="flex h-16 w-full items-center justify-center rounded-card border border-border bg-surface-2">
        <span
          key={replayKey}
          className={cn('size-7 rounded-control bg-accent', `animate-${token}`)}
        />
      </div>
      <span className="font-mono text-[0.6875rem] text-text-subtle">{label}</span>
    </div>
  );
}

export function DesignShowcase() {
  const [replayKey, setReplayKey] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [selectValue, selectSet] = useState('balanced');
  const [switchOn, setSwitchOn] = useState(true);
  const [slider, setSlider] = useState<number[]>([35, 72]);

  return (
    <div className="min-h-dvh bg-page">
      <header className="sticky top-0 z-sticky border-b border-border bg-page/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-5">
          <div className="flex items-center gap-2.5">
            <span className="flex size-8 items-center justify-center rounded-control bg-accent text-accent-contrast">
              <Sparkles className="size-4" aria-hidden="true" />
            </span>
            <div className="leading-tight">
              <p className="font-head text-sm font-semibold text-text">rutekit design system</p>
              <p className="text-[0.6875rem] text-text-subtle">
                Every token and primitive, in both themes
              </p>
            </div>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto flex max-w-6xl flex-col gap-10 px-5 py-8">
        <Section
          id="colour"
          title="Colour"
          description="Semantic roles only — components never name a hue. Flip the theme above; nothing below re-renders differently."
        >
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
            {COLOR_TOKENS.map((entry) => (
              <Swatch key={entry.token} token={entry.token} label={entry.label} />
            ))}
          </div>
          <div className="mt-5">
            <p className="mb-2 text-xs font-medium text-text-muted">Account pool states</p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
              {STATE_TOKENS.map((token) => (
                <Swatch key={token} token={`state-${token}`} label={token} />
              ))}
            </div>
          </div>
        </Section>

        <Section id="typography" title="Typography" description="Inter for UI, Space Grotesk for headings, Geist Mono for identifiers. Numerals are tabular wherever they align in columns.">
          <Card className="flex flex-col gap-4">
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
              <span className="font-head text-3xl font-semibold tracking-tight text-text">Display</span>
              <span className="font-head text-xl font-semibold tracking-tight text-text">Heading</span>
              <span className="text-base font-medium text-text">Title</span>
              <span className="text-sm text-text">Body</span>
              <span className="text-xs text-text-muted">Caption</span>
              <span className="text-[0.6875rem] text-text-subtle">Micro</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-border pt-4">
              <span className="font-mono text-sm text-text">gpt-4o-mini</span>
              <span className="font-mono text-xs text-text-muted">sk-rt-••••••4f2a</span>
              <span className="tnum text-sm text-text">1,284,902</span>
              <span className="tnum text-sm text-text-muted">42.8 ms · 118 tps</span>
            </div>
          </Card>
        </Section>

        <Section id="radius" title="Radius" description="Four steps, nothing between them.">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {RADIUS_TOKENS.map((entry) => (
              <div key={entry.token} className="flex flex-col gap-1.5">
                <div
                  className="h-16 rounded-(--r) border border-border bg-surface-2"
                  style={{ '--r': `var(--radius-${entry.token})` } as CSSVars}
                />
                <span className="font-mono text-[0.6875rem] text-text-subtle">{entry.label}</span>
              </div>
            ))}
          </div>
        </Section>

        <Section id="elevation" title="Elevation" description="Surfaces stack page → 1 → 2 → 3; shadows only ever deepen.">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {SHADOWS.map((entry) => (
              <div key={entry.token} className="flex flex-col gap-2">
                <div
                  className="flex h-20 items-center justify-center rounded-card border border-border bg-surface-3 shadow-(--sh)"
                  style={{ '--sh': `var(--shadow-${entry.token})` } as CSSVars}
                >
                  <span className="font-mono text-xs text-text-muted">{entry.label}</span>
                </div>
              </div>
            ))}
          </div>
        </Section>

        <Section id="motion" title="Motion" description="Named animations on a shared easing scale. Reduced motion collapses every one of these to an instant change.">
          <Card>
            <CardHeader
              title="Animation samples"
              description="Durations come from --dur-fast / --dur-micro / --dur-macro / --dur-slow."
              actions={
                <Button variant="secondary" size="sm" onClick={() => setReplayKey((n) => n + 1)}>
                  Replay
                </Button>
              }
            />
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
              {ANIMATIONS.map((entry) => (
                <MotionSample
                  key={entry.token}
                  token={entry.token}
                  label={entry.label}
                  replayKey={replayKey}
                />
              ))}
            </div>
          </Card>
        </Section>

        <Section id="buttons" title="Buttons" description="Five variants, four sizes, plus loading and disabled.">
          <Card className="flex flex-col gap-5">
            <div className="flex flex-wrap items-center gap-2">
              {BUTTON_VARIANTS.map((variant) => (
                <Button key={variant} variant={variant}>
                  {variant}
                </Button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-border pt-5">
              {BUTTON_SIZES.map((size) =>
                size === 'icon' ? (
                  <Tooltip key={size} content="Icon button">
                    <Button size="icon" variant="secondary" aria-label="Add">
                      <Plus className="size-4" aria-hidden="true" />
                    </Button>
                  </Tooltip>
                ) : (
                  <Button key={size} size={size} variant="secondary">
                    Size {size}
                  </Button>
                ),
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-border pt-5">
              <Button loading>Saving</Button>
              <Button variant="danger" loading>
                Deleting
              </Button>
              <Button disabled>Disabled</Button>
              <Button variant="secondary" disabled>
                Disabled
              </Button>
            </div>
          </Card>
        </Section>

        <Section id="badges" title="Badges" description="Six tones, with optional dot and pulse for live states.">
          <Card className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              {BADGE_TONES.map((tone) => (
                <Badge key={tone} tone={tone}>
                  {tone}
                </Badge>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
              <Badge tone="success" dot pulse>
                live
              </Badge>
              <Badge tone="warning" dot>
                rate limited
              </Badge>
              <Badge tone="danger" icon={<AlertTriangle className="size-3" aria-hidden="true" />}>
                banned
              </Badge>
              <Badge size="sm" tone="info">
                sm
              </Badge>
              <Badge tone="neutral" icon={<Copy className="size-3" aria-hidden="true" />}>
                copied
              </Badge>
            </div>
          </Card>
        </Section>

        <Section id="forms" title="Form controls" description="Every control shares one focus treatment and one invalid treatment.">
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="flex flex-col gap-4">
              <CardHeader title="Text inputs" />
              <Field label="Display name" description="Shown in the sidebar and logs.">
                {(ids) => <Input id={ids.id} aria-describedby={ids.describedBy} placeholder="rutekit" />}
              </Field>
              <Field label="Search" hint="⌘K">
                {(ids) => (
                  <Input
                    id={ids.id}
                    aria-describedby={ids.describedBy}
                    placeholder="Find a model…"
                    leading={<Search aria-hidden="true" />}
                  />
                )}
              </Field>
              <Field label="Base URL" error="Must start with https://">
                {(ids) => (
                  <Input
                    id={ids.id}
                    aria-describedby={ids.describedBy}
                    invalid
                    defaultValue="http://api.example.com"
                  />
                )}
              </Field>
              <Field label="Notes">
                {(ids) => (
                  <Input id={ids.id} aria-describedby={ids.describedBy} disabled value="Read only" />
                )}
              </Field>
            </Card>

            <Card className="flex flex-col gap-4">
              <CardHeader title="Textarea, select, switch, slider" />
              <Field label="System prompt" hint="0 / 4000">
                {(ids) => (
                  <Textarea
                    id={ids.id}
                    aria-describedby={ids.describedBy}
                    autoGrow
                    rows={3}
                    placeholder="You are a helpful assistant…"
                  />
                )}
              </Field>
              <Field label="Routing strategy">
                {() => (
                  <SimpleSelect
                    aria-label="Routing strategy"
                    className="mt-0"
                    value={selectValue}
                    onValueChange={selectSet}
                    options={[
                      { value: 'balanced', label: 'Balanced' },
                      { value: 'cheapest', label: 'Cheapest first' },
                      { value: 'fastest', label: 'Lowest latency' },
                      { value: 'quality', label: 'Highest quality' },
                      { value: 'sticky', label: 'Sticky session', disabled: true },
                    ]}
                  />
                )}
              </Field>
              <Field label="Auto-retry on failure">
                {() => (
                  <div className="flex h-9 items-center">
                    <Switch checked={switchOn} onCheckedChange={setSwitchOn} aria-label="Auto-retry" />
                  </div>
                )}
              </Field>
              <Field label="Temperature / Top-p">
                {() => (
                  <div className="flex h-9 items-center gap-3">
                    <Slider values={slider} onValueChange={setSlider} min={0} max={100} step={1} aria-label="Sampling" />
                    <span className="tnum shrink-0 text-xs text-text-muted">
                      {slider[0]} · {slider[1]}
                    </span>
                  </div>
                )}
              </Field>
            </Card>
          </div>
        </Section>

        <Section id="tabs" title="Tabs" description="Segmented for in-card switching, underline for page-level sections.">
          <Card>
            <Tabs defaultValue="segmented">
              <TabsList>
                <TabsTrigger value="segmented">Segmented</TabsTrigger>
                <TabsTrigger value="underline">Underline</TabsTrigger>
                <TabsTrigger value="disabled" disabled>
                  Disabled
                </TabsTrigger>
              </TabsList>
              <TabsContent value="segmented" className="pt-4">
                <Tabs defaultValue="overview" className="flex flex-col gap-3">
                  <TabsList variant="underline">
                    <TabsTrigger variant="underline" value="overview">
                      Overview
                    </TabsTrigger>
                    <TabsTrigger variant="underline" value="logs">
                      Logs
                    </TabsTrigger>
                    <TabsTrigger variant="underline" value="settings">
                      Settings
                    </TabsTrigger>
                  </TabsList>
                  <TabsContent value="overview" className="text-sm text-text-muted">
                    Underline tabs sit flush on the section rule.
                  </TabsContent>
                  <TabsContent value="logs" className="text-sm text-text-muted">
                    Logs panel.
                  </TabsContent>
                  <TabsContent value="settings" className="text-sm text-text-muted">
                    Settings panel.
                  </TabsContent>
                </Tabs>
              </TabsContent>
              <TabsContent value="underline" className="pt-4 text-sm text-text-muted">
                The same primitives, driven by the outer segmented list.
              </TabsContent>
            </Tabs>
          </Card>
        </Section>

        <Section id="overlays" title="Overlays" description="Tooltip, popover, dialog and drawer — all on one focus/escape/restore contract.">
          <Card className="flex flex-wrap items-center gap-3">
            <Tooltip content="Tooltips carry one line, never a paragraph">
              <Button variant="secondary">Hover me</Button>
            </Tooltip>

            <Popover>
              <PopoverTrigger asChild>
                <Button variant="secondary">Open popover</Button>
              </PopoverTrigger>
              <PopoverContent className="w-64">
                <p className="text-sm font-medium text-text">Popover</p>
                <p className="mt-1 text-xs text-text-muted">
                  Anchored, dismissable on escape and outside click.
                </p>
                <Button size="sm" className="mt-3">
                  Confirm
                </Button>
              </PopoverContent>
            </Popover>

            <Dialog>
              <DialogTrigger asChild>
                <Button variant="secondary">Open dialog</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Delete provider</DialogTitle>
                  <DialogDescription>
                    This removes the provider and every account bound to it. It cannot be undone.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button variant="secondary">Cancel</Button>
                  <Button variant="danger">Delete</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <Button variant="secondary" onClick={() => setConfirmOpen(true)}>
              Confirm dialog
            </Button>

            <Button variant="secondary" onClick={() => setDrawerOpen(true)}>
              Open drawer
            </Button>

            <ConfirmDialog
              open={confirmOpen}
              onOpenChange={setConfirmOpen}
              title="Revoke API key?"
              description="Requests using this key will start failing immediately."
              confirmLabel="Revoke key"
              destructive
              onConfirm={() => undefined}
            />

            <Drawer
              open={drawerOpen}
              onOpenChange={setDrawerOpen}
              title="Manual captcha"
              description="Automation paused · 1 of 3 attempts"
              side="right"
              width="md"
              footer={
                <>
                  <Button variant="ghost" size="sm" onClick={() => setDrawerOpen(false)}>
                    Skip
                  </Button>
                  <Button size="sm">Submit solution</Button>
                </>
              }
            >
              <div className="flex flex-col gap-3">
                <div className="flex h-40 items-center justify-center rounded-card border border-border bg-surface-2 text-xs text-text-subtle">
                  live xvfb preview
                </div>
                <Field label="Solution">
                  {(ids) => <Input id={ids.id} placeholder="Type the characters shown" />}
                </Field>
              </div>
            </Drawer>
          </Card>
        </Section>

        <Section id="loading" title="Loading" description="Skeletons mirror the shape of the content they replace, never a spinner on a blank page.">
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="flex flex-col gap-3">
              <Skeleton shape="title" />
              <SkeletonText lines={3} />
            </Card>
            <Card className="flex flex-col gap-3">
              <div className="flex items-center gap-3">
                <Skeleton shape="circle" />
                <div className="flex flex-1 flex-col gap-2">
                  <Skeleton shape="text" />
                  <Skeleton shape="text" className="w-1/2" />
                </div>
              </div>
              <Skeleton shape="metric" />
            </Card>
            <Card className="flex flex-col gap-3">
              <Skeleton shape="block" />
            </Card>
          </div>
        </Section>

        <Section id="states" title="Empty & error states" description="One component, six presets, so nothing to render never looks improvised.">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {STATE_KINDS.map((kind) => (
              <Card key={kind} flush className="overflow-hidden">
                <StateView
                  kind={kind}
                  {...(kind === 'error'
                    ? { action: <Button size="sm" variant="secondary">Retry</Button> }
                    : {})}
                />
              </Card>
            ))}
          </div>
        </Section>

        <Section id="cards" title="Cards" description="Flat and raised, with the standard header/body/footer composition.">
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader
                title="Provider health"
                description="Rolling 24h window"
                actions={<Badge tone="success" dot>3 healthy</Badge>}
              />
              <CardBody className="flex flex-col gap-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-text-muted">Success rate</span>
                  <span className="tnum text-text">99.2%</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-text-muted">p95 latency</span>
                  <span className="tnum text-text">812 ms</span>
                </div>
              </CardBody>
              <CardFooter>
                <Button variant="ghost" size="sm">
                  View detail
                </Button>
                <Button size="sm">
                  Configure
                  <ArrowRight className="size-3.5" aria-hidden="true" />
                </Button>
              </CardFooter>
            </Card>

            <Card elevation="raised" className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-text">Raised surface</p>
                <Button variant="ghost" size="icon" aria-label="Delete">
                  <Trash2 className="size-4" aria-hidden="true" />
                </Button>
              </div>
              <p className="text-xs text-text-muted">
                Sits on surface-3 with the popover shadow — the same treatment menus and palettes use.
              </p>
            </Card>
          </div>
        </Section>
      </main>
    </div>
  );
}
