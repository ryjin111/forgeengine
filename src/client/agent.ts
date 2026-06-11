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
