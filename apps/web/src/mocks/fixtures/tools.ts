import type {
  Asset,
  BenchmarkAssertion,
  BenchmarkRun,
  ChatSession,
  GenerationJob,
  VccBin,
  VccCard,
  VerificationResult,
} from '@contracts';
import { consolePath, consolePaths } from '@contracts';

import { daysAgo, hoursAgo, minutesAgo } from '../clock.ts';
import type { Rng } from '../random.ts';

/**
 * Tools fixtures are hand-authored rather than rolled, because the point of
 * each one is its *content*, not its count. A chat session with three prose
 * paragraphs exercises nothing; one that ends in a tool call, one carrying a
 * thinking block and one mid-stream with a broken turn is what the Chat page
 * actually has to render.
 */

/**
 * Tiny inline SVG so the gallery has something to draw without binary assets.
 *
 * Exported because the mock also has to *serve* these bytes at the asset's URL:
 * the gallery grid reads `thumbnailUrl`, but the detail view loads the real
 * `url`, and a mock that could not answer that request would leave every
 * full-size preview broken.
 */
export function swatch(hue: number, label: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="384"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 70% 55%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360} 70% 35%)"/></linearGradient></defs><rect width="640" height="384" fill="url(#g)"/><text x="50%" y="52%" fill="white" font-family="sans-serif" font-size="34" text-anchor="middle">${label}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export function buildChatSessions(): ChatSession[] {
  const sessions: ChatSession[] = [
    {
      id: 'chat_refactor_pool',
      title: 'Account pool lease logic',
      providerId: 'anthropic',
      model: '',
      thinkingLevel: 'high',
      systemPrompt: 'You are a senior TypeScript engineer. Prefer small, explicit code over clever abstractions.',
      createdAt: hoursAgo(6),
      updatedAt: minutesAgo(34),
      messages: [
        {
          id: 'msg_rp_1',
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Here is the lease function. It hands out an account and marks it rate-limited, but I think there is a race between the read and the write. Can you walk through it and propose a fix?',
            },
          ],
          attachments: [
            { id: 'att_rp_1', kind: 'text', name: 'pool.ts', mimeType: 'text/plain', byteSize: 1840, data: 'export function lease(pool: Account[]) {\n  const free = pool.find((a) => a.state === "active");\n  if (!free) return null;\n  free.state = "rate_limited";\n  return free;\n}', width: null, height: null },
          ],
          meta: null,
          parentMessageId: null,
          createdAt: minutesAgo(36),
        },
        {
          id: 'msg_rp_2',
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              text: 'The user is right. `find` then mutate is a check-then-act; two concurrent callers can both observe the same free account. The fix is to make selection and marking atomic — either a mutex around the pool or a compare-and-set on the account state.',
              signature: null,
            },
            {
              type: 'text',
              text: 'Yes — `find` followed by a mutation is a check-then-act race. Two callers can both see the same `active` account before either writes.\n\nMake selection and marking one step: claim by flipping the state inside a single synchronous critical section, and only return the account if the flip actually happened.',
            },
            {
              type: 'tool_use',
              id: 'tu_rp_1',
              name: 'read_file',
              input: { path: 'packages/core/src/pool/lease.ts' },
            },
          ],
          attachments: [],
          meta: {
            ttftMs: 612,
            totalMs: 4_180,
            tokensPerSecond: 61.4,
            usage: { inputTokens: 1_284, outputTokens: 412, cachedInputTokens: 0, reasoningTokens: 180, totalTokens: 1_696 },
            finishReason: 'tool_calls',
            providerId: 'anthropic',
            model: '',
          },
          parentMessageId: null,
          createdAt: minutesAgo(34),
        },
      ],
    },
    {
      id: 'chat_combo_strategy',
      title: 'Weighted combo selection',
      providerId: 'openai',
      model: 'o3',
      thinkingLevel: 'medium',
      systemPrompt: null,
      createdAt: daysAgo(1),
      updatedAt: hoursAgo(20),
      messages: [
        {
          id: 'msg_cs_1',
          role: 'user',
          content: [{ type: 'text', text: 'For a round-robin combo with weights, should the weight influence ordering or selection probability?' }],
          attachments: [],
          meta: null,
          parentMessageId: null,
          createdAt: hoursAgo(21),
        },
        {
          id: 'msg_cs_2',
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'Probability, not ordering. Ordering would make the weight a tie-break and the highest-weight entry would win every time it is healthy. Weighted selection keeps the ratio stable over many requests, which is the property you actually want from a fleet.',
            },
          ],
          attachments: [],
          meta: {
            ttftMs: 2_940,
            totalMs: 11_600,
            tokensPerSecond: 38.2,
            usage: { inputTokens: 96, outputTokens: 388, cachedInputTokens: 0, reasoningTokens: 1_240, totalTokens: 1_724 },
            finishReason: 'stop',
            providerId: 'openai',
            model: 'o3',
          },
          parentMessageId: null,
          createdAt: hoursAgo(20),
        },
      ],
    },
    {
      id: 'chat_vision_chart',
      title: 'Reading a screenshot',
      providerId: 'openai',
      model: 'gpt-4o',
      thinkingLevel: 'auto',
      systemPrompt: null,
      createdAt: daysAgo(3),
      updatedAt: daysAgo(3),
      messages: [
        {
          id: 'msg_vc_1',
          role: 'user',
          content: [
            { type: 'text', text: 'What trend does this chart show, and roughly when does it inflect?' },
            { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', url: null },
          ],
          attachments: [
            { id: 'att_vc_1', kind: 'image', name: 'latency.png', mimeType: 'image/png', byteSize: 68_401, data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', width: 1280, height: 720 },
          ],
          meta: null,
          parentMessageId: null,
          createdAt: daysAgo(3),
        },
        {
          id: 'msg_vc_2',
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'Latency is flat near 240 ms for the first two thirds of the window, then climbs steeply. The inflection sits just past the 14:00 mark, which lines up with the deploy that widened the pool.',
            },
          ],
          attachments: [],
          meta: {
            ttftMs: 780,
            totalMs: 2_410,
            tokensPerSecond: 74.1,
            usage: { inputTokens: 1_102, outputTokens: 96, cachedInputTokens: 0, reasoningTokens: 0, totalTokens: 1_198 },
            finishReason: 'stop',
            providerId: 'openai',
            model: 'gpt-4o',
          },
          parentMessageId: null,
          createdAt: daysAgo(3),
        },
      ],
    },
    {
      id: 'chat_failed_turn',
      title: 'Embedding batch sizing (interrupted)',
      providerId: 'openai',
      model: 'gpt-4.1',
      thinkingLevel: 'low',
      systemPrompt: null,
      createdAt: daysAgo(5),
      updatedAt: daysAgo(5),
      messages: [
        {
          id: 'msg_ft_1',
          role: 'user',
          content: [{ type: 'text', text: 'What batch size should I use for text-embedding-3-large if I want to stay under 300k tokens per request?' }],
          attachments: [],
          meta: null,
          parentMessageId: null,
          createdAt: daysAgo(5),
        },
        {
          id: 'msg_ft_2',
          role: 'assistant',
          content: [
            { type: 'text', text: 'The model caps a single request at 300,000 tokens across the whole batch, so the safe number depends on your average chunk size rather than the count. At 500 tokens per chunk you would send 600; at 2,000 tokens per chunk, 150.' },
          ],
          attachments: [],
          meta: {
            ttftMs: 402,
            totalMs: 1_980,
            tokensPerSecond: null,
            usage: null,
            finishReason: 'aborted',
            providerId: 'openai',
            model: 'gpt-4.1',
          },
          parentMessageId: null,
          createdAt: daysAgo(5),
        },
      ],
    },
    {
      id: 'chat_local_model',
      title: 'Local model smoke test',
      providerId: 'ollama-local',
      model: 'llama3.1:8b',
      thinkingLevel: 'auto',
      systemPrompt: 'Answer in one sentence.',
      createdAt: daysAgo(9),
      updatedAt: daysAgo(9),
      messages: [
        {
          id: 'msg_lm_1',
          role: 'user',
          content: [{ type: 'text', text: 'Say hello and confirm you are running locally.' }],
          attachments: [],
          meta: null,
          parentMessageId: null,
          createdAt: daysAgo(9),
        },
        {
          id: 'msg_lm_2',
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello — this response came from the model on your own machine, with no network egress.' }],
          attachments: [],
          meta: {
            ttftMs: 188,
            totalMs: 1_240,
            tokensPerSecond: 46.8,
            usage: { inputTokens: 42, outputTokens: 24, cachedInputTokens: 0, reasoningTokens: 0, totalTokens: 66 },
            finishReason: 'stop',
            providerId: 'ollama-local',
            model: 'llama3.1:8b',
          },
          parentMessageId: null,
          createdAt: daysAgo(9),
        },
      ],
    },
    {
      id: 'chat_empty_draft',
      title: 'New chat',
      providerId: null,
      model: null,
      thinkingLevel: 'auto',
      systemPrompt: null,
      createdAt: minutesAgo(3),
      updatedAt: minutesAgo(3),
      messages: [],
    },
  ];

  return sessions;
}

