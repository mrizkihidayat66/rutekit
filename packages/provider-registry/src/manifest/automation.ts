import { z } from 'zod';

/**
 * What the browser worker does to turn a fresh account into a usable one.
 *
 * Deliberately thin, and deliberately not a script. The worker runs outside the
 * server process: it drives a real browser over a previewed X display, and a
 * challenge it cannot solve is handed to a human who is watching that display.
 * So a manifest describes the flow in the terms that human needs — where it
 * starts, whether a challenge is expected, how long to wait — and nothing about
 * how the page is driven. Selectors and steps live in the worker, where they can
 * change without a provider definition changing.
 *
 * `humanTimeoutSeconds` is the pause before an unanswered challenge is treated as
 * a failure and the attempt is retried. Without it the worker would wait forever
 * on a display nobody is looking at, holding an account slot for nothing.
 */
export const automationSchema = z.object({
  login: z.enum(['browser', 'device-code']),
  /** Page the previewer opens to start sign-up or sign-in. */
  startUrl: z.url(),
  /** True when the flow shows a challenge a human has to solve in the previewer. */
  captcha: z.boolean().default(false),
  humanTimeoutSeconds: z.number().int().positive().default(180),
});

export type Automation = z.infer<typeof automationSchema>;
