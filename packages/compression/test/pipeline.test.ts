import { describe, expect, it } from 'vitest';

import {
  RTK_PRESET_FILTERS,
  type CanonicalMessage,
  type ContentBlock,
  type TextBlock,
  type TokenSaverConfig,
  type ToolDefinition,
  type ToolResultBlock,
} from '@contracts';
import type { CanonicalRequest } from '@translator';

import {
  RTK_FILTERS,
  activeStages,
  cacheMarkersStage,
  cavemanStage,
  dcpStage,
  rtkStage,
  runPipeline,
  runStage,
  stageEnabled,
  tscStage,
  tokensSaved,
  type CompressionStage,
  type StageContext,
} from '../src/index.ts';

function text(value: string): TextBlock {
  return { type: 'text', text: value };
}

function toolResult(id: string, value: string): ToolResultBlock {
  return { type: 'tool_result', toolUseId: id, isError: false, content: [text(value)] };
}

function message(role: CanonicalMessage['role'], content: ContentBlock[]): CanonicalMessage {
  return { role, content, name: null, toolCallId: null };
}

function tool(name: string, description: string | null, parameters: Record<string, unknown>): ToolDefinition {
  return { name, description, parameters };
}

function request(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: 'gpt-4o',
    system: [],
    messages: [message('user', [text('hi')])],
    sampling: {
      temperature: null,
      topP: null,
      topK: null,
      maxTokens: null,
      stop: [],
      seed: null,
      presencePenalty: null,
      frequencyPenalty: null,
    },
    tools: [],
    toolChoice: null,
    responseFormat: null,
    stream: false,
    extras: {},
    ...overrides,
  };
}

function config(overrides: Partial<TokenSaverConfig> = {}): TokenSaverConfig {
  return {
    enabled: true,
    stages: { tsc: true, dcp: true, rtk: true, caveman: true, cacheMarkers: true },
    rtkPreset: 'balanced',
    rtkFilters: { ...RTK_PRESET_FILTERS.balanced },
    cavemanTier: 'full',
    updatedAt: '2026-10-13T00:00:00.000Z',
    ...overrides,
  };
}

function context(overrides: Partial<StageContext> = {}): StageContext {
  return { rtkFilters: { ...RTK_PRESET_FILTERS.balanced }, cavemanTier: 'full', ...overrides };
}

const lines = (count: number, build: (index: number) => string): string =>
  Array.from({ length: count }, (_unused, index) => build(index)).join('\n');

// ---------------------------------------------------------------------------

describe('activeStages', () => {
  it('runs all five stages, in the ROADMAP order, for a fully-on config', () => {
    expect(activeStages(config())).toEqual(['tsc', 'dcp', 'rtk', 'caveman', 'cacheMarkers']);
  });

  it('is inert when the master switch is off, whatever the per-stage flags say', () => {
    expect(activeStages(config({ enabled: false }))).toEqual([]);
  });

  it('treats Caveman at tier off as inert', () => {
    const stages = activeStages(config({ cavemanTier: 'off' }));
    expect(stages).not.toContain('caveman');
    expect(stageEnabled(config({ cavemanTier: 'off' }), 'caveman')).toBe(false);
  });

  it('treats RTK with no filter on as inert', () => {
    const allOff = Object.fromEntries(
      Object.keys(RTK_PRESET_FILTERS.balanced).map((id) => [id, false]),
    ) as TokenSaverConfig['rtkFilters'];
    expect(activeStages(config({ rtkFilters: allOff }))).not.toContain('rtk');
  });

  it('keeps a stage out when its own toggle is off', () => {
    const stages = config({ stages: { tsc: false, dcp: true, rtk: true, caveman: true, cacheMarkers: true } });
    expect(activeStages(stages)).toEqual(['dcp', 'rtk', 'caveman', 'cacheMarkers']);
  });
});

describe('tokensSaved', () => {
  it('floors the byte delta at four bytes per token', () => {
    expect(tokensSaved(400, 100)).toBe(75);
    expect(tokensSaved(403, 100)).toBe(75);
  });

  it('never reports a negative saving', () => {
    expect(tokensSaved(100, 400)).toBe(0);
    expect(tokensSaved(100, 100)).toBe(0);
  });
});