const IMAGE_PROMPTS = [
  { prompt: 'Isometric cutaway of a small data centre, teal and amber palette, soft shadows, product-shot lighting', negative: 'text, watermark, blurry' },
  { prompt: 'Macro photograph of dew on a spider web at sunrise, shallow depth of field', negative: 'harsh contrast' },
  { prompt: 'Flat vector illustration of a routing diagram, three paths converging, muted blues', negative: 'gradients, photorealism' },
  { prompt: 'Studio product render of a matte black gateway appliance, rim light, seamless grey backdrop', negative: 'reflections, text' },
  { prompt: 'Watercolour of a lighthouse in fog, limited palette, visible paper grain', negative: 'hdr, oversaturated' },
  { prompt: 'Technical blueprint of a server rack, cyan lines on navy, annotation callouts', negative: 'shading, perspective' },
];

const VIDEO_PROMPTS = [
  { prompt: 'Slow dolly through a server aisle, blinking status LEDs, cinematic, 24fps', negative: 'people, text' },
  { prompt: 'Timelapse of clouds over a coastal cliff, golden hour, smooth motion', negative: 'camera shake' },
  { prompt: 'Looping abstract gradient waves, deep purple to cyan, seamless', negative: 'banding, text' },
];

export function buildStudio(rng: Rng): { assets: Asset[]; generations: GenerationJob[] } {
  const assets: Asset[] = [];
  const generations: GenerationJob[] = [];

  const plan: readonly { kind: 'image' | 'video'; providerId: string; model: string; status: GenerationJob['status']; promptIndex: number }[] = [
    { kind: 'image', providerId: 'openai', model: 'gpt-image-1', status: 'executed', promptIndex: 0 },
    { kind: 'image', providerId: 'replicate', model: 'black-forest-labs/flux-1.1-pro', status: 'executed', promptIndex: 1 },
    { kind: 'image', providerId: 'fal', model: 'fal-ai/flux/dev', status: 'executed', promptIndex: 2 },
    { kind: 'image', providerId: 'stability', model: 'sd3.5-large', status: 'executed', promptIndex: 3 },
    { kind: 'image', providerId: 'comfyui-local', model: 'flux1-dev.safetensors', status: 'executed', promptIndex: 4 },
    { kind: 'image', providerId: 'openai', model: 'gpt-image-1', status: 'executed', promptIndex: 5 },
    { kind: 'video', providerId: 'replicate', model: 'minimax/video-01', status: 'executed', promptIndex: 0 },
    { kind: 'video', providerId: 'fal', model: 'fal-ai/ltx-video', status: 'executed', promptIndex: 1 },
    { kind: 'video', providerId: 'replicate', model: 'wan-video/wan-2.1-t2v', status: 'executed', promptIndex: 2 },
    { kind: 'image', providerId: 'fal', model: 'fal-ai/flux/dev', status: 'progress', promptIndex: 2 },
    { kind: 'video', providerId: 'replicate', model: 'minimax/video-01', status: 'executing', promptIndex: 0 },
    { kind: 'image', providerId: 'stability', model: 'sd3.5-large', status: 'queued', promptIndex: 4 },
    { kind: 'image', providerId: 'replicate', model: 'black-forest-labs/flux-1.1-pro', status: 'failed', promptIndex: 1 },
    { kind: 'image', providerId: 'fal', model: 'fal-ai/flux/dev', status: 'cancelled', promptIndex: 5 },
  ];

  plan.forEach((entry, index) => {
    const source = entry.kind === 'image' ? IMAGE_PROMPTS : VIDEO_PROMPTS;
    const seedPrompt = source[entry.promptIndex % source.length];
    if (seedPrompt === undefined) return;
    const id = `gen_${String(index + 1).padStart(3, '0')}`;
    const createdAt = hoursAgo(rng.int(1, 240));
    const done = entry.status === 'executed';
    const parameters: Record<string, string | number | boolean> = {
      seed: rng.int(1, 2_147_483_647),
      steps: entry.kind === 'image' ? rng.int(20, 50) : rng.int(12, 30),
      guidance: rng.round(rng.float(2, 9), 1),
      aspect: rng.pick(['1:1', '16:9', '4:3', '9:16']),
    };

    let assetId: string | null = null;
    if (done) {
      assetId = `asset_${String(assets.length + 1).padStart(3, '0')}`;
      const hue = (index * 47) % 360;
      const isVideo = entry.kind === 'video';
      assets.push({
        id: assetId,
        kind: entry.kind,
        url: consolePath(consolePaths.studioAssetFile, { id: assetId }),
        thumbnailUrl: swatch(hue, isVideo ? 'video' : 'image'),
        width: isVideo ? 1280 : 1024,
        height: isVideo ? 720 : 1024,
        durationSeconds: isVideo ? rng.round(rng.float(3, 9), 1) : null,
        mimeType: isVideo ? 'video/mp4' : 'image/png',
        byteSize: isVideo ? rng.int(4_000_000, 24_000_000) : rng.int(400_000, 3_800_000),
        providerId: entry.providerId,
        model: entry.model,
        prompt: seedPrompt.prompt,
        negativePrompt: seedPrompt.negative,
        parameters,
        parentAssetId: null,
        favorite: rng.bool(0.2),
        createdAt,
      });
    }

    generations.push({
      id,
      kind: entry.kind,
      status: entry.status,
      providerId: entry.providerId,
      model: entry.model,
      prompt: seedPrompt.prompt,
      negativePrompt: seedPrompt.negative,
      progress: done ? 1 : entry.status === 'progress' ? rng.round(rng.float(0.15, 0.9), 2) : entry.status === 'executing' ? 0.02 : null,
      stage: done ? 'Complete' : entry.status === 'progress' ? 'Sampling' : entry.status === 'executing' ? 'Loading model' : entry.status === 'queued' ? 'Waiting for a worker' : null,
      assetId,
      error: entry.status === 'failed' ? 'Upstream returned 422: prompt rejected by the safety filter.' : entry.status === 'cancelled' ? 'Cancelled by an operator.' : null,
      parameters,
      createdAt,
      startedAt: entry.status === 'queued' ? null : createdAt,
      finishedAt: done ? minutesAgo(rng.int(30, 1_400)) : null,
    });
  });

  return { assets, generations };
}

