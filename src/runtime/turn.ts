// The turn ORCHESTRATOR — a layer ABOVE the pure engine. It owns the *turn economy* (a game
// rule) so that the Phaser client AND the headless arena AND Phase-5 prompt-made games all
// pace matches identically, instead of each re-implementing it (which would make matches
// non-comparable across doors). The engine itself stays a pure resolver: it only ever resolves
// whatever was submitted for a tick in seq order. This file reads `spec.turnModel` DATA and
// drives a Match accordingly; the engine never sees the turn model.

import type { Match } from "../core/engine.ts";
import type { Action, ActorId, GameSpec, TurnModel } from "../core/types.ts";

/** Resolve the effective turn model: explicit `spec.turnModel`, else a sensible default
 *  (1 action per actor, simultaneous resolution, actors in spec order). */
export function turnModelFor(spec: GameSpec): TurnModel {
  const tm = spec.turnModel;
  return {
    actionsPerActorPerTurn: tm?.actionsPerActorPerTurn ?? 1,
    resolution: tm?.resolution ?? "simultaneous",
    order: tm?.order ?? spec.actors.map((a) => a.id),
  };
}

/** A controller decides an actor's action(s) for a turn from the current state. The human
 *  client passes a controller that returns the UI-chosen action; an agent passes its policy;
 *  the arena passes a policy for every actor. Returning [] / a pass is fine. */
export type ActorController = (state: ReturnType<Match["getState"]>, spec: GameSpec, actor: ActorId) => Action | Action[];

function take(controller: ActorController | undefined, match: Match, spec: GameSpec, actor: ActorId, max: number): Action[] {
  if (!controller) return [];
  const out = controller(match.getState(), spec, actor);
  return (Array.isArray(out) ? out : [out]).slice(0, max);
}

/** Run ONE turn for every actor through the shared turn model. The SAME function backs the
 *  interactive client and the headless arena, so they can never diverge in pacing. */
export function runTurn(match: Match, spec: GameSpec, controllers: Partial<Record<ActorId, ActorController>>): void {
  const tm = turnModelFor(spec);

  if (tm.resolution === "simultaneous") {
    // Every actor decides on the SAME pre-tick snapshot, all actions land in one tick,
    // resolved by submission seq (which follows `order`). One tick advances.
    for (const actor of tm.order) {
      for (const a of take(controllers[actor], match, spec, actor, tm.actionsPerActorPerTurn)) match.submit(a);
    }
    match.tick();
  } else {
    // Sequential: each actor acts and its actions resolve in their own tick before the next
    // actor decides — so later actors see earlier actors' effects this turn.
    for (const actor of tm.order) {
      for (const a of take(controllers[actor], match, spec, actor, tm.actionsPerActorPerTurn)) match.submit(a);
      match.tick();
    }
  }
}

/** Drive a Match to completion with one controller per actor — the headless arena's core loop.
 *  Returns the number of turns run. Caps at `maxTurns` to guarantee termination on a stuck
 *  match (e.g. two passive policies). */
export function runToEnd(match: Match, spec: GameSpec, controllers: Partial<Record<ActorId, ActorController>>, maxTurns = 500): number {
  let turns = 0;
  while (match.getState().winner === null && turns < maxTurns) {
    runTurn(match, spec, controllers);
    turns++;
  }
  return turns;
}
