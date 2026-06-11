// Phase 2 — the asset pipeline, PRESENTATION-ONLY. GameSpec carries asset *references*
// (keys + URIs), never pixels; the engine never sees an image. This resolves a GameSpec's
// assetRefs to image URLs the Phaser layer can load. Providers are swappable:
//   - proceduralProvider: draws a sprite in-canvas → data URL (zero network/keys, always works)
//   - mythosforgeProvider: calls our Replicate Flux image service (the real-art backend),
//     and returns null until it's configured with an endpoint — so the pipeline is wired
//     but inert (clean disc fallback) without credentials.
//
// Determinism note: nothing here touches engine State or the replay log. Assets resolve by
// key, asynchronously, entirely outside the determinism boundary.

import type { AssetRef, GameSpec } from "../core/types.ts";

export interface AssetProvider {
  /** Resolve an asset key + ref to an image URL (or data URL), or null to fall back. */
  resolve(key: string, ref: AssetRef): Promise<string | null>;
}

/** Default provider: draws a simple top-down character on a canvas and returns a data URL,
 *  so the sprite path is exercised end-to-end with no network or keys. */
export const proceduralProvider: AssetProvider = {
  async resolve(_key, ref) {
    if (ref.kind !== "sprite") return null;
    const size = 64;
    const cv = document.createElement("canvas");
    cv.width = size;
    cv.height = size;
    const c = cv.getContext("2d")!;
    c.clearRect(0, 0, size, size);
    // body
    c.fillStyle = "#e5e7eb";
    roundRect(c, 18, 24, 28, 28, 6);
    c.fill();
    // shoulders
    c.fillStyle = "#cbd5e1";
    roundRect(c, 12, 26, 8, 16, 3);
    c.fill();
    roundRect(c, 44, 26, 8, 16, 3);
    c.fill();
    // head
    c.fillStyle = "#f3f4f6";
    c.beginPath();
    c.arc(32, 20, 12, 0, Math.PI * 2);
    c.fill();
    // visor
    c.fillStyle = "#0b0f17";
    roundRect(c, 24, 16, 16, 7, 3);
    c.fill();
    // legs
    c.fillStyle = "#9ca3af";
    c.fillRect(22, 50, 7, 10);
    c.fillRect(35, 50, 7, 10);
    return cv.toDataURL("image/png");
  },
};

/** Real-art provider: POSTs a prompt to the MythosForge image service and expects `{ url }`.
 *  Returns null (→ disc/procedural fallback) until `endpoint` is supplied, so this is safe to
 *  ship un-configured. Wire `endpoint` (+ auth) once an endpoint is configured. */
export function mythosforgeProvider(config: {
  endpoint?: string;
  model?: string;
  headers?: Record<string, string>;
} = {}): AssetProvider {
  return {
    async resolve(key, ref) {
      if (!config.endpoint || ref.kind !== "sprite") return null;
      try {
        const res = await fetch(config.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", ...(config.headers ?? {}) },
          body: JSON.stringify({ model: config.model ?? "flux-schnell", prompt: promptFor(key), key }),
        });
        if (!res.ok) return null;
        const data = (await res.json()) as { url?: unknown };
        return typeof data.url === "string" ? data.url : null;
      } catch {
        return null; // network/service failure → fall back, never break the board
      }
    },
  };
}

function promptFor(key: string): string {
  return `top-down 2d game unit sprite, ${key.replace(/_/g, " ")}, clean pixel art, transparent background, centered`;
}

/** Resolve every asset in a spec. Failures resolve to "absent" (the key is simply omitted),
 *  so a partial/empty result is fine — the renderer falls back per-missing-key. */
export async function resolveAssets(spec: GameSpec, provider: AssetProvider): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await Promise.all(
    Object.entries(spec.assets).map(async ([key, ref]) => {
      const url = await provider.resolve(key, ref);
      if (url) out.set(key, url);
    }),
  );
  return out;
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