const BENCHMARK_TEMPLATE =
  'Summarise the following {{document}} in at most {{words}} words for a {{audience}} audience.\n\n{{document}}';

export function buildBenchmarks(rng: Rng): BenchmarkRun[] {
  const variants = [
    { id: 'var_legal', label: 'Legal, 40 words', prompt: 'Summarise the following contract in at most 40 words for a legal audience.\n\n{…}', variables: { audience: 'legal', words: '40', document: 'contract' } },
    { id: 'var_exec', label: 'Executive, 25 words', prompt: 'Summarise the following report in at most 25 words for a executive audience.\n\n{…}', variables: { audience: 'executive', words: '25', document: 'report' } },
    { id: 'var_teen', label: 'Teen, 60 words', prompt: 'Summarise the following article in at most 60 words for a teenage audience.\n\n{…}', variables: { audience: 'teenage', words: '60', document: 'article' } },
    { id: 'var_tech', label: 'Technical, 80 words', prompt: 'Summarise the following spec in at most 80 words for a technical audience.\n\n{…}', variables: { audience: 'technical', words: '80', document: 'spec' } },
  ];
  const targets = [
    { providerId: 'openai', model: 'gpt-4o-mini' },
    { providerId: 'anthropic', model: '' },
    { providerId: 'google-ai-studio', model: 'gemini-2.0-flash' },
    { providerId: 'groq', model: 'llama-3.3-70b-versatile' },
    { providerId: 'deepseek', model: 'deepseek-chat' },
  ];

  function resultsFor(runStatus: BenchmarkRun['status'], rng: Rng) {
    const results: BenchmarkRun['results'] = [];
    let index = 0;
    for (const variant of variants) {
      for (const target of targets) {
        index += 1;
        const done = runStatus === 'succeeded' || (runStatus === 'running' && index <= 12);
        const failed = runStatus === 'failed' && index === 5;
        const quality = done ? rng.round(rng.float(0.52, 0.97), 3) : null;
        const tps = done ? rng.round(rng.float(18, 140), 1) : null;
        results.push({
          id: `bres_${index}`,
          variantId: variant.id,
          providerId: target.providerId,
          model: target.model,
          status: failed ? 'failed' : done ? 'succeeded' : runStatus === 'queued' ? 'queued' : 'running',
          ttftMs: done ? rng.int(140, 2_600) : null,
          latencyMs: done ? rng.int(700, 9_200) : null,
          outputTokens: done ? rng.int(28, 90) : null,
          tokensPerSecond: tps,
          costUsd: done ? rng.round(rng.float(0.00002, 0.0016), 6) : null,
          qualityScore: quality,
          outputPreview: done
            ? rng.pick([
                'The agreement obliges the vendor to deliver within thirty days and caps liability at fees paid.',
                'Revenue rose 14% quarter on quarter, driven mainly by the self-hosted tier.',
                'Mix the dry ingredients first, then fold in the egg whites until just combined.',
              ])
            : '',
          error: failed ? 'Upstream returned 503 after three retries.' : null,
        });
      }
    }
    return results;
  }

  const plan: readonly {
    name: string;
    status: BenchmarkRun['status'];
    systemPrompt: string | null;
    rubric: BenchmarkAssertion[];
  }[] = [
    {
      name: 'Summarisation matrix (Aug)',
      status: 'succeeded',
      systemPrompt: 'You are a precise summariser. Never exceed the word budget.',
      rubric: [{ kind: 'max_length', value: 600 }],
    },
    {
      name: 'Summarisation matrix (Sep)',
      status: 'running',
      systemPrompt: 'You are a precise summariser. Never exceed the word budget.',
      rubric: [{ kind: 'max_length', value: 600 }],
    },
    { name: 'Code explanation, 5 models', status: 'succeeded', systemPrompt: null, rubric: [] },
    {
      name: 'Tone rewriting sweep',
      status: 'failed',
      systemPrompt: 'Rewrite without changing meaning.',
      rubric: [
        { kind: 'regex', value: '^[A-Z]' },
        { kind: 'max_length', value: 240 },
      ],
    },
    { name: 'Translation spot-check', status: 'queued', systemPrompt: null, rubric: [] },
    { name: 'Reasoning latency probe', status: 'cancelled', systemPrompt: null, rubric: [] },
  ];

  return plan.map((entry, index) => ({
    id: `bench_${String(index + 1).padStart(3, '0')}`,
    name: entry.name,
    status: entry.status,
    template: BENCHMARK_TEMPLATE,
    variants,
    targets,
    results: resultsFor(entry.status, rng),
    expectedResultCount: variants.length * targets.length,
    systemPrompt: entry.systemPrompt,
    rubric: entry.rubric,
    error:
      entry.status === 'failed'
        ? 'promptfoo exited with 1: the run was killed after 30 minutes.'
        : null,
    createdAt: daysAgo(rng.int(2, 60)),
    startedAt: entry.status === 'queued' ? null : daysAgo(rng.int(1, 55)),
    finishedAt: entry.status === 'succeeded' || entry.status === 'failed' || entry.status === 'cancelled' ? daysAgo(rng.int(1, 50)) : null,
  }));
}

