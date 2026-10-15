import {
  BadgeCheck,
  ChartLine,
  Filter,
  FlaskConical,
  Gauge,
  Image,
  KeyRound,
  Layers,
  LayoutDashboard,
  MessageSquare,
  Minimize2,
  Network,
  Package,
  Palette,
  Replace,
  ScrollText,
  Settings,
  Shuffle,
  Smartphone,
  Terminal,
  Upload,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  id: string;
  label: string;
  path: string;
  icon: LucideIcon;
  /** Extra terms the command palette matches on, beyond the label. */
  keywords: readonly string[];
}

export interface NavSection {
  id: string;
  label: string;
  items: readonly NavItem[];
}

/**
 * The navigation is the single source of truth for both the sidebar and the
 * command palette, and it mirrors the page table in PRD §5. Provider Detail
 * (`/providers/:id`) is deliberately absent: it is reached from the catalog,
 * not from the rail.
 */
export const NAV_SECTIONS: readonly NavSection[] = [
  {
    id: 'overview',
    label: 'Overview',
    items: [
      {
        id: 'dashboard',
        label: 'Dashboard',
        path: '/',
        icon: LayoutDashboard,
        keywords: ['home', 'resource', 'uptime', 'latency', 'overview'],
      },
      {
        id: 'usage',
        label: 'Usage & Metrics',
        path: '/usage',
        icon: ChartLine,
        keywords: ['chart', 'requests', 'tokens', 'cost', 'inspector'],
      },
      {
        id: 'console-log',
        label: 'Console Log',
        path: '/console-log',
        icon: Terminal,
        keywords: ['stream', 'tail', 'terminal', 'level', 'debug'],
      },
    ],
  },
  {
    id: 'providers',
    label: 'Providers',
    items: [
      {
        id: 'providers',
        label: 'Provider Catalog',
        path: '/providers',
        icon: Package,
        keywords: ['catalog', 'byok', 'registry', 'base url', 'wire'],
      },
      {
        id: 'models',
        label: 'Model Catalog',
        path: '/models',
        icon: Layers,
        keywords: ['model', 'catalog', 'context', 'vision', 'tools', 'price', 'copy'],
      },
      {
        id: 'accounts',
        label: 'Accounts',
        path: '/accounts',
        icon: Users,
        keywords: ['pool', 'state', 'cooldown', 'in-flight', 'bulk'],
      },
      {
        id: 'quota',
        label: 'Quota Management',
        path: '/quota',
        icon: Gauge,
        keywords: ['credits', 'window', 'reset', 'check-in', 'refresh'],
      },
    ],
  },
  {
    id: 'routing',
    label: 'Routing',
    items: [
      {
        id: 'combos',
        label: 'Combos & Routes',
        path: '/combos',
        icon: Shuffle,
        keywords: ['alias', 'fallback', 'strategy', 'weighted'],
      },
      {
        id: 'model-mapping',
        label: 'Model Mapping',
        path: '/model-mapping',
        icon: Replace,
        keywords: ['rewrite', 'regex', 'exact', 'contains', 'transform'],
      },
      {
        id: 'filter-rules',
        label: 'Filter Rules',
        path: '/filter-rules',
        icon: Filter,
        keywords: ['block', 'redact', 'phase', 'inbound', 'outbound', 'pattern'],
      },
      {
        id: 'token-saver',
        label: 'Token Saver',
        path: '/token-saver',
        icon: Minimize2,
        keywords: ['compress', 'rtk', 'caveman', 'tsc', 'dcp', 'cache', 'tokens', 'savings'],
      },
      {
        id: 'api-keys',
        label: 'API Keys',
        path: '/api-keys',
        icon: KeyRound,
        keywords: ['token', 'scope', 'expiry', 'tps', 'budget', 'denylist'],
      },
    ],
  },
  {
    id: 'automation',
    label: 'Automation',
    items: [
      {
        id: 'automation',
        label: 'Automation',
        path: '/automation',
        icon: Upload,
        keywords: [
          'bulk',
          'import',
          'login',
          'register',
          'token',
          'captcha',
          'preview',
          'concurrency',
        ],
      },
      {
        id: 'automation-logs',
        label: 'Automation Logs',
        path: '/automation/logs',
        icon: ScrollText,
        keywords: ['job', 'history', 'step', 'screenshot'],
      },
      {
        id: 'proxy',
        label: 'Proxy Pool',
        path: '/proxy',
        icon: Network,
        keywords: ['socks5', 'http connect', 'egress', 'health'],
      },
      {
        id: 'sms-providers',
        label: 'SMS Providers',
        path: '/sms-providers',
        icon: Smartphone,
        keywords: ['activation', '5sim', 'number', 'otp', 'code', 'rent', 'balance'],
      },
    ],
  },
  {
    id: 'tools',
    label: 'Tools',
    items: [
      {
        id: 'chat',
        label: 'Chat',
        path: '/chat',
        icon: MessageSquare,
        keywords: ['playground', 'streaming', 'session', 'prompt'],
      },
      {
        id: 'studio',
        label: 'Studio',
        path: '/studio',
        icon: Image,
        keywords: ['image', 'video', 'generate', 'gallery', 'canvas'],
      },
      {
        id: 'benchmark',
        label: 'Benchmark',
        path: '/benchmark',
        icon: FlaskConical,
        keywords: ['variant', 'template', 'ttft', 'quality', 'score'],
      },
      {
        id: 'verification',
        label: 'Model Verification',
        path: '/verification',
        icon: BadgeCheck,
        keywords: ['authenticity', 'fingerprint', 'probe', 'posterior', 'verdict'],
      },
      {
        id: 'tools',
        label: 'Tools',
        path: '/tools',
        icon: Wrench,
        keywords: ['dot trick', 'vcc', 'luhn', 'bin'],
      },
      {
        id: 'cli-tools',
        label: 'CLI Tools',
        path: '/cli-tools',
        icon: Terminal,
        keywords: [
          'codex',
          'cline',
          'opencode',
          'continue',
          'config',
          'snippet',
          'base url',
          'client',
        ],
      },
    ],
  },
  {
    id: 'system',
    label: 'System',
    items: [
      {
        id: 'customization',
        label: 'Customization',
        path: '/customization',
        icon: Palette,
        keywords: ['branding', 'background', 'glass', 'glow', 'theme'],
      },
      {
        id: 'settings',
        label: 'Settings',
        path: '/settings',
        icon: Settings,
        keywords: ['security', 'backup', 'restore', 'preferences'],
      },
    ],
  },
];

/** Flat view of the rail, in the order it renders. */
export const NAV_ITEMS: readonly NavItem[] = NAV_SECTIONS.flatMap((section) => section.items);

/**
 * Which rail entry owns the current URL. The *longest* match wins, so
 * `/automation/logs` beats `/automation` and `/providers/abc` still highlights
 * Provider Catalog.
 */
export function activeNavPath(pathname: string): string | null {
  let best: string | null = null;
  for (const item of NAV_ITEMS) {
    const matches =
      item.path === '/'
        ? pathname === '/'
        : pathname === item.path || pathname.startsWith(`${item.path}/`);
    if (matches && (best === null || item.path.length > best.length)) best = item.path;
  }
  return best;
}

/** The nav entry that owns `pathname`, for the topbar's window title. */
export function activeNavItem(pathname: string): NavItem | undefined {
  const path = activeNavPath(pathname);
  return path === null ? undefined : NAV_ITEMS.find((item) => item.path === path);
}

/** The section a given item belongs to, for breadcrumbs and palette grouping. */
export function navSectionOf(item: NavItem): NavSection | undefined {
  return NAV_SECTIONS.find((section) => section.items.includes(item));
}
