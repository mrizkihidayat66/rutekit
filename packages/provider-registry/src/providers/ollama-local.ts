import type { ProviderManifestInput } from '../manifest.ts';

/**
 * A local runner that happens to speak the OpenAI wire, which is why it needs
 * no translator: the daemon exposes `/v1/models` and `/v1/chat/completions`
 * and rutekit treats it as an ordinary provider with an unusual address.
 */
export const ollamaLocal: ProviderManifestInput = {
  id: 'ollama-local',
  name: 'Ollama (local)',
  description: 'Local model runner with an OpenAI-compatible endpoint.',
  category: 'local',
  icon: 'hard-drive',
  docsUrl: 'https://ollama.com/docs',
  freeTier: true,

  endpoint: {
    baseUrl: 'http://127.0.0.1:11434/v1',
    wireFamily: 'openai',
    chatPath: '/chat/completions',
  },

  authModes: [{ mode: 'none' }],

  capabilities: {
    quota: false,
    oauth: false,
    automation: false,
    streaming: true,
    vision: true,
    tools: true,
  },

  discovery: { strategy: 'openai', path: '/models', requiresCredential: false },

  models: [
    {
      id: 'llama3.2:3b',
      contextWindow: 128_000,
      maxOutputTokens: 4000,
      capabilities: { tools: true },
    },
    {
      id: 'qwen2.5:14b',
      contextWindow: 32_000,
      maxOutputTokens: 4000,
      capabilities: { tools: true },
    },
    {
      id: 'llava:13b',
      contextWindow: 4000,
      maxOutputTokens: 4000,
      capabilities: { vision: true },
    },
    {
      id: 'nomic-embed-text',
      capabilities: { embedding: true },
    },
  ],

  quota: { kind: 'none', reason: 'A local runner has no account and no allowance to check.' },

  errors: [],
};