const SIGNAL_SPECS: readonly { kind: VerificationResult['signals'][number]['kind']; label: string; detail: string }[] = [
  { kind: 'single-token-distribution', label: 'Single-token distribution', detail: 'Jensen–Shannon distance against the reference distribution for the claimed family.' },
  { kind: 'tokenizer-surface', label: 'Tokenizer surface', detail: 'Behaviour on adversarial unicode and whitespace tokens.' },
  { kind: 'api-surface', label: 'API surface', detail: 'Error strings, streaming chunk cadence and header set.' },
  { kind: 'self-consistency', label: 'Self-consistency', detail: 'Variance of answers to a paraphrased fixed question.' },
  { kind: 'negative-control', label: 'Negative control', detail: 'Behaviour on a prompt the claimed family is known to refuse.' },
  { kind: 'capability-boundary', label: 'Capability boundary', detail: 'Where the model breaks on a graded difficulty ladder.' },
];

function signals(rng: Rng, verdict: VerificationResult['verdict']): VerificationResult['signals'] {
  const passBias = verdict === 'match' ? 0.95 : verdict === 'family-only' ? 0.75 : verdict === 'uncertain' ? 0.5 : verdict === 'mismatch' ? 0.2 : 0.35;
  return SIGNAL_SPECS.map((spec) => {
    const passed = rng.bool(passBias);
    return {
      kind: spec.kind,
      label: spec.label,
      passed,
      confidence: rng.round(passed ? rng.float(0.6, 0.99) : rng.float(0.05, 0.5), 3),
      detail: spec.detail,
      measurement: rng.round(rng.float(0.01, 0.6), 4),
      samples: rng.int(8, 64),
    };
  });
}

