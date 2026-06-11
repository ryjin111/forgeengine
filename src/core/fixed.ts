// Q16.16 fixed-point. State-affecting math uses these (or plain integers) ONLY —
// never JS floats — so the event log is byte-identical across CPUs/JS engines.
// Floats are permitted, but ONLY renderer-side, outside the determinism boundary.

import type { Fixed } from "./types.ts";

const SHIFT = 16;
const ONE = 1 << SHIFT; // 65536

export const fixed = {
  ONE: ONE as Fixed,

  /** Construct from an integer. fromInt(3) === 3 * 65536. */
  fromInt(n: number): Fixed {
    if (!Number.isInteger(n)) throw new Error(`fixed.fromInt: non-integer ${n}`);
    return ((n * ONE) | 0) as Fixed;
  },

  /** Truncate toward zero to an integer. */
  toInt(a: Fixed): number {
    return (a as number) >> SHIFT;
  },

  add(a: Fixed, b: Fixed): Fixed {
    return (((a as number) + (b as number)) | 0) as Fixed;
  },

  sub(a: Fixed, b: Fixed): Fixed {
    return (((a as number) - (b as number)) | 0) as Fixed;
  },

  /** Multiply via BigInt to avoid 53-bit float drift, then narrow back. */
  mul(a: Fixed, b: Fixed): Fixed {
    const p = (BigInt(a as number) * BigInt(b as number)) >> BigInt(SHIFT);
    return Number(BigInt.asIntN(32, p)) as Fixed;
  },

  /** Divide via BigInt. Throws on divide-by-zero (deterministic, no NaN/Inf). */
  div(a: Fixed, b: Fixed): Fixed {
    if ((b as number) === 0) throw new Error("fixed.div: divide by zero");
    const q = (BigInt(a as number) << BigInt(SHIFT)) / BigInt(b as number);
    return Number(BigInt.asIntN(32, q)) as Fixed;
  },
};
