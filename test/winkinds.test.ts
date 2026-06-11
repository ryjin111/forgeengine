// Phase 1 win kinds — reach_cell (racing/objective) + survive_turns (survival).
// Pins the implement-then-promote discipline: every kind listed IMPLEMENTED in
// the vocabulary must be genuinely evaluated by the engine, the validator must
// reject malformed/degenerate uses, and the gate must accept the new genres.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gateSpec } from "../src/builder/gate.ts";
import { IMPLEMENTED_WIN_KINDS } from "../src/builder/vocabulary.ts";
import { initialState } from "../src/core/engine.ts";
import { evaluateWin, validateSpec } from "../src/core/validate.ts";
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

test("gate accepts a survival game", async () => {
  const survival = withWin(skirmishSpec, [
    { id: "endure", kind: "survive_turns", params: { ticks: 40 } },
    { id: "wipeout", kind: "eliminate_all" },
  ]);
  const r = await gateSpec(survival);
  assert.equal(r.ok, true, !r.ok ? `${r.stage}: ${r.errors.join("; ")}` : "");
});