export function buildVerifications(rng: Rng): VerificationResult[] {
  const plan: readonly { providerId: string; model: string; claimedFamily: string; verdict: VerificationResult['verdict']; confidence: number }[] = [
    { providerId: 'openai', model: 'gpt-4.1', claimedFamily: 'gpt-4', verdict: 'match', confidence: 0.97 },
    { providerId: 'anthropic', model: '', claimedFamily: 'claude-3', verdict: 'match', confidence: 0.94 },
    { providerId: 'openrouter', model: 'anthropic/claude-3.5-sonnet', claimedFamily: 'claude-3', verdict: 'family-only', confidence: 0.71 },
    { providerId: 'deepinfra', model: 'meta-llama/Llama-3.3-70B-Instruct', claimedFamily: 'llama-3', verdict: 'uncertain', confidence: 0.48 },
    { providerId: 'together', model: 'meta-llama/Llama-3.1-405B-Instruct-Turbo', claimedFamily: 'llama-3', verdict: 'mismatch', confidence: 0.19 },
    { providerId: 'deepseek', model: 'deepseek-chat', claimedFamily: 'deepseek', verdict: 'match', confidence: 0.9 },
    { providerId: 'google-ai-studio', model: 'gemini-2.0-flash', claimedFamily: 'gemini', verdict: 'match', confidence: 0.92 },
    { providerId: 'byok-openai', model: 'internal-gpt-4o', claimedFamily: 'gpt-4', verdict: 'insufficient', confidence: 0.3 },
    { providerId: 'alibaba-qwen', model: 'qwen2.5-72b-instruct', claimedFamily: 'qwen', verdict: 'family-only', confidence: 0.68 },
    { providerId: 'xai', model: 'grok-3', claimedFamily: 'grok', verdict: 'uncertain', confidence: 0.44 },
  ];

  return plan.map((entry, index) => {
    const families = [entry.claimedFamily, ...rng.sample(['gpt-4', 'claude-3', 'gemini', 'llama-3', 'qwen', 'deepseek', 'mistral', 'grok'].filter((f) => f !== entry.claimedFamily), 3)];
    const remainder = Math.max(0, 1 - entry.confidence);
    const posterior = families.map((family) => ({
      family,
      score: family === entry.claimedFamily ? entry.confidence : rng.round((remainder / 3) * rng.float(0.6, 1.4), 3),
      claimed: family === entry.claimedFamily,
    }));

    return {
      id: `ver_${String(index + 1).padStart(3, '0')}`,
      providerId: entry.providerId,
      model: entry.model,
      claimedFamily: entry.claimedFamily,
      verdict: entry.verdict,
      confidence: entry.confidence,
      posterior,
      signals: signals(rng, entry.verdict),
      probesUsed: rng.int(24, 180),
      durationMs: rng.int(6_000, 240_000),
      notes:
        entry.verdict === 'mismatch'
          ? 'Single-token distribution diverges sharply and the negative control passed when it should have refused. Treat the label as unreliable.'
          : entry.verdict === 'insufficient'
            ? 'The endpoint rate-limited the probe after nine requests, so only two signals produced usable evidence.'
            : null,
      createdAt: hoursAgo(rng.int(2, 500)),
    };
  });
}

