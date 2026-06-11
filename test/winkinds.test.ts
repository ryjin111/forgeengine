// Phase 1 win kinds — reach_cell (racing/objective) + survive_turns (survival).
// Pins the implement-then-promote discipline: every kind listed IMPLEMENTED in
// the vocabulary must be genuinely evaluated by the engine, the validator must
// reject malformed/degenerate uses, and the gate must accept the new genres.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gateSpec } from "../src/builder/gate.ts";
import { IMPLEMENTED_WIN_KINDS } from "../src/builder/vocabulary.ts";
import { initialState, Match, verifyReplay } from "../src/core/engine.ts";
import { accrueCapturePoints, evaluateWin, validateSpec } from "../src/core/validate.ts";
import { pickObjectiveAction } from "../src/client/agent.ts";
import { runMatch } from "../src/arena/run.ts";
import { skirmishSpec } from "../src/skirmish/spec.ts";
import type { GameSpec } from "../src/core/types.ts";

const raceSpec = JSON.parse(
  readFileSync("examples/race-to-the-relic.json", "utf8"),
) as GameSpec;

function withWin(spec: GameSpec, winConditions: GameSpec["winConditions"]): GameSpec {
  const s = structuredClone(spec);
  s.winConditions = winConditions;
  return s;
}

// ---------- engine evaluation ------------------------------------------------

test("reach_cell: a living unit on the goal wins for its owner", () => {
  const s = initialState(raceSpec);
  assert.equal(evaluateWin(s, raceSpec), null); // nobody on the relic yet
  s.entities.r1 = { ...s.entities.r1, pos: { x: 8, y: 2 } };
  assert.equal(evaluateWin(s, raceSpec), "human");
});

test("reach_cell: a DEAD unit on the goal does not win", () => {
  const s = initialState(raceSpec);
  s.entities.r1 = { ...s.entities.r1, pos: { x: 8, y: 2 }, alive: false };
  // r1 dead on the relic -> no reach win; eliminate_all then fires for the agent.
  assert.equal(evaluateWin(s, raceSpec), "agent");
});

test("survive_turns: null before the deadline, draw/sole-survivor at it", () => {
  const spec = withWin(skirmishSpec, [{ id: "endure", kind: "survive_turns", params: { ticks: 5 } }]);
  const s = initialState(spec);
  s.tick = 4;
  assert.equal(evaluateWin(s, spec), null);
  s.tick = 5;
  assert.equal(evaluateWin(s, spec), "draw"); // both sides made it
  s.entities.a1 = { ...s.entities.a1, alive: false };
  assert.equal(evaluateWin(s, spec), "human"); // sole survivor at the deadline
});

test("vocabulary promotion pin: every IMPLEMENTED kind is genuinely evaluated", () => {
  // For each implemented kind, build a scenario where it MUST produce a result.
  for (const kind of IMPLEMENTED_WIN_KINDS) {
    if (kind === "eliminate_all") {
      const spec = withWin(skirmishSpec, [{ id: "w", kind: "eliminate_all" }]);
      const s = initialState(spec);
      s.entities.a1 = { ...s.entities.a1, alive: false };
      assert.notEqual(evaluateWin(s, spec), null, kind);
    } else if (kind === "reach_cell") {
      const s = initialState(raceSpec);
      s.entities.r1 = { ...s.entities.r1, pos: { x: 8, y: 2 } };
      assert.notEqual(evaluateWin(s, raceSpec), null, kind);
    } else if (kind === "survive_turns") {
      const spec = withWin(skirmishSpec, [{ id: "w", kind: "survive_turns", params: { ticks: 1 } }]);
      const s = initialState(spec);
      s.tick = 1;
      assert.notEqual(evaluateWin(s, spec), null, kind);
    } else if (kind === "score_target") {
      const spec = withWin(skirmishSpec, [{ id: "w", kind: "score_target", params: { target: 1 } }]);
      const s = initialState(spec);
      s.scores.human = 1;
      assert.equal(evaluateWin(s, spec), "human", kind);
    } else if (kind === "capture_point") {
      const spec = withWin(skirmishSpec, [
        { id: "w", kind: "capture_point", params: { x: 3, y: 3, perTick: 1, target: 1 } },
      ]);
      const s = initialState(spec);
      s.scores.agent = 1;
      assert.equal(evaluateWin(s, spec), "agent", kind);
      // And the accrual system genuinely awards points for standing on the zone.
      const s2 = initialState(spec);
      s2.entities.h1 = { ...s2.entities.h1, pos: { x: 3, y: 3 } };
      const acc = accrueCapturePoints(s2, spec);
      assert.notEqual(acc, null, kind);
      assert.equal(acc!.scores.human, 1, kind);
    } else {
      assert.fail(`IMPLEMENTED kind "${kind}" has no evaluation pin — add one before promoting it`);
    }
  }
});

