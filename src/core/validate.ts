// ONE shared module for (a) GameSpec validation and (b) action legality.
// The engine, the human editor, and the agent builder ALL import this — so the
// editor can never drift from the engine's notion of "valid", and an agent's
// enumerated legal moves always match what `step` will accept.
//
// CONTRACT: isLegal / legalActions are PURE on (state, spec, action) with ZERO RNG.
// RNG only colors outcomes inside `step`; it never decides whether a move is legal.

import type { Action, ActionType, GameSpec, State } from "./types.ts";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/** Structural + referential validation of a GameSpec. Used by editor/builder before
 *  the engine ever loads it. (Scaffold: core checks in; deeper rule-graph checks TODO.) */
export function validateSpec(spec: GameSpec): ValidationResult {
  const errors: string[] = [];
  if (spec.map.width <= 0 || spec.map.height <= 0) errors.push("map dimensions must be positive");
  const actorIds = new Set(spec.actors.map((a) => a.id));
  for (const e of spec.entities) {
    if (!spec.entityTypes[e.type]) errors.push(`entity ${e.id}: unknown type ${e.type}`);
    if (!actorIds.has(e.owner)) errors.push(`entity ${e.id}: unknown owner ${e.owner}`);
    if (!inBounds(spec, e.pos.x, e.pos.y)) errors.push(`entity ${e.id}: pos out of bounds`);
  }
  for (const a of spec.rules.allowedActions) {
    if (!isKnownActionType(a)) errors.push(`rules.allowedActions: unknown action ${a}`);
  }
  for (const [rule, policy] of Object.entries(spec.rules.editable ?? {})) {
    if (!(rule in spec.rules.params)) errors.push(`rules.editable: ${rule} has no value in params`);
    if (!Number.isInteger(policy.min) || !Number.isInteger(policy.max)) {
      errors.push(`rules.editable.${rule}: min/max must be integers`);
    }
    if (policy.min > policy.max) errors.push(`rules.editable.${rule}: min > max`);
    for (const who of policy.editableBy ?? []) {
      if (!actorIds.has(who)) errors.push(`rules.editable.${rule}: unknown editor ${who}`);
    }
  }
  if (spec.turnModel) {
    const tm = spec.turnModel;
    if (!Number.isInteger(tm.actionsPerActorPerTurn) || tm.actionsPerActorPerTurn < 1) {
      errors.push("turnModel.actionsPerActorPerTurn must be an integer >= 1");
    }
    if (tm.resolution !== "simultaneous" && tm.resolution !== "sequential") {
      errors.push(`turnModel.resolution must be 'simultaneous' or 'sequential', got ${tm.resolution}`);
    }
    if (!Array.isArray(tm.order) || tm.order.length === 0) {
      errors.push("turnModel.order must be a non-empty array of actor ids");
    } else {
      for (const who of tm.order) if (!actorIds.has(who)) errors.push(`turnModel.order: unknown actor ${who}`);
    }
  }
  for (const cond of spec.winConditions) {
    if (cond.kind === "reach_cell") {
      const gx = cond.params?.x;
      const gy = cond.params?.y;
      if (gx === undefined || gy === undefined || !Number.isInteger(gx) || !Number.isInteger(gy)) {
        errors.push(`winConditions.${cond.id}: reach_cell requires integer params x, y`);
      } else if (!inBounds(spec, gx, gy)) {
        errors.push(`winConditions.${cond.id}: goal (${gx},${gy}) is out of bounds or blocked`);
      } else if (!goalReachable(spec, gx, gy)) {
        // Static reachability: a goal no starting unit could ever walk to is the
        // racing-game version of "unwinnable" — reject it up front.
        errors.push(`winConditions.${cond.id}: goal (${gx},${gy}) is unreachable from every starting unit`);
      }
    }
    if (cond.kind === "survive_turns") {
      const ticks = cond.params?.ticks;
      if (ticks === undefined || !Number.isInteger(ticks) || ticks < 1) {
        errors.push(`winConditions.${cond.id}: survive_turns requires integer params ticks >= 1`);
      }
    }
    if (cond.kind === "score_target") {
      const target = cond.params?.target;
      if (target === undefined || !Number.isInteger(target) || target < 1) {
        errors.push(`winConditions.${cond.id}: score_target requires integer params target >= 1`);
        continue;
      }
      // Static winnability for today's only score source (kills × killScore):
      // the target must be ACHIEVABLE by someone, and rule-editing must not be
      // able to switch scoring off mid-game.
      const killScore = spec.rules.params.killScore;
      if (killScore === undefined || !Number.isInteger(killScore) || killScore < 1) {
        errors.push(
          `winConditions.${cond.id}: score_target needs rules.params.killScore >= 1 (the only score source today)`,
        );
        continue;
      }
      const editPolicy = spec.rules.editable?.killScore;
      if (editPolicy && editPolicy.min < 1) {
        errors.push(
          `winConditions.${cond.id}: editable killScore min must stay >= 1 or the game can be edited unwinnable`,
        );
      }
      // Max points an actor can earn = units owned by everyone else × killScore.
      const unitsByOwner: Record<string, number> = {};
      for (const e of spec.entities) unitsByOwner[e.owner] = (unitsByOwner[e.owner] ?? 0) + 1;
      const total = spec.entities.length;
      const achievable = spec.actors.some(
        (a) => (total - (unitsByOwner[a.id] ?? 0)) * killScore >= target,
      );
      if (!achievable) {
        errors.push(
          `winConditions.${cond.id}: target ${target} is unachievable — no actor can earn that many points from the available kills`,
        );
      }
    }
    if (cond.kind === "capture_point") {
      const cx = cond.params?.x;
      const cy = cond.params?.y;
      const perTick = cond.params?.perTick;
      const target = cond.params?.target;
      if (
        cx === undefined || cy === undefined ||
        !Number.isInteger(cx) || !Number.isInteger(cy)
      ) {
        errors.push(`winConditions.${cond.id}: capture_point requires integer params x, y`);
      } else if (!inBounds(spec, cx, cy)) {
        errors.push(`winConditions.${cond.id}: zone (${cx},${cy}) is out of bounds or blocked`);
      } else if (!goalReachable(spec, cx, cy)) {
        errors.push(`winConditions.${cond.id}: zone (${cx},${cy}) is unreachable from every starting unit`);
      }
      if (perTick === undefined || !Number.isInteger(perTick) || perTick < 1) {
        errors.push(`winConditions.${cond.id}: capture_point requires integer params perTick >= 1`);
      }
      if (target === undefined || !Number.isInteger(target) || target < 1) {
        errors.push(`winConditions.${cond.id}: capture_point requires integer params target >= 1`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/** BFS over unblocked cells (4-neighbor): can ANY starting unit reach the goal?
 *  Conservative connectivity proxy — moveRange changes step size, not which cells
 *  are connected, so 4-neighbor flood-fill is the right static check. Pure. */
function goalReachable(spec: GameSpec, gx: number, gy: number): boolean {
  const { width, height } = spec.map;
  const seen = new Uint8Array(width * height);
  const queue: number[] = [];
  for (const e of spec.entities) {
    const idx = e.pos.y * width + e.pos.x;
    if (inBounds(spec, e.pos.x, e.pos.y) && !seen[idx]) {
      seen[idx] = 1;
      queue.push(idx);
    }
  }
  while (queue.length > 0) {
    const idx = queue.shift()!;
    const x = idx % width;
    const y = (idx - x) / width;
    if (x === gx && y === gy) return true;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inBounds(spec, nx, ny)) continue;
      const nIdx = ny * width + nx;
      if (!seen[nIdx]) {
        seen[nIdx] = 1;
        queue.push(nIdx);
      }
    }
  }
  return false;
}

export function inBounds(spec: GameSpec, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= spec.map.width || y >= spec.map.height) return false;
  const blocked = spec.map.blocked;
  if (blocked && blocked[y * spec.map.width + x]) return false;
  return true;
}

function isKnownActionType(t: string): t is ActionType {
  return t === "move" || t === "attack" || t === "edit_rule" || t === "pass";
}

// ---------------------------------------------------------------------------
// Legality — derived from the spec's rules, not hardcoded. PURE, NO RNG.
// ---------------------------------------------------------------------------

/** True iff `action` is legal in `state` under `spec`. Pure; never consults RNG. */
export function isLegal(state: State, spec: GameSpec, action: Action): boolean {
  return legalityReason(state, spec, action) === null;
}

/** Returns null if legal, else a human-readable reason (also used by `step` for the
 *  rejected-event reason, so acceptance and rejection share one source of truth). */
export function legalityReason(state: State, spec: GameSpec, action: Action): string | null {
  if (state.winner !== null) return "match is over";
  if (!spec.rules.allowedActions.includes(action.type)) {
    return `action ${action.type} not allowed by rules`;
  }
  if (!spec.actors.some((a) => a.id === action.actor)) return `unknown actor ${action.actor}`;

  switch (action.type) {
    case "pass":
      return null;

    case "move": {
      const ent = state.entities[String(action.params.entity)];
      if (!ent) return "move: no such entity";
      if (!ent.alive) return "move: entity not alive";
      if (ent.owner !== action.actor) return "move: actor does not own entity";
      const x = Number(action.params.x);
      const y = Number(action.params.y);
      if (!Number.isInteger(x) || !Number.isInteger(y)) return "move: non-integer target";
      if (!inBounds(spec, x, y)) return "move: target out of bounds";
      const range = spec.rules.params.moveRange ?? state.ruleParams.moveRange ?? 1;
      const dist = Math.abs(x - ent.pos.x) + Math.abs(y - ent.pos.y); // Manhattan
      if (dist === 0) return "move: must change cell";
      if (dist > range) return `move: exceeds moveRange ${range}`;
      // Occupancy: no two living entities on one cell.
      for (const other of Object.values(state.entities)) {
        if (other.alive && other.id !== ent.id && other.pos.x === x && other.pos.y === y) {
          return "move: target occupied";
        }
      }
      return null;
    }

    case "attack": {
      const ent = state.entities[String(action.params.entity)];
      if (!ent) return "attack: no such entity";
      if (!ent.alive) return "attack: entity not alive";
      if (ent.owner !== action.actor) return "attack: actor does not own entity";
      const target = state.entities[String(action.params.target)];
      if (!target) return "attack: no such target";
      if (!target.alive) return "attack: target not alive";
      if (target.owner === ent.owner) return "attack: cannot attack own entity";
      const dist = Math.abs(target.pos.x - ent.pos.x) + Math.abs(target.pos.y - ent.pos.y);
      const reach = spec.rules.params.attackRange ?? state.ruleParams.attackRange ?? 1;
      if (dist > reach) return `attack: target out of reach ${reach}`;
      return null; // NB: legality is RNG-free; the damage roll happens in step, not here.
    }

    case "edit_rule": {
      // The "rule-editable by humans AND agents" door. Both go through this gate, which
      // enforces the spec's per-rule policy: editable-at-all, bounds, and who-may-edit.
      const rule = String(action.params.rule);
      if (!(rule in state.ruleParams)) return `edit_rule: unknown rule ${rule}`;
      const value = Number(action.params.value);
      if (!Number.isInteger(value)) return "edit_rule: value must be an integer";
      const policy = spec.rules.editable?.[rule];
      if (!policy) return `edit_rule: rule ${rule} is not editable`;
      if (value < policy.min || value > policy.max) {
        return `edit_rule: ${rule}=${value} out of bounds [${policy.min}, ${policy.max}]`;
      }
      if (policy.editableBy && policy.editableBy.length > 0 && !policy.editableBy.includes(action.actor)) {
        return `edit_rule: actor ${action.actor} may not edit ${rule}`;
      }
      return null;
    }

    default:
      return `unhandled action type`;
  }
}

// ---------------------------------------------------------------------------
// Per-tick SYSTEM mechanics — run inside the engine's resolveTick (action: null,
// SYSTEM_SEQ) so live and replay share one code path. All pure; no RNG.
// ---------------------------------------------------------------------------

/**
 * capture_point accrual: each capture zone awards perTick points to the sole
 * actor with a living unit standing on it. Pure function of (state, spec) —
 * returns null when nothing accrued this tick.
 */
export function accrueCapturePoints(
  state: State,
  spec: GameSpec,
): { scores: State["scores"]; gains: Array<{ actor: string; points: number; total: number }> } | null {
  let scores: State["scores"] | null = null;
  const gains: Array<{ actor: string; points: number; total: number }> = [];
  for (const cond of spec.winConditions) {
    if (cond.kind !== "capture_point") continue;
    const cx = cond.params?.x;
    const cy = cond.params?.y;
    const perTick = cond.params?.perTick;
    if (cx === undefined || cy === undefined || perTick === undefined || perTick < 1) continue;
    // The occupant: a living unit on the zone (cells hold one unit, so "sole" is structural).
    for (const e of Object.values(state.entities)) {
      if (e.alive && e.pos.x === cx && e.pos.y === cy) {
        scores = scores ?? { ...state.scores };
        scores[e.owner] = (scores[e.owner] ?? 0) + perTick;
        gains.push({ actor: e.owner, points: perTick, total: scores[e.owner]! });
        break;
      }
    }
  }
  return scores ? { scores, gains } : null;
}

// ---------------------------------------------------------------------------
// Win-condition evaluation — an intrinsic PER-TICK mechanic (runs inside the engine's
// resolveTick, not via an action). Pure; no RNG. Returns the winner, "draw", or null
// if the match is ongoing.
// ---------------------------------------------------------------------------

export function evaluateWin(state: State, spec: GameSpec): ActorIdResult {
  for (const cond of spec.winConditions) {
    if (cond.kind === "eliminate_all") {
      const living = new Set<string>();
      for (const e of Object.values(state.entities)) if (e.alive) living.add(e.owner);
      const actorsWithUnits = spec.actors.filter((a) => living.has(a.id));
      // Only decide once entities exist to eliminate (avoids an instant draw at tick 0
      // for specs that spawn units later). Here all specs spawn up front.
      // TODO(gameplay): this can also instant-WIN at tick 0 if a future spec gives one actor
      // zero starting units. Fine for the current specs (both actors spawn units); gate on
      // "each actor has had >=1 unit" once specs with delayed/asymmetric spawns land.
      if (spec.entities.length > 0) {
        if (actorsWithUnits.length === 1) return actorsWithUnits[0]!.id;
        if (actorsWithUnits.length === 0) return "draw";
      }
    }
    if (cond.kind === "reach_cell") {
      // Racing/objective: first actor with a living unit on the goal cell wins.
      // Params are validated by validateSpec; evaluation stays pure, no RNG.
      const gx = cond.params?.x;
      const gy = cond.params?.y;
      if (gx !== undefined && gy !== undefined) {
        for (const e of Object.values(state.entities)) {
          if (e.alive && e.pos.x === gx && e.pos.y === gy) return e.owner;
        }
      }
    }
    if (cond.kind === "survive_turns") {
      // Survival/endurance: only evaluated once the deadline tick is reached.
      const deadline = cond.params?.ticks;
      if (deadline !== undefined && state.tick >= deadline) {
        const living = new Set<string>();
        for (const e of Object.values(state.entities)) if (e.alive) living.add(e.owner);
        const survivors = spec.actors.filter((a) => living.has(a.id));
        if (survivors.length === 1) return survivors[0]!.id;
        return "draw"; // several (or zero) made it to the deadline — endurance draw
      }
    }
    if (cond.kind === "score_target" || cond.kind === "capture_point") {
      // First actor (in spec.actors order — the deterministic tie-break for
      // same-tick finishes) whose score has reached the target wins.
      const target = cond.params?.target;
      if (target !== undefined) {
        for (const a of spec.actors) {
          if ((state.scores[a.id] ?? 0) >= target) return a.id;
        }
      }
    }
    // TODO(gameplay): custom predicates.
  }
  return null;
}

type ActorIdResult = string | "draw" | null;

/** Enumerate the legal actions available to `actor` in `state`. Pure; agents call
 *  this to pick a move. Because it shares legalityReason with `step`, the set it
 *  returns is exactly the set `step` will accept. */
export function legalActions(state: State, spec: GameSpec, actor: string): Action[] {
  const out: Action[] = [];
  if (state.winner !== null) return out;

  if (spec.rules.allowedActions.includes("pass")) {
    out.push({ type: "pass", actor, params: {} });
  }
  if (spec.rules.allowedActions.includes("move")) {
    for (const ent of Object.values(state.entities)) {
      if (!ent.alive || ent.owner !== actor) continue;
      const range = spec.rules.params.moveRange ?? state.ruleParams.moveRange ?? 1;
      for (let dx = -range; dx <= range; dx++) {
        for (let dy = -range; dy <= range; dy++) {
          const x = ent.pos.x + dx;
          const y = ent.pos.y + dy;
          const candidate: Action = { type: "move", actor, params: { entity: ent.id, x, y } };
          if (isLegal(state, spec, candidate)) out.push(candidate);
        }
      }
    }
  }
  if (spec.rules.allowedActions.includes("attack")) {
    for (const ent of Object.values(state.entities)) {
      if (!ent.alive || ent.owner !== actor) continue;
      for (const target of Object.values(state.entities)) {
        const candidate: Action = {
          type: "attack",
          actor,
          params: { entity: ent.id, target: target.id },
        };
        if (isLegal(state, spec, candidate)) out.push(candidate);
      }
    }
  }
  // edit_rule: enumerate the FULL integer range [min,max] per editable rule the actor may
  // edit — not just the boundaries — so the returned set is exactly what `step` accepts
  // (step/isLegal allow any integer in range). Ranges are tiny, so the cost is nil.
  if (spec.rules.allowedActions.includes("edit_rule")) {
    for (const [rule, policy] of Object.entries(spec.rules.editable ?? {})) {
      if (policy.editableBy && policy.editableBy.length > 0 && !policy.editableBy.includes(actor)) {
        continue;
      }
      for (let value = policy.min; value <= policy.max; value++) {
        const candidate: Action = { type: "edit_rule", actor, params: { rule, value } };
        if (isLegal(state, spec, candidate)) out.push(candidate);
      }
    }
  }
  return out;
}
