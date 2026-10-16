import { useEffect, useState } from 'react';
import type { WsPreviewFrame } from '@contracts';

import { realtime } from '@web/data/realtime.ts';

/**
 * The latest preview frame for one job, or null while there is not one yet.
 *
 * **Subscribed only while the job is live.** A finished job draws no more frames,
 * and holding a socket open to watch nothing is exactly the cost the channel
 * design exists to avoid. The caller says whether the job is still moving, and
 * the subscription follows it.
 *
 * The frame is keyed by job id on the way in rather than filtered on the way out,
 * because the `preview` channel carries every running job's frames to every
 * subscriber — the hub routes by channel and knows nothing about which job a
 * pane is showing. Dropping the wrong job's frame here is what keeps two open
 * job panels from showing each other's browser.
 */
export function usePreviewFrame(jobId: string | null, live: boolean): WsPreviewFrame | null {
  const [frame, setFrame] = useState<WsPreviewFrame | null>(null);

  useEffect(() => {
    // A frame from the job the operator was looking at a moment ago is not a
    // frame for this one, so it goes before the new subscription starts.
    setFrame(null);
    if (jobId === null || !live) return;

    return realtime.subscribe('preview', (message) => {
      if (message.type !== 'preview_frame') return;
      if (message.jobId !== jobId) return;
      setFrame(message);
    });
  }, [jobId, live]);

  return frame;
}

/** The job statuses that still produce frames. Mirrors the poll's own list. */
export function isLiveJobStatus(status: string): boolean {
  return status === 'queued' || status === 'running' || status === 'needs_manual';
}
