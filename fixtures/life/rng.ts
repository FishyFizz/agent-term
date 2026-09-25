/**
 * A seeded PRNG and the timing policy for the lifelike subject.
 *
 * The seed is what makes a run reproducible: one seed yields one action
 * sequence and one set of gaps, so an interaction that went wrong can be
 * replayed exactly. Everything random in the subject goes through here --
 * nothing in the modes calls Math.random().
 */

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform real in [min, max). */
  range(min: number, max: number): number;
  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  weighted<T>(entries: readonly (readonly [T, number])[]): T;
  /** A copy in a seeded order. */
  shuffle<T>(items: readonly T[]): T[];
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const rng: Rng = {
    next,

    range(min, max) {
      return min + next() * (max - min);
    },

    int(min, max) {
      return Math.floor(min + next() * (max - min + 1));
    },

    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new Error('pick() from an empty list');
      return items[Math.min(items.length - 1, Math.floor(next() * items.length))] as T;
    },

    weighted<T>(entries: readonly (readonly [T, number])[]): T {
      if (entries.length === 0) throw new Error('weighted() from an empty list');
      let total = 0;
      for (const entry of entries) total += entry[1];
      let roll = next() * total;
      for (const [value, weight] of entries) {
        roll -= weight;
        if (roll < 0) return value;
      }
      const last = entries[entries.length - 1];
      if (last === undefined) throw new Error('weighted() from an empty list');
      return last[0];
    },

    shuffle<T>(items: readonly T[]): T[] {
      const copy = items.slice();
      for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const a = copy[i] as T;
        const b = copy[j] as T;
        copy[i] = b;
        copy[j] = a;
      }
      return copy;
    },
  };

  return rng;
}

export function randomSeed(): number {
  return (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
}

/**
 * How long the subject waits between two visible acts.
 *
 * Mostly short, sometimes long, and at most one long gap per action -- without
 * that cap a six-line reply could run for two minutes, which is past the point
 * where a slow reply stops being interesting and starts being a timeout.
 */
const SHORT_MIN_MS = 300;
const SHORT_MAX_MS = 5_000;
const LONG_MIN_MS = 5_000;
const LONG_MAX_MS = 20_000;
const LONG_CHANCE = 0.15;

export class Pacer {
  private usedLong = false;

  constructor(
    private readonly rng: Rng,
    private readonly speed = 1,
  ) {}

  /** Call once per action to re-arm the long gap. */
  begin(): void {
    this.usedLong = false;
  }

  /** Milliseconds until the next visible act. */
  gap(): number {
    if (!this.usedLong && this.rng.next() < LONG_CHANCE) {
      this.usedLong = true;
      return this.rng.range(LONG_MIN_MS, LONG_MAX_MS);
    }
    return this.rng.range(SHORT_MIN_MS, SHORT_MAX_MS);
  }

  wait(ms: number): Promise<void> {
    const scaled = Math.max(0, Math.round(ms / this.speed));
    return new Promise((resolve) => {
      setTimeout(resolve, scaled);
    });
  }

  /** Wait one gap. */
  pause(): Promise<void> {
    return this.wait(this.gap());
  }
}
