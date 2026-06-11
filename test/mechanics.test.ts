// Increment 4 — collect (items) + spawn_wave (scheduled reinforcements).
// Both are per-tick SYSTEM mechanics in resolveTick: pure, schedule-driven,
// ZERO RNG — so replay correctness is by construction, pinned here anyway.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gateSpec } from "../src/builder/gate.ts";
import { initialState, Match, verifyReplay } from "../src/core/engine.ts";
import { evaluateWin, validateSpec } from "../src/core/validate.ts";
import { pickObjectiveAction } from "../src/client/agent.ts";
import { runMatch } from "../src/arena/run.ts";
import type { GameSpec } from "../src/core/types.ts";

const goldRush = JSON.parse(readFileSync("examples/gold-rush.json", "utf8")) as GameSpec;
const lastStand = JSON.parse(readFileSync("examples/last-stand.json", "utf8")) as GameSpec;

// ---------- collect ----------------------------------------------------------

test("walking onto an item collects it: points to owner, item off the board", () => {
  const m = new Match(goldRush, "gold-seed");
  // h1 (0,3) -> (2,3) -> (3,3): lands on gold2 (3 points).
  m.submit({ type: "move", actor: "human", params: { entity: "h1", x: 2, y: 3 } });
  m.tick();
  m.submit({ type: "move", actor: "human", params: { entity: "h1", x: 3, y: 3 } });
  m.tick();
  const s = m.getState();
  assert.equal(s.items.gold2, true);
  assert.equal(s.scores.human, 3);
  // Standing on it longer must NOT double-collect.
  m.tick();
  assert.equal(m.getState().scores.human, 3);
  const v = verifyReplay(goldRush, m.transcript(), m.getState());
  assert.equal(v.ok, true);
});

test("items satisfy score_target without any killScore (multi-source achievability)", () => {
  // gold-rush has NO killScore — validateSpec must accept it on item points alone.
  const v = validateSpec(goldRush);
  assert.equal(v.ok, true, v.errors.join("; "));
  // And an item-less clone with the same target must be rejected as unachievable.
  const broke = structuredClone(goldRush);
  delete broke.items;
  assert.equal(validateSpec(broke).ok, false);
});

test("validateSpec rejects bad items (duplicate id, unreachable, bad points)", () => {
  const dup = structuredClone(goldRush);
  dup.items!.push({ ...dup.items![0] });
  assert.equal(validateSpec(dup).ok, false);

  const badPts = structuredClone(goldRush);
  badPts.items![0] = { ...badPts.items![0], points: 0 };
  assert.equal(validateSpec(badPts).ok, false);

  const oob = structuredClone(goldRush);
  oob.items![0] = { ...oob.items![0], pos: { x: 99, y: 0 } };
  assert.equal(validateSpec(oob).ok, false);
});

test("gate accepts Gold Rush", async () => {
  const r = await gateSpec(structuredClone(goldRush));
  assert.equal(r.ok, true, !r.ok ? `${r.stage}: ${r.errors.join("; ")}` : "");
});

test("item-seeking policy actually harvests (collect games are exercised)", () => {
  // Drive both prospectors with the objective policy: items get collected and
  // the match ends by score, proving gate sims play the harvest genre.
  const controllers = {
    human: (s: Parameters<typeof pickObjectiveAction>[0], sp: GameSpec, a: string) =>
      pickObjectiveAction(s, sp, a),
    agent: (s: Parameters<typeof pickObjectiveAction>[0], sp: GameSpec, a: string) =>
      pickObjectiveAction(s, sp, a),
  };
  const result = runMatch(structuredClone(goldRush), "harvest-seed", controllers);
  assert.notEqual(result.winner, null); // someone reached the score target
  assert.equal(result.replayOk, true);
});

// ---------- spawn_wave --------------------------------------------------------

test("waves spawn at EXACTLY their tick, never before, and replay identically", () => {
  const m = new Match(lastStand, "wave-seed");
  for (let i = 0; i < 5; i++) m.tick(); // ticks 0..4
  assert.equal(m.getState().entities.r3, undefined); // tick-6 wave not yet
  m.tick(); // tick 5
  assert.equal(m.getState().entities.r3, undefined);
  m.tick(); // tick 6 — wave fires
  const s = m.getState();
  assert.equal(s.entities.r3?.alive, true);
  assert.equal(s.entities.r4?.alive, true);
  assert.equal(s.entities.r5, undefined); // tick-12 wave still pending
  const v = verifyReplay(lastStand, m.transcript(), s);
  assert.equal(v.ok, true);
});

test("wave spawn onto an occupied cell is SKIPPED deterministically", () => {
  const blocked = structuredClone(lastStand);
  // Park a tick-0 unit on the tick-6 spawn cell (0,6).
  blocked.entities.push({ id: "squatter", type: "raider", owner: "agent", pos: { x: 0, y: 6 } });
  const m1 = new Match(blocked, "skip-seed");
  const m2 = new Match(blocked, "skip-seed");
  for (let i = 0; i < 8; i++) {
    m1.tick();
    m2.tick();
  }
  assert.equal(m1.getState().entities.r3, undefined); // skipped, not displaced
  assert.deepEqual(m1.getState(), m2.getState()); // and deterministically so
});

test("eliminate_all treats PENDING waves as presence (no premature win)", () => {
  const spec = structuredClone(lastStand);
  const s = initialState(spec);
  // Kill both starting raiders before the first wave: agent still has waves pending.
  s.entities.r1 = { ...s.entities.r1, alive: false };
  s.entities.r2 = { ...s.entities.r2, alive: false };
  s.tick = 3; // waves at 6 and 12 still pending
  assert.equal(evaluateWin(s, spec), null);
  // After the last wave tick has passed with everyone dead -> human wins.
  s.tick = 13;
  assert.equal(evaluateWin(s, spec), "human");
});

test("validateSpec rejects bad waves (tick 0, duplicate id, unknown type/owner)", () => {
  const t0 = structuredClone(lastStand);
  t0.waves![0] = { ...t0.waves![0], tick: 0 };
  assert.equal(validateSpec(t0).ok, false);

  const dupId = structuredClone(lastStand);
  dupId.waves![0].entities[0] = { ...dupId.waves![0].entities[0], id: "d1" };
  assert.equal(validateSpec(dupId).ok, false);

  const badOwner = structuredClone(lastStand);
  badOwner.waves![0].entities[0] = { ...badOwner.waves![0].entities[0], owner: "nobody" };
  assert.equal(validateSpec(badOwner).ok, false);
});

test("gate counts wave reinforcements against the entity cap", async () => {
  const r = await gateSpec(structuredClone(lastStand), { limits: { maxEntities: 4 } });
  assert.equal(r.ok, false); // 3 starting + 3 wave = 6 > 4
  if (r.ok) return;
  assert.equal(r.stage, "limits");
  assert.match(r.errors[0], /includes wave reinforcements/);
});

test("gate accepts Last Stand (horde survival end to end)", async () => {
  const r = await gateSpec(structuredClone(lastStand));
  assert.equal(r.ok, true, !r.ok ? `${r.stage}: ${r.errors.join("; ")}` : "");
});
