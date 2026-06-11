// The deterministic core. ONE pure function: step(state, action, ctx) -> {state, events}.
// No I/O, no wall-clock, no live RNG — the only nondeterminism is ctx.rng (seeded).
// Illegal actions are NOT errors: they log a `rejected` event and leave state unchanged,
// so an agent can never drive the engine into an undefined state.
//
// SCAFFOLD: state transitions for legal actions are intentionally minimal/placeholder.
// Gameplay logic (combat, win-condition evaluation, asset effects) lands AFTER review.

import type { Action, Fixed, GameEvent, GameSpec, State, StepCtx, StepResult } from "./types.ts";
import { legalityReason } from "./validate.ts";
import { fixed } from "./fixed.ts";

/** Pure transition. Same (state, action, ctx) → same result on any machine. */
export function step(state: State, spec: GameSpec, action: Action, ctx: StepCtx): StepResult {
  const reason = legalityReason(state, spec, action);
  if (reason !== null) {
    // Illegal → state unchanged, recorded as a rejected event.
    return { state, events: [{ kind: "rejected", action, reason }] };
  }

  switch (action.type) {
    case "pass":
      return { state, events: [{ kind: "passed", actor: action.actor }] };

    case "move": {
      const id = String(action.params.entity);
      const ent = state.entities[id]!; // legality guaranteed it exists & is alive
      const to = { x: Number(action.params.x), y: Number(action.params.y) };
      const next: State = {
        ...state,
        entities: { ...state.entities, [id]: { ...ent, pos: to } },
      };
      const events: GameEvent[] = [{ kind: "moved", entity: id, from: ent.pos, to }];
      return { state: next, events };
    }

    case "attack": {
      // Legality (can this entity reach that enemy) was decided RNG-free in legalityReason.
      // RNG enters ONLY here, to vary the damage outcome — never whether the attack is legal.
      const ent = state.entities[String(action.params.entity)]!;
      const target = state.entities[String(action.params.target)]!;
      const base = (ent.stats.attack ?? fixed.fromInt(1)) as Fixed;
      const varRange = spec.rules.params.attackVariance ?? 0;
      const roll = varRange > 0 ? ctx.rng.int(varRange + 1) : 0; // deterministic, seeded
      const damage = fixed.add(base, fixed.fromInt(roll));
      const curHp = (target.stats.hp ?? fixed.fromInt(0)) as Fixed;
      let newHp = fixed.sub(curHp, damage);
      const dead = (newHp as number) <= 0;
      if (dead) newHp = fixed.fromInt(0);
      const nextTarget = { ...target, stats: { ...target.stats, hp: newHp }, alive: !dead };
      // Score source: a kill awards the LIVE killScore rule param (integer points,
      // 0/absent = scoreless game) to the attacker's owner. Deterministic — reads
      // params already in state, no RNG; replay reproduces scores from the log.
      const killScore = dead ? Math.trunc(state.ruleParams.killScore ?? 0) : 0;
      const nextScores =
        killScore > 0
          ? { ...state.scores, [ent.owner]: (state.scores[ent.owner] ?? 0) + killScore }
          : state.scores;
      const next: State = {
        ...state,
        entities: { ...state.entities, [target.id]: nextTarget },
        scores: nextScores,
      };
      const events: GameEvent[] = [
        {
          kind: "attacked",
          attacker: ent.id,
          target: target.id,
          damage: fixed.toInt(damage),
          targetHpAfter: fixed.toInt(newHp),
        },
      ];
      if (dead) events.push({ kind: "died", entity: target.id });
      if (killScore > 0) {
        events.push({
          kind: "scored",
          actor: ent.owner,
          points: killScore,
          total: nextScores[ent.owner]!,
        });
      }
      return { state: next, events };
    }

    case "edit_rule": {
      const rule = String(action.params.rule);
      const value = Number(action.params.value);
      const from = state.ruleParams[rule]!; // legality guaranteed the rule exists
      const next: State = { ...state, ruleParams: { ...state.ruleParams, [rule]: value } };
      return { state: next, events: [{ kind: "rule_edited", rule, from, to: value }] };
    }

    default:
      // Unreachable: legalityReason rejects unknown types first.
      return { state, events: [{ kind: "rejected", action, reason: "unhandled action type" }] };
  }
}
