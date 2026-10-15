import { describe, expect, it } from 'vitest';

import { batchOf, maskAccount, payloadLines, rentedLabel } from '@server/automation/payload.ts';

/**
 * Reading a job's batch out of a pasted blob (C7b, FR-5.1).
 *
 * The blob is the one input in this section the operator typed by hand or copied
 * out of a spreadsheet, so it arrives in whatever shape that produced. What is
 * tested here is the three methods' three shapes, and — the assertion that
 * matters most — that a label is never the raw line. A row that echoed a password
 * would put a credential on screen, which is the whole reason the masking exists.
 */

describe('the lines of a paste', () => {
  it('drops blank lines and trims the rest', () => {
    expect(payloadLines('  a:b  \n\n   \nc:d\n')).toEqual(['a:b', 'c:d']);
  });

  it('is empty for a paste with nothing in it', () => {
    expect(payloadLines('   \n\t\n')).toEqual([]);
  });
});

describe('masking an account', () => {
  it('keeps the domain and one character of the local part', () => {
    expect(maskAccount('alice@example.com')).toBe('a•••@example.com');
  });

  it('masks a bare token to two characters', () => {
    expect(maskAccount('abcdefghij')).toBe('ab•••');
  });

  it('masks something too short to keep any of', () => {
    expect(maskAccount('ab')).toBe('•••');
  });

  it('handles a value that is not an address at all', () => {
    expect(maskAccount('')).toBe('•••');
    expect(maskAccount('no-at-sign')).toBe('no•••');
  });

  it('keeps the last @ when the local part contains one', () => {
    // An address may not contain an unquoted `@`, but a token can — and the
    // domain is what is after the last one either way.
    expect(maskAccount('a@b@example.com')).toBe('a•••@example.com');
  });
});

describe('a rented number', () => {
  it('is derived from the position, so the same batch reads the same twice', () => {
    expect(rentedLabel(0)).toBe('+1 (555) 100-1000');
    expect(rentedLabel(1)).toBe('+1 (555) 101-1007');
    expect(rentedLabel(0)).toBe(rentedLabel(0));
  });
});

describe('a sign-in batch', () => {
  it('reads one credential per line and masks the address', () => {
    const batch = batchOf('bulk-login', 'alice@example.com:pw1\nbob@example.com:pw2', null);

    expect(batch).toEqual([
      { credential: 'alice@example.com:pw1', label: 'a•••@example.com' },
      { credential: 'bob@example.com:pw2', label: 'b•••@example.com' },
    ]);
  });

  it('reads a pipe-separated line, which FR-5.1 asks for', () => {
    const batch = batchOf('bulk-login', 'carol@example.com|pw3', null);
    expect(batch[0]?.credential).toBe('carol@example.com|pw3');
    expect(batch[0]?.label).toBe('c•••@example.com');
  });

  it('splits on the first separator, so a password may contain one', () => {
    // The opposite of the proxy parser's rule, and for the opposite reason: an
    // email may not contain `:` or `|`, so the variable-length part is on the
    // right and the label is everything before the first one.
    const batch = batchOf('bulk-login', 'dave@example.com:a:b|c', null);
    expect(batch[0]?.label).toBe('d•••@example.com');
    expect(batch[0]?.credential).toBe('dave@example.com:a:b|c');
  });

  it('never puts the raw line in a label', () => {
    const batch = batchOf('bulk-login', 'erin@example.com:hunter2', null);

    // The credential is the worker's and travels encrypted; the *label* is what
    // the console shows, and a row that echoed a password would put a credential
    // on screen. So the assertion is about the label, not about the entry.
    const labels = batch.map((entry) => entry.label);
    expect(labels).toEqual(['e•••@example.com']);
    expect(labels.join(' ')).not.toContain('hunter2');
    expect(labels.join(' ')).not.toContain('erin@');
  });
});

describe('a token batch', () => {
  it('reads a bare token and labels it from its own opening characters', () => {
    const batch = batchOf('bulk-token', 'eyJhbGciOiJIUzI1NiJ9.payload.sig', null);

    expect(batch[0]?.credential).toBe('eyJhbGciOiJIUzI1NiJ9.payload.sig');
    expect(batch[0]?.label).toBe('ey•••');
  });

  it('reads an access:refresh pair and labels from the access half', () => {
    const batch = batchOf('bulk-token', 'accessToken123:refreshToken456', null);

    expect(batch[0]?.credential).toBe('accessToken123:refreshToken456');
    // The access token is the half a console row can usefully distinguish.
    expect(batch[0]?.label).toBe('ac•••');
  });
});

describe('a registration batch', () => {
  it('makes one item per unit of quantity, with no credential', () => {
    const batch = batchOf('bulk-regist', '', 3);

    expect(batch).toHaveLength(3);
    // A registration creates the accounts rather than signing them in, so there
    // is nothing to paste and nothing to hand a worker until a number is rented.
    expect(batch.every((entry) => entry.credential === null)).toBe(true);
  });

  it('ignores the payload entirely', () => {
    const batch = batchOf('bulk-regist', 'this is not a credential', 2);
    expect(batch).toHaveLength(2);
    expect(JSON.stringify(batch)).not.toContain('this is not a credential');
  });

  it('is empty when no quantity was given', () => {
    expect(batchOf('bulk-regist', '', null)).toEqual([]);
  });
});
