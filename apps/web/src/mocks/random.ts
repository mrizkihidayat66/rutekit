/**
 * Deterministic pseudo-randomness for the mock layer.
 *
 * A fixed seed is what makes the fixtures worth having: the same thirty
 * providers and eighty accounts appear on every reload, so a screenshot, a bug
 * report and a test all describe the same data. `Math.random()` would give a
 * different pool each time and none of that would hold.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  readonly #next: () => number;

  constructor(seed: number) {
    this.#next = mulberry32(seed);
  }

  float(min = 0, max = 1): number {
    return min + this.#next() * (max - min);
  }

  /** Inclusive on both ends, so `int(1, 3)` can return 1, 2 or 3. */
  int(min: number, max: number): number {
    return Math.floor(this.float(min, max + 1));
  }

  bool(probability = 0.5): boolean {
    return this.#next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) throw new Error('Rng.pick: empty list');
    return item;
  }

  /** Weights need not sum to anything in particular. */
  weighted<T>(entries: readonly (readonly [T, number])[]): T {
    let roll = this.float(0, entries.reduce((sum, [, weight]) => sum + weight, 0));
    for (const [value, weight] of entries) {
      roll -= weight;
      if (roll <= 0) return value;
    }
    const last = entries[entries.length - 1];
    if (last === undefined) throw new Error('Rng.weighted: empty list');
    return last[0];
  }

  /** `n` distinct items — every item when `n` exceeds the list length. */
  sample<T>(items: readonly T[], n: number): T[] {
    const pool = [...items];
    const out: T[] = [];
    while (out.length < n && pool.length > 0) {
      const [item] = pool.splice(this.int(0, pool.length - 1), 1);
      if (item !== undefined) out.push(item);
    }
    return out;
  }

  /** Round to `places` decimals, which keeps fixture numbers readable. */
  round(value: number, places = 2): number {
    const factor = 10 ** places;
    return Math.round(value * factor) / factor;
  }

  id(prefix: string): string {
    return `${prefix}_${this.#next().toString(36).slice(2, 10)}`;
  }
}
