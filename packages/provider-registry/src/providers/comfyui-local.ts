import type { ProviderManifestInput } from '../manifest.ts';

/**
 * The counter-example: no credential, no quota, no catalogue to ask for.
 *
 * ComfyUI is a workflow runner rather than a chat API, so it has no wire dialect
 * rutekit recognises — `wireFamily: 'custom'` is the honest answer, and the
 * translator for it is a later group's problem. Its "models" are checkpoint files
 * the operator installed, which is why discovery is `static`: there is no listing
 * endpoint to call, and the curated list is the only list.
 *
 * Nothing here is priced per token, so both price fields stay null rather than
 * zero — a checkpoint has no per-token cost, and zero would read as "free".
 */
export const comfyuiLocal: ProviderManifestInput = {
  id: 'comfyui-local',
  name: 'ComfyUI (local)',
  description: 'Your own ComfyUI instance, driven over its websocket API.',
  category: 'local',
  icon: 'workflow',
  docsUrl: 'https://docs.comfy.org',
  freeTier: true,

  endpoint: {
    baseUrl: 'http://127.0.0.1:8188',
    wireFamily: 'custom',
    chatPath: null,
  },

  // A local runner has nothing to paste and no sign-in to run; `none` is a real
  // mode here, not a missing one.
  authModes: [{ mode: 'none' }],

  capabilities: {
    quota: false,
    oauth: false,
    automation: false,
    streaming: true,
    vision: true,
    tools: true,
  },

  discovery: { strategy: 'static', requiresCredential: false },

  models: [
    {
      id: 'sd_xl_base_1.0.safetensors',
      displayName: 'SDXL Base 1.0',
      capabilities: { vision: true },
    },
    {
      id: 'flux1-dev.safetensors',
      displayName: 'FLUX.1 dev',
      capabilities: { vision: true },
    },
    {
      id: 'wan2.2_t2v_14B.safetensors',
      displayName: 'Wan 2.2 T2V 14B',
      capabilities: { vision: true },
    },
  ],

  // A local process has no account and no allowance, which is a different claim
  // from "we have not written this checker yet" — so the reason is spelled out.
  quota: {
    kind: 'none',
    reason: 'A local runner has no account and no allowance to check.',
  },

  // No HTTP status means anything here: a stopped server refuses the connection
  // rather than answering, and that is the transport's failure to report.
  errors: [],
};