describe('TSC', () => {
  it('strips schema annotations and trims a description to its first sentence', () => {
    const result = tscStage.apply(
      request({
        tools: [
          tool('search', 'Search the corpus. It supports filters and ranking.', {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            title: 'SearchArgs',
            properties: {
              query: { type: 'string', description: 'The query. More prose follows here.', examples: ['a'] },
            },
            default: {},
          }),
        ],
      }),
      context(),
    );

    const parameters = result?.request.tools[0]?.parameters;
    expect(parameters).toEqual({
      type: 'object',
      properties: { query: { type: 'string', description: 'The query.' } },
    });
    expect(result?.request.tools[0]?.description).toBe('Search the corpus.');
  });

  it('caps an over-long description', () => {
    const long = `${'x'.repeat(300)}.`;
    const result = tscStage.apply(
      request({ tools: [tool('t', long, { type: 'object' })] }),
      context(),
    );
    const description = result?.request.tools[0]?.description ?? '';
    expect(description.length).toBeLessThanOrEqual(160);
    expect(description.endsWith('...')).toBe(true);
  });

  it('changes nothing when there are no tools', () => {
    expect(tscStage.apply(request(), context())).toBeNull();
  });

  it('changes nothing when a schema is already compact', () => {
    const compact = request({ tools: [tool('t', 'One line.', { type: 'object' })] });
    expect(tscStage.apply(compact, context())).toBeNull();
  });
});

describe('DCP', () => {
  it('drops an assistant turn that repeats the one before it', () => {
    const repeated = message('assistant', [text('done')]);
    const result = dcpStage.apply(
      request({ messages: [message('user', [text('go')]), repeated, repeated] }),
      context(),
    );
    expect(result?.request.messages).toHaveLength(2);
  });

  it('keeps a repeated user turn, which may be meant', () => {
    const repeated = message('user', [text('go')]);
    expect(dcpStage.apply(request({ messages: [repeated, repeated] }), context())).toBeNull();
  });

  it('drops a text part a tool result already carried', () => {
    const result = dcpStage.apply(
      request({
        messages: [
          message('tool', [
            { type: 'tool_result', toolUseId: 'c1', isError: false, content: [text('same'), text('same')] },
          ]),
        ],
      }),
      context(),
    );
    expect(result?.request.messages[0]?.content[0]).toEqual({
      type: 'tool_result',
      toolUseId: 'c1',
      isError: false,
      content: [text('same')],
    });
  });

  it('changes nothing when the conversation has no duplicates', () => {
    expect(
      dcpStage.apply(
        request({ messages: [message('user', [text('a')]), message('assistant', [text('b')])] }),
        context(),
      ),
    ).toBeNull();
  });
});

