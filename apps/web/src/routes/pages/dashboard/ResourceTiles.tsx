import { Cpu, Gauge, HardDrive, MemoryStick, Network, Timer } from 'lucide-react';

import type { SystemStatus } from '@contracts';

import { StatTile } from '@web/components/patterns/StatTile.tsx';
import {
  formatBytes,
  formatDateTime,
  formatDurationMs,
  formatPercent,
  formatRatio,
  formatSpan,
} from '@web/lib/format.ts';
import { cn } from '@web/lib/cn.ts';

import { HEALTH_TONE, averageLatency, usageTone } from './states.ts';

/**
 * The row of counters that answers "is this box healthy right now".
 *
 * Memory and CPU carry a meter because both have a real ceiling the operator
 * needs to see approaching; the rest are plain figures. The thresholds live in
 * `states.ts` rather than inside the tile so every gauge in the console turns
 * amber at the same point.
 */

export interface ResourceTilesProps {
  readonly status: SystemStatus;
  readonly className?: string;
}

export function ResourceTiles({ status, className }: ResourceTilesProps) {
  const { resources } = status;
  const memoryRatio =
    resources.memoryTotalBytes > 0 ? resources.memoryUsedBytes / resources.memoryTotalBytes : 0;
  const cpuRatio = resources.cpuPercent / 100;
  const latency = averageLatency(status.endpoints);
  const proxies = status.health.find((tile) => tile.id === 'proxies');

  return (
    <div className={cn('@container', className)} aria-label="Host and pool resources" role="group">
      <div className="grid grid-cols-1 gap-3 @[520px]:grid-cols-2 @[900px]:grid-cols-3 @[1500px]:grid-cols-6">
        <StatTile
          label="Memory"
          value={formatBytes(resources.memoryUsedBytes)}
          icon={<MemoryStick className="size-4" aria-hidden="true" />}
          tone={usageTone(memoryRatio)}
          meter={memoryRatio}
          detail={`${formatRatio(memoryRatio)} of ${formatBytes(resources.memoryTotalBytes)}`}
        />
        <StatTile
          label="CPU"
          value={formatPercent(resources.cpuPercent, 1)}
          icon={<Cpu className="size-4" aria-hidden="true" />}
          tone={usageTone(cpuRatio)}
          meter={cpuRatio}
          detail={`${resources.platform} · bun ${resources.bunVersion}`}
        />
        <StatTile
          label="Disk"
          value={formatBytes(resources.diskUsedBytes)}
          icon={<HardDrive className="size-4" aria-hidden="true" />}
          detail={`Node ${resources.nodeVersion}`}
        />
        <StatTile
          label="Latency"
          value={latency === null ? '—' : formatDurationMs(latency)}
          icon={<Gauge className="size-4" aria-hidden="true" />}
          detail="Mean across serving endpoints"
        />
        <StatTile
          label="Proxy pool"
          value={proxies?.value ?? '—'}
          icon={<Network className="size-4" aria-hidden="true" />}
          tone={proxies === undefined ? 'neutral' : HEALTH_TONE[proxies.state]}
          detail={proxies?.detail ?? 'No proxy pool configured.'}
        />
        <StatTile
          label="Uptime"
          value={formatSpan(resources.uptimeSeconds)}
          icon={<Timer className="size-4" aria-hidden="true" />}
          detail={`Started ${formatDateTime(status.startedAt)}`}
        />
      </div>
    </div>
  );
}
