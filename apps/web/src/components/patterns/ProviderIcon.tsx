import {
  AudioLines,
  Bot,
  Box,
  Boxes,
  Brain,
  BrainCircuit,
  Cloud,
  Compass,
  Cpu,
  Droplet,
  Flame,
  Gem,
  Globe,
  HardDrive,
  Hexagon,
  Image,
  Layers,
  Monitor,
  Moon,
  Plug,
  Route,
  Search,
  Server,
  Sparkles,
  Terminal,
  Wind,
  Workflow,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';

import { cn } from '@web/lib/cn.ts';

/**
 * The provider icon map.
 *
 * A provider stores an icon *slug*, never a URL (contracts: `providerSchema.icon`),
 * so the console can keep its own artwork: the catalog is self-hosted and must
 * not phone home to render a card, and an operator-supplied string can never
 * become an image request to somewhere unexpected.
 *
 * The slugs are the curated catalog's own, one per glyph. An unknown slug — a
 * BYOK provider naming something we do not ship — falls back to a neutral box
 * rather than rendering nothing, so a card never loses its shape.
 */

const ICONS: Record<string, LucideIcon> = {
  'audio-lines': AudioLines,
  bot: Bot,
  box: Box,
  boxes: Boxes,
  brain: Brain,
  'brain-circuit': BrainCircuit,
  cloud: Cloud,
  compass: Compass,
  cpu: Cpu,
  droplet: Droplet,
  flame: Flame,
  gem: Gem,
  globe: Globe,
  'hard-drive': HardDrive,
  hexagon: Hexagon,
  image: Image,
  layers: Layers,
  monitor: Monitor,
  moon: Moon,
  plug: Plug,
  route: Route,
  search: Search,
  server: Server,
  sparkles: Sparkles,
  terminal: Terminal,
  wind: Wind,
  workflow: Workflow,
  x: X,
  zap: Zap,
};

const FALLBACK = Box;

/** Every slug the map knows, for the BYOK wizard's icon picker. */
export const PROVIDER_ICON_SLUGS: readonly string[] = Object.keys(ICONS);

type IconSize = 'sm' | 'md' | 'lg';

const TILE: Record<IconSize, string> = {
  sm: 'size-8 rounded-control',
  md: 'size-10 rounded-control',
  lg: 'size-14 rounded-card',
};

const GLYPH: Record<IconSize, string> = {
  sm: 'size-4',
  md: 'size-5',
  lg: 'size-7',
};

export interface ProviderIconProps {
  /** The provider's icon slug. */
  readonly icon: string;
  readonly size?: IconSize;
  /** Rendered muted; set false when the tile sits on an accent surface. */
  readonly muted?: boolean;
  readonly className?: string;
}

export function ProviderIcon({ icon, size = 'md', muted = true, className }: ProviderIconProps) {
  const Glyph = ICONS[icon] ?? FALLBACK;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center border border-border bg-surface-2',
        muted ? 'text-text-muted' : 'text-text',
        TILE[size],
        className,
      )}
    >
      <Glyph aria-hidden="true" className={GLYPH[size]} />
    </span>
  );
}
