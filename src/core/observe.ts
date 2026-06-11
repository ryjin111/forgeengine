// The Action API's read side. Per-actor projection FROM DAY ONE (contract item 4),
// even though the MVP is full-information — so adding hidden info later is a projection
// change, never an API break. Agents call observe(state, actorId) -> Observation, then
// legalActions(...) to choose. Humans get the same projection rendered by a client.

import type { State, ActorId } from "./types.ts";

export interface Observation {
  /** Whose viewpoint this projection is for. */
  viewer: ActorId;
  tick: number;
  entities: State["entities"];
  ruleParams: Record<string, number>;
  winner: State["winner"];
}

/** MVP: full-information game, so the projection returns everything. The SIGNATURE is
 *  already per-actor, so a fog-of-war variant only changes this function's body. */
export function observe(state: State, viewer: ActorId): Observation {
  return {
    viewer,
    tick: state.tick,
    // TODO(hidden-info): filter entities/stats by visibility when a spec opts in.
    entities: state.entities,
    ruleParams: state.ruleParams,
    winner: state.winner,
  };
}
