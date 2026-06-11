import { test } from "node:test";
import assert from "node:assert/strict";

import { Match } from "../src/core/engine.ts";
import { runTurn, turnModelFor } from "../src/runtime/turn.ts";
import { validateSpec } from "../src/core/validate.ts";
import { runMatch, runSeries } from "../src/arena/run.ts";
import { pickAgentAction } from "../src/client/agent.ts";
import { skirmishSpec } from "../src/skirmish/spec.ts";
import { fixed } from "../src/core/fixed.ts";
import type { GameSpec, TurnModel } from "../src/core/types.ts";

function duel(turnModel?: TurnModel): GameSpec {
  return {
    specVersion: 1,
    meta: { name: "duel" },
    map: { width: 3, height: 1 },
    entityTypes: { grunt: { stats: { hp: fixed.fromInt(2), attack: fixed.fromInt(2) } } },
    entities: [
      { id: "h1", type: "grunt", owner: "human", pos: { x: 0, y: 0 } },
      { id: "a1", type: "grunt", owner: "agent", pos: { x: 1, y: 0 } },
    ],
    actors: [{ id: "human", kind: "human" }, { id: "agent", kind: "agent" }],
    rules: {
      allowedActions: ["move", "attack", "edit_rule", "pass"],
      params: { moveRange: 1, attackRange: 1, attackVariance: 0 },
      editable: { moveRange: { min: 1, max: 3, editableBy: ["human", "agent"] } },
    },
    assets: {},
    winConditions: [{ id: "last", kind: "eliminate_all" }],
    ...(turnModel ? { turnModel } : {}),
  };
}

const pass = (actor: string) => ({ type: "pass" as const, actor, params: {} });

test("turnModelFor falls back to a sensible default when absent", () => {
  assert.deepEqual(turnModelFor(duel()), {
    actionsPerActorPerTurn: 1,
    resolution: "simultaneous",
    order: ["human", "agent"],
  });
});

test("validateSpec validates turnModel (bad count / resolution / actor all caught)", () => {
  assert.equal(validateSpec(duel({ actionsPerActorPerTurn: 1, resolution: "simultaneous", order: ["human", "agent"] })).ok, true);
  const bad = duel({ actionsPerActorPerTurn: 0, resolution: "weird" as TurnModel["resolution"], order: ["nope"] });
  const r = validateSpec(bad);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /actionsPerActorPerTurn/.test(e)));
  assert.ok(r.errors.some((e) => /resolution/.test(e)));
  assert.ok(r.errors.some((e) => /unknown actor nope/.test(e)));
});

test("simultaneous = one tick per turn; sequential = one tick per actor", () => {
  const sim = duel({ actionsPerActorPerTurn: 1, resolution: "simultaneous", order: ["human", "agent"] });
  const m1 = new Match(sim, "s");
  runTurn(m1, sim, { human: () => pass("human"), agent: () => pass("agent") });
  assert.equal(m1.finalTick, 1);

  const seq = duel({ actionsPerActorPerTurn: 1, resolution: "sequential", order: ["human", "agent"] });
  const m2 = new Match(seq, "s");
  runTurn(m2, seq, { human: () => pass("human"), agent: () => pass("agent") });
  assert.equal(m2.finalTick, 2);
});

test("arena runMatch yields a replayable result; runSeries ranks reproducibly", () => {
  const controllers = { human: pickAgentAction, agent: pickAgentAction };
  const r = runMatch(duel(), "s1", controllers);
  assert.ok(["human", "agent", "draw"].includes(r.winner as string));
  assert.equal(r.replayOk, true, "transcript replays to the same winner");

  const series = runSeries(duel(), ["a", "b", "c"], controllers);
  assert.equal(series.results.length, 3);
  assert.equal(series.table.length, 2);
  // Same seeds → identical table (no Date/Math.random anywhere).
  const again = runSeries(duel(), ["a", "b", "c"], controllers);
  assert.deepEqual(series.table, again.table);
});

test("the shipped skirmishSpec validates and runs headless in the arena", () => {
  assert.equal(validateSpec(skirmishSpec).ok, true);
  const r = runMatch(skirmishSpec, "k1", { human: pickAgentAction, agent: pickAgentAction });
  assert.equal(r.replayOk, true);
  assert.ok(r.turns > 0);
});