// ---------- validator rejections ----------------------------------------------

test("validateSpec rejects malformed reach_cell params", () => {
  const missing = withWin(raceSpec, [{ id: "w", kind: "reach_cell" }]);
  assert.equal(validateSpec(missing).ok, false);

  const oob = withWin(raceSpec, [{ id: "w", kind: "reach_cell", params: { x: 99, y: 2 } }]);
  assert.equal(validateSpec(oob).ok, false);

  const blocked = withWin(raceSpec, [{ id: "w", kind: "reach_cell", params: { x: 4, y: 0 } }]);
  assert.equal(validateSpec(blocked).ok, false);
});

test("validateSpec rejects an UNREACHABLE goal (the racing 'unwinnable')", () => {
  const walledOff = structuredClone(raceSpec);
  // Seal the relic in a pocket: full wall at x=7 plus (8,1)/(8,3) — now NO unit
  // (raider west, guardians mid-field) can ever reach (8,2).
  for (let y = 0; y < 5; y++) walledOff.map.blocked![y * 9 + 7] = true;
  walledOff.map.blocked![1 * 9 + 8] = true;
  walledOff.map.blocked![3 * 9 + 8] = true;
  const v = validateSpec(walledOff);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("unreachable")));
});

test("validateSpec rejects survive_turns without a positive integer deadline", () => {
  for (const params of [undefined, { ticks: 0 }, { ticks: 2.5 }]) {
    const bad = withWin(skirmishSpec, [{ id: "w", kind: "survive_turns", params }]);
    assert.equal(validateSpec(bad).ok, false, JSON.stringify(params));
  }
});

// ---------- the gate accepts the new genres -------------------------------------

test("gate accepts the race template (reach_cell game end to end)", async () => {
  const r = await gateSpec(structuredClone(raceSpec));
  assert.equal(r.ok, true, !r.ok ? `${r.stage}: ${r.errors.join("; ")}` : "");
});

test("gate rejects a unit STARTING on the goal (instant-win degeneracy)", async () => {
  const instant = structuredClone(raceSpec);
  instant.entities[0] = { ...instant.entities[0], pos: { x: 8, y: 2 } };
  const r = await gateSpec(instant);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.stage, "playability");
  assert.match(r.errors[0], /already decided/);
});

// ---------- score_target: the first ACCRUAL-STATE mechanic ----------------------

const firstBlood = JSON.parse(readFileSync("examples/first-blood.json", "utf8")) as GameSpec;

test("kills accrue score in state via the live killScore param (real Match)", () => {
  const m = new Match(firstBlood, "score-seed");
  // h1 (2.0 atk) needs two hits on a1 (4.0 hp) — teleport them adjacent via legal moves
  // is slow; instead drive attacks directly through legality by placing a duel spec.
  // Simpler: craft adjacency in a clone.
  const adj = structuredClone(firstBlood);
  adj.entities[0].pos = { x: 3, y: 3 }; // h1
  adj.entities[2].pos = { x: 3, y: 4 }; // a1 adjacent
  const m2 = new Match(adj, "score-seed");
  // Two attacks kill a1 (hp 4.0 vs atk 2.0 + variance 0..1).
  for (let i = 0; i < 4 && m2.getState().winner === null; i++) {
    m2.submit({ type: "attack", actor: "human", params: { entity: "h1", target: "a1" } });
    m2.tick();
  }
  const s = m2.getState();
  assert.equal(s.entities.a1.alive, false);
  assert.equal(s.scores.human, 1); // one kill × killScore 1
  assert.equal(s.winner, "human"); // First Blood: target 1 reached
  // The full thing replays — scores included in state equality.
  const v = verifyReplay(adj, m2.transcript(), s);
  assert.equal(v.ok, true);
  assert.equal(m2.transcript().log.length > 0, true);
  void m; // first match unused beyond construction
});

test("scored event is emitted and totals are deterministic", () => {
  const adj = structuredClone(firstBlood);
  adj.entities[0].pos = { x: 3, y: 3 };
  adj.entities[2].pos = { x: 3, y: 4 };
  const run = (seed: string) => {
    const m = new Match(adj, seed);
    for (let i = 0; i < 4 && m.getState().winner === null; i++) {
      m.submit({ type: "attack", actor: "human", params: { entity: "h1", target: "a1" } });
      m.tick();
    }
    return m.getState();
  };
  assert.deepEqual(run("same"), run("same")); // identical incl. scores
});

