// Canonical serialization. ONE implementation feeds BOTH specHash and anything
// hashed/compared in the log. Without canonical key order, specHash would be
// non-reproducible (JSON key order is insertion-dependent). Load-bearing for replay.

/** Deterministic JSON: keys sorted recursively, no insignificant whitespace,
 *  integers only (floats/NaN/Infinity rejected — state math is integer). */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`canonicalize: non-finite number ${value}`);
    // Guard the integer-only invariant for state — surfaces accidental float drift early.
    if (!Number.isInteger(value)) {
      throw new Error(`canonicalize: non-integer ${value} (state math must be integer/fixed-point)`);
    }
    return value;
  }
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(sortDeep);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  throw new Error(`canonicalize: unsupported value of type ${typeof value}`);
}

/** FNV-1a 64-bit hash over the canonical string → hex. Deterministic, dependency-free,
 *  identical on any machine (BigInt math). Swap for a crypto hash later if needed. */
export function hashCanonical(value: unknown): string {
  const s = canonicalize(value);
  const MASK64 = (1n << 64n) - 1n;
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i) & 0xff);
    h = (h * 0x100000001b3n) & MASK64;
  }
  return h.toString(16).padStart(16, "0");
}
