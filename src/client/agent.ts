// A tiny deterministic agent policy for the board — the "agent plays" door in action.
// It does exactly what any agent would: observe, enumerate LEGAL actions, pick one.
// Deterministic (no RNG) so a watched match is reproducible.

import type { Action, State } from "../core/types.ts";
import type { GameSpec } from "../core/types.ts";
import { legalActions } from "../core/validate.ts";

export function pickAgentAction(state: State, spec: GameSpec, actor: string): Action {
  const acts = legalActions(state, spec, actor);
  if (acts.length === 0) return { type: "pass", actor, params: {} };

  // 1) Attack if able — target the one whose id sorts first (deterministic tie-break).
  const attacks = acts.filter((a) => a.type === "attack");
  if (attacks.length) {
    attacks.sort((a, b) => String(a.params.target).localeCompare(String(b.params.target)));
    return attacks[0]!;
  }

  // 2) Else close distance: move minimizing Manhattan distance to the nearest enemy.
  const moves = acts.filter((a) => a.type === "move");
  const enemies = Object.values(state.entities).filter((e) => e.alive && e.owner !== actor);
  if (moves.length && enemies.length) {
    const distTo = (x: number, y: number) =>
      Math.min(...enemies.map((e) => Math.abs(e.pos.x - x) + Math.abs(e.pos.y - y)));
    moves.sort((a, b) => {
      const da = distTo(Number(a.params.x), Number(a.params.y));
      const db = distTo(Number(b.params.x), Number(b.params.y));
      if (da !== db) return da - db;
      return JSON.stringify(a.params).localeCompare(JSON.stringify(b.params));
    });
    return moves[0]!;
  }

  return { type: "pass", actor, params: {} };
}

/** The objective cell of a spec's first reach_cell / capture_point condition, if any. */
export function objectiveCell(spec: GameSpec): { x: number; y: number } | null {
  for (const c of spec.winConditions) {
    if ((c.kind === "reach_cell" || c.kind === "capture_point") && c.params) {
      const { x, y } = c.params;
      if (x !== undefined && y !== undefined) return { x, y };
    }
  }
  return null;
}

/** True if the spec's genre is objective-driven (goal cell, zone, or collectibles). */
export function hasObjective(spec: GameSpec): boolean {
  return objectiveCell(spec) !== null || (spec.items?.length ?? 0) > 0;
}

/** The current target cell for a seeker: fixed goal/zone, else nearest uncollected item. */
function seekTarget(state: State, spec: GameSpec, from: { x: number; y: number }): { x: number; y: number } | null {
  const fixed = objectiveCell(spec);
  if (fixed) return fixed;
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (const it of spec.items ?? []) {
    if (state.items[it.id]) continue;
    const d = Math.abs(it.pos.x - from.x) + Math.abs(it.pos.y - from.y);
    if (d < bestD || (d === bestD && best && (it.pos.y * 10000 + it.pos.x) < (best.y * 10000 + best.x))) {
      bestD = d;
      best = { ...it.pos };
    }
  }
  return best;
}

/**
 * Objective-seeking policy: heads for the spec's goal/zone cell instead of
 * brawling, so objective genres (racing, king-of-the-hill) are actually
 * EXERCISED in headless play. Deterministic, no RNG:
 *  1) if a unit already holds the objective, hold it (pass) — attacks only if
 *     an enemy is in reach of the holder's cell;
 *  2) else move minimizing Manhattan distance to the objective;
 *  3) no objective in the spec → fall back to the brawler policy.
 */
export function pickObjectiveAction(state: State, spec: GameSpec, actor: string): Action {
  const acts = legalActions(state, spec, actor);
  if (acts.length === 0) return { type: "pass", actor, params: {} };

  const mine = Object.values(state.entities).filter((e) => e.alive && e.owner === actor);
  const goal = mine.length > 0 ? seekTarget(state, spec, mine[0]!.pos) : objectiveCell(spec);
  if (!goal) return pickAgentAction(state, spec, actor);

  const holder = mine.find((e) => e.pos.x === goal.x && e.pos.y === goal.y);
  if (holder) {
    // Defend the point: attack if able, otherwise hold.
    const attacks = acts.filter((a) => a.type === "attack" && a.params.entity === holder.id);
    if (attacks.length) {
      attacks.sort((a, b) => String(a.params.target).localeCompare(String(b.params.target)));
      return attacks[0]!;
    }
    const pass = acts.find((a) => a.type === "pass");
    if (pass) return pass;
  }

  const moves = acts.filter((a) => a.type === "move");
  if (moves.length) {
    const dist = (x: number, y: number) => Math.abs(goal.x - x) + Math.abs(goal.y - y);
    moves.sort((a, b) => {
      const da = dist(Number(a.params.x), Number(a.params.y));
      const db = dist(Number(b.params.x), Number(b.params.y));
      if (da !== db) return da - db;
      return JSON.stringify(a.params).localeCompare(JSON.stringify(b.params));
    });
    return moves[0]!;
  }

  return pickAgentAction(state, spec, actor);
}
