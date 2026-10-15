import { z } from 'zod';

/**
 * The four client surfaces, named the way the paths name them.
 *
 * A surface is not a dialect: `/v1/chat/completions` and `/v1/responses` are two
 * surfaces over one wire family, and a client picks the surface it already
 * speaks. Routing then decides whether the body can go straight through (the
 * direct route) or has to be pivoted.
 */
export const clientSurfaceSchema = z.enum([
  'chat-completions',
  'messages',
  'responses',
  'completions',
]);

export type ClientSurface = z.infer<typeof clientSurfaceSchema>;
