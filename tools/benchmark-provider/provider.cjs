/*
 * The thin provider promptfoo drives, for measuring time to first token.
 *
 * This file is copied into a run's workspace and referenced from
 * `promptfooconfig.yaml` as `file://provider.cjs`. It is plain CommonJS with no
 * dependencies, so the workspace can be re-run by hand — `promptfoo eval -c
 * promptfooconfig.yaml` in that directory does exactly what rutekit did.
 *
 * **Why it exists at all.** promptfoo's own HTTP providers report `latencyMs`,
 * which is the whole request. ADR-0017 named the gap: the console compares
 * models on *time to first token* and *total latency* as separate quantities
 * (FR-9.2), and a number that only exists after the last byte is not the first
 * one. So this provider streams the answer itself and reports both.
 *
 * **It calls rutekit, not the provider.** The request goes to this instance's own
 * `/v1/chat/completions` with a key the run minted, so a benchmark measures what
 * a client of this instance actually experiences: the pool picks the account, the
 * Token Saver runs, the translator speaks whatever dialect the provider needs, and
 * the telemetry row is written. A benchmark that reached the provider directly
 * would be measuring a different product.
 *
 * **The SSE reading here is a measuring instrument, not a parser.** AP-10 warns
 * against hand-writing an SSE parser, and this is deliberately not one: it reads
 * `data:` lines, ignores everything that is not one, and looks at exactly two
 * things — whether a frame carried content, and whether a frame carried usage.
 * There is no event vocabulary, no frame buffering beyond the line, and no
 * behaviour that could be described as translating a stream. The console's chat
 * stream is parsed by the AI SDK; this file exists to put a clock next to a byte.
 *
 * `config` comes from the YAML's provider entry and carries which model to ask
 * for. The key does **not** come from there — it arrives in the environment, so a
 * secret is never written into a file that outlives the run.
 */

/** Frames arrive in chunks; a `data:` line can span two of them. */
function sseLines(buffer, chunk) {
  const combined = buffer + chunk;
  const lines = combined.split('\n');
  // The last piece may be half a line; it waits for the next chunk.
  const rest = lines.pop() ?? '';
  return { lines, rest };
}

class RutekitBenchmarkProvider {
  constructor(options) {
    const config = options?.config ?? {};
    this.model = String(config.model ?? '');
    this.providerId = String(config.providerId ?? '');
    this.baseUrl = String(config.baseUrl ?? '').replace(/\/+$/, '');
    this.systemPrompt = config.systemPrompt == null ? null : String(config.systemPrompt);
    this.thinkingLevel = String(config.thinkingLevel ?? 'auto');
  }

  id() {
    return 'rutekit';
  }

  async callApi(prompt) {
    const key = process.env.RUTEKIT_BENCHMARK_KEY;
    if (typeof key !== 'string' || key === '') {
      return { error: 'the benchmark key was not in the environment' };
    }

    const messages = [];
    if (this.systemPrompt !== null && this.systemPrompt !== '') {
      messages.push({ role: 'system', content: this.systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const started = Date.now();
    let response;
    try {
      response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
        }),
      });
    } catch (cause) {
      return { error: `could not reach rutekit: ${String(cause && cause.message ? cause.message : cause)}` };
    }

    if (!response.ok) {
      // The refusal body is the instance's own error envelope, which is the most
      // useful thing a failed cell can carry: it says whether the model was out
      // of scope, the account was busy, or the provider answered badly.
      let detail = '';
      try {
        detail = await response.text();
      } catch {
        detail = '';
      }
      const trimmed = detail.length > 400 ? `${detail.slice(0, 400)}…` : detail;
      return { error: `rutekit answered ${String(response.status)}: ${trimmed}` };
    }
    if (response.body === null) {
      return { error: 'rutekit answered without a body' };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let ttftMs = null;
    let usage = null;
    let finishReason = null;

    for (;;) {
      let step;
      try {
        step = await reader.read();
      } catch (cause) {
        return {
          error: `the stream died after ${String(text.length)} characters: ${String(cause)}`,
          // Whatever arrived is still worth keeping: a cell that failed part-way
          // has a real first-token time, and dropping it would hide the fact
          // that the model did start answering.
          metadata: { ttftMs },
        };
      }
      if (step.done) break;

      const parsed = sseLines(buffer, decoder.decode(step.value, { stream: true }));
      buffer = parsed.rest;

      for (const line of parsed.lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '' || payload === '[DONE]') continue;

        let frame;
        try {
          frame = JSON.parse(payload);
        } catch {
          // A frame that is not JSON is not part of this dialect; the AI SDK
          // reader would say the same, and a measurement should not fail over it.
          continue;
        }

        const choice = Array.isArray(frame.choices) ? frame.choices[0] : undefined;
        const delta = choice?.delta ?? {};
        const piece = typeof delta.content === 'string' ? delta.content : '';
        if (piece !== '') {
          if (ttftMs === null) ttftMs = Date.now() - started;
          text += piece;
        }
        if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;
        if (frame.usage != null) usage = frame.usage;
      }
    }

    const latencyMs = Date.now() - started;
    const outputTokens = typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : null;
    // The rate is measured over the streaming window rather than the whole
    // request: the wait before the first token is latency, and counting it would
    // report a rate the model never produced.
    const streamedMs = ttftMs === null ? null : Math.max(1, latencyMs - ttftMs);

    return {
      output: text,
      latencyMs,
      tokenUsage:
        usage === null
          ? undefined
          : {
              total: usage.total_tokens ?? undefined,
              prompt: usage.prompt_tokens ?? undefined,
              completion: usage.completion_tokens ?? undefined,
            },
      // promptfoo surfaces `metadata` on the result row, which is how the first
      // token time crosses the process boundary — it is not a field promptfoo
      // has a column for, because promptfoo does not measure it.
      metadata: {
        ttftMs,
        finishReason,
        outputTokens,
        tokensPerSecond:
          outputTokens === null || streamedMs === null
            ? null
            : Math.round((outputTokens / streamedMs) * 1000 * 10) / 10,
        providerId: this.providerId,
      },
    };
  }
}

module.exports = RutekitBenchmarkProvider;
