import { describe, expect, it } from 'vitest';

import { mergeHeaders } from '@server/providers/model-call.ts';

/**
 * The request headers, as the dispatch layer builds them (C4.6).
 *
 * **This exists because a duplicate header hung a turn.** HTTP names are
 * case-insensitive; a plain object is not. `applyAuth` writes `Authorization` from
 * the manifest's auth mode and a signing codec writes `authorization` with its
 * signature, and spreading both into one object sent *two* `Authorization`
 * headers. qoder answered that by not answering: the turn timed out after the
 * upstream clock, which reads as a provider outage.
 *
 * The probes that diagnosed it are not reproducible in a test — they need a live
 * provider — so what is pinned here is the rule that prevents the class: a later
 * source replaces an earlier one regardless of spelling.
 */

describe('merging request headers', () => {
  it('lets a later source replace an earlier one whatever its case', () => {
    const merged = mergeHeaders(
      { Authorization: 'Bearer from-the-manifest' },
      { authorization: 'Bearer COSY.signed' },
    );

    // One header, and the later value. Two would be the bug.
    expect(Object.keys(merged)).toEqual(['authorization']);
    expect(merged['authorization']).toBe('Bearer COSY.signed');
  });

  it('keeps the later source’s spelling, so a codec’s own casing survives', () => {
    const merged = mergeHeaders({ 'content-type': 'text/plain' }, { 'Content-Type': 'application/json' });
    expect(Object.keys(merged)).toEqual(['content-type']);
    expect(merged['content-type']).toBe('application/json');
  });

  it('keeps headers that do not collide', () => {
    const merged = mergeHeaders({ accept: 'text/event-stream' }, { 'cosy-key': 'k', 'cosy-date': '1' });
    expect(Object.keys(merged).sort()).toEqual(['accept', 'cosy-date', 'cosy-key']);
  });

  it('skips a source that is absent', () => {
    // `encoded.headers` is optional: most codecs set none.
    const merged = mergeHeaders({ accept: 'application/json' }, undefined, { 'x-a': '1' });
    expect(Object.keys(merged).sort()).toEqual(['accept', 'x-a']);
  });

  it('takes the last of three sources, not the first', () => {
    const merged = mergeHeaders(
      { Accept: 'application/json' },
      { accept: 'text/event-stream' },
      { Accept: 'application/vnd.amazon.eventstream' },
    );
    expect(Object.keys(merged)).toEqual(['accept']);
    expect(merged['accept']).toBe('application/vnd.amazon.eventstream');
  });
});