const HOLDERS = ['A. Rahman', 'J. Whitfield', 'M. Okafor', 'S. Lindqvist', 'T. Nakamura', 'R. Delacroix', 'P. Ivanova', 'K. Mbeki'];

/**
 * The issuer ranges the generator can be pointed at.
 *
 * Hand-authored rather than derived, because each row is a decision: the brand
 * decides the number's length, the issuer decides whether a sign-up will accept
 * it at all, and `acceptance` is the only honest summary of how the range has
 * behaved against the endpoints this pool is actually used for. A range nobody
 * should pick is more useful in the list than absent from it — it is the thing
 * that explains why a batch failed.
 */
export function buildVccBins(): readonly [VccBin, ...VccBin[]] {
  return [
    { bin: '411111', brand: 'visa', issuer: 'Test Card', country: 'United States', countryCode: 'US', type: 'credit', currency: 'USD', length: 16, acceptance: 0.99 },
    { bin: '424242', brand: 'visa', issuer: 'Test Card', country: 'United States', countryCode: 'US', type: 'credit', currency: 'USD', length: 16, acceptance: 0.97 },
    { bin: '400005', brand: 'visa', issuer: 'Test Card', country: 'United States', countryCode: 'US', type: 'debit', currency: 'USD', length: 16, acceptance: 0.62 },
    { bin: '426398', brand: 'visa', issuer: 'JPMorgan Chase', country: 'United States', countryCode: 'US', type: 'credit', currency: 'USD', length: 16, acceptance: 0.88 },
    { bin: '453201', brand: 'visa', issuer: 'Wells Fargo', country: 'United States', countryCode: 'US', type: 'credit', currency: 'USD', length: 16, acceptance: 0.81 },
    { bin: '555555', brand: 'mastercard', issuer: 'Test Card', country: 'United States', countryCode: 'US', type: 'credit', currency: 'USD', length: 16, acceptance: 0.98 },
    { bin: '510510', brand: 'mastercard', issuer: 'Test Card', country: 'United States', countryCode: 'US', type: 'credit', currency: 'USD', length: 16, acceptance: 0.95 },
    { bin: '222300', brand: 'mastercard', issuer: 'Test Card (2-series)', country: 'United States', countryCode: 'US', type: 'credit', currency: 'USD', length: 16, acceptance: 0.71 },
    { bin: '541333', brand: 'mastercard', issuer: 'Citibank', country: 'United States', countryCode: 'US', type: 'credit', currency: 'USD', length: 16, acceptance: 0.84 },
    { bin: '532150', brand: 'mastercard', issuer: 'HSBC', country: 'United Kingdom', countryCode: 'GB', type: 'debit', currency: 'GBP', length: 16, acceptance: 0.57 },
    { bin: '378282', brand: 'amex', issuer: 'Test Card', country: 'United States', countryCode: 'US', type: 'credit', currency: 'USD', length: 15, acceptance: 0.93 },
    { bin: '371449', brand: 'amex', issuer: 'Test Card', country: 'United States', countryCode: 'US', type: 'credit', currency: 'USD', length: 15, acceptance: 0.9 },
    { bin: '601111', brand: 'discover', issuer: 'Test Card', country: 'United States', countryCode: 'US', type: 'credit', currency: 'USD', length: 16, acceptance: 0.89 },
    { bin: '601100', brand: 'discover', issuer: 'Test Card', country: 'United States', countryCode: 'US', type: 'credit', currency: 'USD', length: 16, acceptance: 0.66 },
  ];
}

