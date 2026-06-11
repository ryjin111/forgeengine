// Seeded integer PRNG (SplitMix64, BigInt-exact). The ONLY source of randomness
// in the engine. Seeded from MatchHeader.seed; threaded through StepCtx. Two
// machines with the same seed and same call sequence produce identical streams.
//
// RNG affects OUTCOMES inside `step`, never LEGALITY — isLegal is RNG-free, so an
// agent's enumerated legal set always equals what `step` accepts.

const MASK64 = (1n << 64n) - 1n;
const GOLDEN = 0x9e3779b97f4a7c15n;

export interface Prng {
  /** Next 32-bit unsigned integer. */
  nextU32(): number;
  /** Uniform integer in [0, n). n must be a positive integer. */
  int(n: number): number;
  /** Snapshot the internal state (for forking/serialization). */
  clone(): Prng;
}

/** Deterministically derive a 64-bit seed from an arbitrary seed string (FNV-1a). */
function seedFromString(s: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i) & 0xff);
    h = (h * 0x100000001b3n) & MASK64;
  }
  return h;
}

export function makePrng(seed: string | bigint): Prng {
  let state = (typeof seed === "bigint" ? seed : seedFromString(seed)) & MASK64;

  function next64(): bigint {
    state = (state + GOLDEN) & MASK64;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
    return (z ^ (z >> 31n)) & MASK64;
  }

  const api: Prng = {
    nextU32() {
      return Number(next64() >> 32n); // top 32 bits, unsigned
    },
    int(n: number) {
      if (!Number.isInteger(n) || n <= 0) throw new Error(`prng.int: bad n ${n}`);
      // Rejection sampling for an unbiased, deterministic result.
      const N = BigInt(n);
      const limit = MASK64 - (MASK64 % N);
      let r = next64();
      while (r > limit) r = next64();
      return Number(r % N);
    },
    clone() {
      return makePrng(state);
    },
  };
  return api;
}
