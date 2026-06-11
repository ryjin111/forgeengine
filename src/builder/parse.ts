// Phase 5, half 1 of the gate: structurally parse UNTRUSTED input (raw LLM JSON) into a
// well-typed GameSpec candidate — WITHOUT throwing on any input. This runs before validateSpec:
// validateSpec assumes a GameSpec-shaped object (it reads .map.width etc.), so an LLM that omits
// fields or sends the wrong types must be caught here first. Output is either a typed spec
// (ready for the SEMANTIC validateSpec pass) or a list of human-readable errors for the repair
// prompt. Never trusts the input; never throws.

import type { GameSpec } from "../core/types.ts";

export type ParseResult = { ok: true; spec: GameSpec } | { ok: false; errors: string[] };

export function parseSpec(input: unknown): ParseResult {
  const e: string[] = [];
  const o = asObject(input, "spec", e);
  if (!o) return { ok: false, errors: e };

  num(o.specVersion, "specVersion", e);

  const meta = asObject(o.meta, "meta", e);
  if (meta) str(meta.name, "meta.name", e);

  const map = asObject(o.map, "map", e);
  if (map) {
    posInt(map.width, "map.width", e);
    posInt(map.height, "map.height", e);
  }

  if (!isObject(o.entityTypes)) e.push("entityTypes must be an object");
  if (!isObject(o.assets)) e.push("assets must be an object");

  const rules = asObject(o.rules, "rules", e);
  if (rules) {
    if (!Array.isArray(rules.allowedActions)) e.push("rules.allowedActions must be an array");
    if (!isObject(rules.params)) e.push("rules.params must be an object");
  }

  arr(o.entities, "entities", e, (ent, path) => {
    const en = asObject(ent, path, e);
    if (!en) return;
    str(en.id, `${path}.id`, e);
    str(en.type, `${path}.type`, e);
    str(en.owner, `${path}.owner`, e);
    const pos = asObject(en.pos, `${path}.pos`, e);
    if (pos) {
      num(pos.x, `${path}.pos.x`, e);
      num(pos.y, `${path}.pos.y`, e);
    }
  });

  arr(o.actors, "actors", e, (a, path) => {
    const an = asObject(a, path, e);
    if (!an) return;
    str(an.id, `${path}.id`, e);
    if (an.kind !== "human" && an.kind !== "agent") e.push(`${path}.kind must be 'human' or 'agent'`);
  });

  arr(o.winConditions, "winConditions", e, (w, path) => {
    const wn = asObject(w, path, e);
    if (wn) str(wn.id, `${path}.id`, e);
  });

  // Optional surfaces — only shape-checked when present.
  if (o.items !== undefined) {
    arr(o.items, "items", e, (it, path) => {
      const itn = asObject(it, path, e);
      if (!itn) return;
      str(itn.id, `${path}.id`, e);
      num(itn.points, `${path}.points`, e);
      const pos = asObject(itn.pos, `${path}.pos`, e);
      if (pos) {
        num(pos.x, `${path}.pos.x`, e);
        num(pos.y, `${path}.pos.y`, e);
      }
    });
  }
  if (o.waves !== undefined) {
    arr(o.waves, "waves", e, (w, path) => {
      const wn = asObject(w, path, e);
      if (!wn) return;
      num(wn.tick, `${path}.tick`, e);
      arr(wn.entities, `${path}.entities`, e, (ent, epath) => {
        const en = asObject(ent, epath, e);
        if (!en) return;
        str(en.id, `${epath}.id`, e);
        str(en.type, `${epath}.type`, e);
        str(en.owner, `${epath}.owner`, e);
        const pos = asObject(en.pos, `${epath}.pos`, e);
        if (pos) {
          num(pos.x, `${epath}.pos.x`, e);
          num(pos.y, `${epath}.pos.y`, e);
        }
      });
    });
  }

  if (e.length > 0) return { ok: false, errors: e };
  return { ok: true, spec: input as GameSpec };
}

// --- defensive primitives (never throw) ---
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function asObject(v: unknown, path: string, e: string[]): Record<string, unknown> | null {
  if (!isObject(v)) {
    e.push(`${path} must be an object`);
    return null;
  }
  return v;
}
function num(v: unknown, path: string, e: string[]): void {
  if (typeof v !== "number" || !Number.isFinite(v)) e.push(`${path} must be a finite number`);
}
function posInt(v: unknown, path: string, e: string[]): void {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) e.push(`${path} must be a positive integer`);
}
function str(v: unknown, path: string, e: string[]): void {
  if (typeof v !== "string" || v.length === 0) e.push(`${path} must be a non-empty string`);
}
function arr(v: unknown, path: string, e: string[], each: (item: unknown, path: string) => void): void {
  if (!Array.isArray(v)) {
    e.push(`${path} must be an array`);
    return;
  }
  v.forEach((item, i) => each(item, `${path}[${i}]`));
}