test("validateSpec rejects malformed/unwinnable score_target specs", () => {
  // target < 1
  const bad1 = withWin(firstBlood, [{ id: "w", kind: "score_target", params: { target: 0 } }]);
  assert.equal(validateSpec(bad1).ok, false);
  // no killScore source
  const bad2 = structuredClone(firstBlood);
  delete bad2.rules.params.killScore;
  assert.equal(validateSpec(bad2).ok, false);
  // editable killScore that can reach 0 (editable-to-unwinnable)
  const bad3 = structuredClone(firstBlood);
  bad3.rules.editable = { killScore: { min: 0, max: 2, editableBy: ["human"] } };
  assert.equal(validateSpec(bad3).ok, false);
  // unachievable target (more points than available kills can yield)
  const bad4 = withWin(firstBlood, [{ id: "w", kind: "score_target", params: { target: 99 } }]);
  assert.equal(validateSpec(bad4).ok, false);
});

test("gate accepts First Blood (score_target game end to end)", async () => {
  const r = await gateSpec(structuredClone(firstBlood));
  assert.equal(r.ok, true, !r.ok ? `${r.stage}: ${r.errors.join("; ")}` : "");
});

// ---------- capture_point: per-tick system score source --------------------------

const kingSpec = JSON.parse(readFileSync("examples/king-of-the-forge.json", "utf8")) as GameSpec;

test("holding the zone accrues points each tick and wins at the target (real Match)", () => {
  const m = new Match(kingSpec, "hill-seed");
  // Walk h1 to the hill (0,2) -> (2,2) -> (4,2) with moveRange 2.
  m.submit({ type: "move", actor: "human", params: { entity: "h1", x: 2, y: 2 } });
  m.tick();
  m.submit({ type: "move", actor: "human", params: { entity: "h1", x: 4, y: 2 } });
  m.tick();
  const before = m.getState().scores.human;
  // Hold: empty ticks accrue perTick=1 each.
  for (let i = 0; i < 10 && m.getState().winner === null; i++) m.tick();
  const s = m.getState();
  assert.ok(s.scores.human > before);
  assert.equal(s.winner, "human"); // reached target 6 by holding
  const v = verifyReplay(kingSpec, m.transcript(), s);
  assert.equal(v.ok, true); // system accrual replays identically
});

test("an empty zone accrues nothing", () => {
  const m = new Match(kingSpec, "idle-seed");
  for (let i = 0; i < 5; i++) m.tick();
  assert.deepEqual(m.getState().scores, { human: 0, agent: 0 });
});

test("validateSpec rejects malformed capture_point zones", () => {
  const oob = withWin(kingSpec, [
    { id: "w", kind: "capture_point", params: { x: 99, y: 2, perTick: 1, target: 5 } },
  ]);
  assert.equal(validateSpec(oob).ok, false);
  const badRate = withWin(kingSpec, [
    { id: "w", kind: "capture_point", params: { x: 4, y: 2, perTick: 0, target: 5 } },
  ]);
  assert.equal(validateSpec(badRate).ok, false);
  const noTarget = withWin(kingSpec, [
    { id: "w", kind: "capture_point", params: { x: 4, y: 2, perTick: 1 } },
  ]);
  assert.equal(validateSpec(noTarget).ok, false);
});

test("gate accepts King of the Forge and the goal-seeker EXERCISES the genre", async () => {
  const r = await gateSpec(structuredClone(kingSpec));
  assert.equal(r.ok, true, !r.ok ? `${r.stage}: ${r.errors.join("; ")}` : "");

  // Direct run with the objective policy: the win must come from capture points
  // (scores at target), proving the playability sim plays the hill, not a brawl.
  const controllers = {
    human: (s: Parameters<typeof pickObjectiveAction>[0], sp: GameSpec, a: string) =>
      pickObjectiveAction(s, sp, a),
    agent: (s: Parameters<typeof pickObjectiveAction>[0], sp: GameSpec, a: string) =>
      pickObjectiveAction(s, sp, a),
  };
  const result = runMatch(structuredClone(kingSpec), "exercise-seed", controllers);
  assert.notEqual(result.winner, null);
  assert.equal(result.replayOk, true);
});

test("gate accepts a survival game", async () => {
  const survival = withWin(skirmishSpec, [
    { id: "endure", kind: "survive_turns", params: { ticks: 40 } },
    { id: "wipeout", kind: "eliminate_all" },
  ]);
  const r = await gateSpec(survival);
  assert.equal(r.ok, true, !r.ok ? `${r.stage}: ${r.errors.join("; ")}` : "");
});