describe('RTK filters', () => {
  const samples: ReadonlyArray<readonly [string, string]> = [
    [
      'gitDiff',
      [
        'diff --git a/x.ts b/x.ts',
        'index 111..222 100644',
        '--- a/x.ts',
        '+++ b/x.ts',
        '@@ -1,3 +1,3 @@',
        ' unchanged',
        '-removed',
        '+added',
      ].join('\n'),
    ],
    [
      'gitStatus',
      [
        'On branch main',
        'Changes not staged for commit:',
        '  (use "git add <file>..." to update what will be committed)',
        '\tmodified:   src/a.ts',
      ].join('\n'),
    ],
    ['grep', lines(6, (index) => `src/a.ts:${index + 1}: hit`)],
    ['find', ['src/a.ts', 'src/b.ts', 'src/deep/c.ts'].join('\n')],
    ['searchList', ['src/a.ts (3 matches)', 'src/a.ts (3 matches)', 'src/b.ts (1 match)'].join('\n')],
    ['tree', ['src', '├── a.ts', '└── b.ts'].join('\n')],
    ['ls', ['total 8', '-rw-r--r-- 1 u g 12 Jan 1 00:00 a.ts', '-rw-r--r-- 1 u g 12 Jan 1 00:00 b.ts'].join('\n')],
    ['buildOutput', ['progress 1/9', 'src/a.ts(3,1): error TS2345: bad', 'done'].join('\n')],
    ['dedupLog', ['tick', 'tick', 'tick', 'tock'].join('\n')],
    ['readNumbered', ['1\talpha', '2\tbeta', '3\tgamma'].join('\n')],
    ['cat', lines(100, (index) => `line ${index} with some padding to reach the size`)],
    ['smartTruncate', lines(20, (index) => `${index} ${'x'.repeat(150)}`)],
  ];

  it('declares the twelve filters in the contract’s order', () => {
    expect(RTK_FILTERS.map((filter) => filter.id)).toEqual([
      'gitDiff',
      'gitStatus',
      'grep',
      'find',
      'searchList',
      'tree',
      'ls',
      'buildOutput',
      'dedupLog',
      'readNumbered',
      'cat',
      'smartTruncate',
    ]);
  });

  it.each(samples)('detects a %s sample, and only with that filter', (id, sample) => {
    const matching = RTK_FILTERS.filter((filter) => filter.detect(sample)).map((filter) => filter.id);
    expect(matching).toContain(id);
    expect(matching[0]).toBe(id);
  });

  it('drops context lines from a diff and keeps the hunks', () => {
    const filter = RTK_FILTERS.find((entry) => entry.id === 'gitDiff');
    const sample = samples[0]?.[1] ?? '';
    const output = filter?.apply(sample) ?? '';
    expect(output).toContain('@@ -1,3 +1,3 @@');
    expect(output).toContain('-removed');
    expect(output).not.toContain(' unchanged');
  });

  it('counts the grep hits it drops', () => {
    const filter = RTK_FILTERS.find((entry) => entry.id === 'grep');
    const output = filter?.apply(samples[2]?.[1] ?? '') ?? '';
    expect(output).toContain('… 1 matches omitted …');
  });

  it('folds a repeated log line into a count', () => {
    const filter = RTK_FILTERS.find((entry) => entry.id === 'dedupLog');
    const output = filter?.apply(samples[8]?.[1] ?? '') ?? '';
    expect(output).toContain('tick   (×3)');
  });

  it('strips the line-number gutter from a numbered read', () => {
    const filter = RTK_FILTERS.find((entry) => entry.id === 'readNumbered');
    expect(filter?.apply(samples[9]?.[1] ?? '')).toBe('alpha\nbeta\ngamma');
  });

  it('prefers the specific shape over the blunt fallback', () => {
    // Long enough to trip `smartTruncate`, but a `git status` and therefore
    // claimed by the filter that actually knows what it is looking at.
    const sample = ['On branch main', ...Array.from({ length: 80 }, (_u, i) => `\tmodified:   src/f${i}.ts`)].join('\n');
    const stage = rtkStage.apply(
      request({ messages: [message('tool', [toolResult('c1', sample)])] }),
      context(),
    );
    const output = (stage?.request.messages[0]?.content[0] as ToolResultBlock | undefined)?.content[0];
    expect(output?.type === 'text' ? output.text : '').not.toContain('omitted');
  });

  it('leaves a result alone when its filter is off', () => {
    const diff = samples[0]?.[1] ?? '';
    const off = context({ rtkFilters: { ...RTK_PRESET_FILTERS.balanced, gitDiff: false } });
    expect(
      rtkStage.apply(request({ messages: [message('tool', [toolResult('c1', diff)])] }), off),
    ).toBeNull();
  });

  it('changes nothing when there is no tool result', () => {
    expect(rtkStage.apply(request(), context())).toBeNull();
  });

  it('changes nothing when no enabled filter recognises the text', () => {
    const plain = request({ messages: [message('tool', [toolResult('c1', 'ok')])] });
    expect(rtkStage.apply(plain, context())).toBeNull();
  });
});

describe('Caveman', () => {
  const prose = request({
    system: [text('Please be terse.\n\n\n\nKeep it short.\nKeep it short.\nthanks\n')],
  });

  it('is inert at tier off', () => {
    expect(cavemanStage.apply(prose, context({ cavemanTier: 'off' }))).toBeNull();
  });

  it('collapses blank runs at lite without dropping anything else', () => {
    const result = cavemanStage.apply(prose, context({ cavemanTier: 'lite' }));
    const value = result?.request.system[0]?.text ?? '';
    expect(value).not.toContain('\n\n\n');
    expect(value).toContain('Please be terse.');
    expect(value).toContain('thanks');
  });

  it('drops filler lines and consecutive repeats at full', () => {
    const result = cavemanStage.apply(prose, context({ cavemanTier: 'full' }));
    const value = result?.request.system[0]?.text ?? '';
    expect(value).not.toContain('thanks');
    expect(value.match(/Keep it short\./g)).toHaveLength(1);
  });

  it('unwraps prose and drops blank lines at ultra', () => {
    const wrapped = request({ system: [text('First line\ncontinues here.\n\n- a bullet\n- another')] });
    const value = cavemanStage.apply(wrapped, context({ cavemanTier: 'ultra' }))?.request.system[0]?.text ?? '';
    expect(value).toContain('First line continues here.');
    expect(value).toContain('- a bullet');
    expect(value).not.toContain('\n\n');
  });

  it('never touches a fenced code block', () => {
    const fenced = request({ system: [text('Do this:\n\n```ts\nconst a =  1;\n```\n')] });
    const value = cavemanStage.apply(fenced, context({ cavemanTier: 'ultra' }))?.request.system[0]?.text ?? '';
    expect(value).toContain('const a =  1;');
  });

  it('changes nothing when there is no system prompt', () => {
    expect(cavemanStage.apply(request(), context())).toBeNull();
  });
});

