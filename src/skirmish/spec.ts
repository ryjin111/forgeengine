// The MVP skirmish — the smallest match that exercises ALL FOUR doors over ONE core:
//   - agent plays  : drives an actor via the Action API (legalActions/step)
//   - human plays  : drives the other actor via a client (Pixi, later) over the same step
//   - agent builds : a builder tool emits THIS exact GameSpec shape
//   - human builds : a visual editor reads/writes THIS exact GameSpec shape
//   - rule-editable: both actors may submit `edit_rule` to change moveRange live
//
// This is data, not logic. It is the single shared format — there is no second
// representation for the editor vs. the agent builder.

import type { GameSpec } from "../core/types.ts";
import { fixed } from "../core/fixed.ts";

export const skirmishSpec: GameSpec = {
  specVersion: 1,
  meta: { name: "First Skirmish", authors: ["mythosforge"] },
  map: { width: 6, height: 6 },
  entityTypes: {
    grunt: { stats: { hp: fixed.fromInt(3), attack: fixed.fromInt(2) }, assetKey: "grunt_sprite" },
  },
  entities: [
    { id: "h1", type: "grunt", owner: "human", pos: { x: 0, y: 0 } },
    { id: "a1", type: "grunt", owner: "agent", pos: { x: 5, y: 5 } },
  ],
  actors: [
    { id: "human", kind: "human" },
    { id: "agent", kind: "agent" },
  ],
  rules: {
    allowedActions: ["move", "attack", "edit_rule", "pass"],
    params: { moveRange: 1, attackRange: 1, attackVariance: 1 },
    // The editable surface: moveRange may be tuned by either player within [1,3];
    // attackRange is locked down to the agent only, within [1,2] — demonstrating both
    // the bounds and the who-may-edit halves of the policy.
    editable: {
      moveRange: { min: 1, max: 3, editableBy: ["human", "agent"] },
      attackRange: { min: 1, max: 2, editableBy: ["agent"] },
    },
  },
  assets: {
    // URI is filled by the mythosforge image services; spec only references it.
    grunt_sprite: { uri: "mythosforge://assets/grunt_sprite", kind: "sprite" },
  },
  winConditions: [
    // TODO(gameplay): wire evaluation into step. Declared now so the format is stable.
    { id: "last_standing", kind: "eliminate_all" },
  ],
  // Read by the orchestrator, not the engine. This is the skirmish's turn economy made
  // explicit (it equals the default): each actor takes one action, both resolve in one tick.
  turnModel: { actionsPerActorPerTurn: 1, resolution: "simultaneous", order: ["human", "agent"] },
};