/**
 * The display form of a card number: the BIN, the middle replaced with bullets,
 * and the last four.
 *
 * The grouping follows the number's length because it has to. Amex is fifteen
 * digits in a 4-6-5 split; everything else is sixteen in fours. A 15-digit
 * number shown in fours reads as a different card, and the whole point of this
 * string is that a person can glance at it and know which card they are holding.
 */
export function maskedNumber(bin: string, last4: string, length: number): string {
  const masked = `${bin}${'•'.repeat(Math.max(0, length - bin.length - last4.length))}${last4}`;
  const groups = length === 15 ? [4, 6, 5] : [4, 4, 4, 4];
  const parts: string[] = [];
  let at = 0;
  for (const size of groups) {
    parts.push(masked.slice(at, at + size));
    at += size;
  }
  return parts.join(' ');
}

export function buildVccCards(rng: Rng): VccCard[] {
  const bins = buildVccBins();
  const count = 42;
  const cards: VccCard[] = [];
  for (let index = 0; index < count; index += 1) {
    const bin = rng.pick(bins);
    const last4 = String(rng.int(1000, 9999));
    // Weighted so the pool looks like one that has been used rather than one
    // that has only been filled: most cards are free or spent, a handful are
    // still out with a sign-up, and a few were refused.
    const status: VccCard['status'] = rng.weighted<VccCard['status']>([
      ['active', 44],
      ['reserved', 20],
      ['used', 28],
      ['declined', 8],
    ]);
    const spent = status === 'reserved' || status === 'used';
    cards.push({
      id: `vcc_${String(index + 1).padStart(3, '0')}`,
      brand: bin.brand,
      maskedNumber: maskedNumber(bin.bin, last4, bin.length),
      last4,
      // A fixture card is one the pool minted, so it has a number behind it.
      hasPan: true,
      bin: bin.bin,
      expiryMonth: rng.int(1, 12),
      expiryYear: 2027 + rng.int(0, 3),
      holderName: rng.pick(HOLDERS),
      country: rng.bool(0.7) ? bin.countryCode : null,
      currency: bin.currency,
      status,
      source: rng.pick(['pool-batch-2026-04', 'pool-batch-2026-06', 'pool-batch-2026-09', 'manual-import']),
      assignedTo: spent ? rng.pick(['openai-signup', 'anthropic-signup', 'google-signup', 'mistral-signup', 'together-signup']) : null,
      note: rng.bool(0.2) ? rng.pick(['Reserved for a re-verification run.', 'Do not reuse; tied to a closed account.', 'Held back from the general pool.']) : null,
      createdAt: daysAgo(rng.int(1, 200)),
      updatedAt: hoursAgo(rng.int(1, 900)),
    });
  }
  return cards;
}