describe('Cache Markers', () => {
  it('marks the system prompt and the last turn', () => {
    const result = cacheMarkersStage.apply(
      request({ system: [text('s')], messages: [message('user', [text('a')]), message('user', [text('b')])] }),
      context(),
    );
    expect(result?.markers).toEqual([
      { target: 'system', index: 0 },
      { target: 'lastMessage', index: 1 },
    ]);
  });

  it('leaves the request itself untouched — the saving lands on the next call', () => {
    const input = request({ system: [text('s')] });
    const result = cacheMarkersStage.apply(input, context());
    expect(result?.request).toBe(input);
  });

  it('changes nothing when there is neither a system prompt nor a turn', () => {
    expect(cacheMarkersStage.apply(request({ messages: [] }), context())).toBeNull();
  });
});

describe('runStage', () => {
  it('reports a throwing stage as failed and yields no outcome', () => {
    const boom: CompressionStage = {
      id: 'tsc',
      nature: 'structural',
      apply() {
        throw new Error('boom');
      },
    };
    const guarded = runStage(boom, request(), context());
    expect(guarded.failed).toBe(true);
    expect(guarded.outcome).toBeNull();
  });

  it('reports a healthy stage as not failed', () => {
    expect(runStage(tscStage, request(), context()).failed).toBe(false);
  });
});

describe('runPipeline', () => {
  const rich = (): CanonicalRequest =>
    request({
      system: [text('Please answer.\n\n\nthanks')],
      tools: [
        tool('search', 'Search. More prose.', {
          title: 'Args',
          type: 'object',
          properties: { q: { type: 'string' } },
        }),
      ],
      messages: [
        message('user', [text('go')]),
        message('assistant', [text('done')]),
        message('assistant', [text('done')]),
        message('tool', [toolResult('c1', '1\talpha\n2\tbeta\n3\tgamma')]),
      ],
    });

  it('runs the enabled stages in order and reports each one', () => {
    const result = runPipeline(rich(), config());
    expect(result.stages.map((stage) => stage.stageId)).toEqual([
      'tsc',
      'dcp',
      'rtk',
      'caveman',
      'cacheMarkers',
    ]);
    expect(result.stages.every((stage) => stage.failed === false)).toBe(true);
    expect(result.markers).toHaveLength(2);
  });

  it('never grows a stage’s byte count', () => {
    for (const stage of runPipeline(rich(), config()).stages) {
      expect(stage.bytesOut).toBeLessThanOrEqual(stage.bytesIn);
    }
  });

  it('reports zero savings for Cache Markers, which marks rather than shrinks', () => {
    const marker = runPipeline(rich(), config()).stages.find((stage) => stage.stageId === 'cacheMarkers');
    expect(marker?.tokensSaved).toBe(0);
    expect(marker?.bytesOut).toBe(marker?.bytesIn);
  });

  it('saves bytes overall', () => {
    const result = runPipeline(rich(), config());
    const total = result.stages.reduce((sum, stage) => sum + stage.tokensSaved, 0);
    expect(total).toBeGreaterThan(0);
  });

  it('returns the request untouched when the pipeline is disabled', () => {
    const input = rich();
    const result = runPipeline(input, config({ enabled: false }));
    expect(result.request).toBe(input);
    expect(result.stages).toEqual([]);
    expect(result.markers).toEqual([]);
  });

  it('fails open — a malformed config leaves the request untouched rather than throwing', () => {
    const input = rich();
    const malformed = { ...config(), rtkFilters: undefined } as unknown as TokenSaverConfig;
    const result = runPipeline(input, malformed);
    expect(result.request).toBe(input);
    expect(result.stages).toEqual([]);
  });
});
