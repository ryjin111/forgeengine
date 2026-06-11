import { test } from "node:test";
import assert from "node:assert/strict";

import { Match, replay, verifyReplay } from "../src/core/engine.ts";
import { isLegal, legalActions, legalityReason, evaluateWin, validateSpec } from "../src/core/validate.ts";
import { fixed } from "../src/core/fixed.ts";
import type { Action, GameSpec } from "../src/core/types.ts";
import { skirmishSpec } from "../src/skirmish/spec.ts";

/** A 3x1 board with a human and agent grunt adjacent at (0,0)/(1,0). hp low so combat resolves fast. */
function duelSpec(): GameSpec {
  return {
    specVersion: 1,
    meta: { name: "duel" },
    map: { width: 3, height: 1 },
    entityTypes: { grunt: { stats: { hp: fixed.fromInt(2), attack: fixed.fromInt(2) } } },
    entities: [
      { id: "h1", type: "grunt", owner: "human", pos: { x: 0, y: 0 } },
      { id: "a1", type: "grunt", owner: "agent", pos: { x: 1, y: 0 } },
    ],
    actors: [
      { id: "human", kind: "human" },
      { id: "agent", kind: "agent" },
    ],
    rules: {
      allowedActions: ["move", "attack", "edit_rule", "pass"],
      params: { moveRange: 1, attackRange: 1, attackVariance: 0 }, // variance 0 → deterministic dmg
      editable: {
        moveRange: { min: 1, max: 3, editableBy: ["human", "agent"] },
        attackRange: { min: 1, max: 2, editableBy: ["agent"] },
      },
    },
    assets: {},
    winConditions: [{ id: "last", kind: "eliminate_all" }],
  };
}

test("attack legality: adjacent enemy legal, out-of-reach illegal, own entity illegal", () => {
  const spec = duelSpec();
  const m = new Match(spec, "s");
  const st = m.getState();
  assert.equal(isLegal(st, spec, { type: "attack", actor: "human", params: { entity: "h1", target: "a1" } }), true);
  assert.equal(legalityReason(st, spec, { type: "attack", actor: "human", params: { entity: "h1", target: "h1" } }), "attack: cannot attack own entity");
  // Move a1 away to make it out of reach.
  const far = duelSpec();
  far.entities[1]!.pos = { x: 2, y: 0 };
  const m2 = new Match(far, "s");
  assert.equal(isLegal(m2.getState(), far, { type: "attack", actor: "human", params: { entity: "h1", target: "a1" } }), false);
});

test("legalActions enumerates attacks against adjacent enemies", () => {
  const spec = duelSpec();
  const m = new Match(spec, "s");
  const acts = legalActions(m.getState(), spec, "human");
  assert.ok(acts.some((a) => a.type === "attack" && a.params.target === "a1"), "human can attack a1");
});

test("combat is deterministic and kills at 0 hp; win-eval fires as a per-tick system event", () => {
  const spec = duelSpec(); // hp 2, attack 2, variance 0 → one hit kills
  const m = new Match(spec, "s");
  m.submit({ type: "attack", actor: "human", params: { entity: "h1", target: "a1" } });
  m.tick();
  // a1 dead → agent has no units → human wins, emitted as a system entry (action: null).
  assert.equal(m.getState().entities.a1!.alive, false);
  assert.equal(m.getState().winner, "human");
  const sys = m.log.find((e) => e.action === null);
  assert.ok(sys, "a system log entry exists");
  assert.deepEqual(sys!.events, [{ kind: "win", winner: "human" }]);
  // Events: attacked + died on the action entry.
  const atk = m.log.find((e) => e.action?.type === "attack")!;
  assert.deepEqual(atk.events, [
    { kind: "attacked", attacker: "h1", target: "a1", damage: 2, targetHpAfter: 0 },
    { kind: "died", entity: "a1" },
  ]);
});

test("actions after a win are rejected (match is over)", () => {
  const spec = duelSpec();
  const m = new Match(spec, "s");
  m.submit({ type: "attack", actor: "human", params: { entity: "h1", target: "a1" } });
  m.tick();
  m.submit({ type: "pass", actor: "agent", params: {} });
  m.tick();
  const rej = m.log.find((e) => e.action?.type === "pass")!;
  assert.deepEqual(rej.events, [{ kind: "rejected", action: { type: "pass", actor: "agent", params: {} }, reason: "match is over" }]);
});

test("edit_rule enforces bounds and who-may-edit", () => {
  const spec = duelSpec();
  const m = new Match(spec, "s");
  const st = m.getState();
  // out of bounds
  assert.match(legalityReason(st, spec, { type: "edit_rule", actor: "human", params: { rule: "moveRange", value: 9 } })!, /out of bounds/);
  // who-may-edit: human may NOT edit attackRange (agent-only)
  assert.match(legalityReason(st, spec, { type: "edit_rule", actor: "human", params: { rule: "attackRange", value: 2 } })!, /may not edit/);
  // legal edits
  assert.equal(isLegal(st, spec, { type: "edit_rule", actor: "human", params: { rule: "moveRange", value: 3 } }), true);
  assert.equal(isLegal(st, spec, { type: "edit_rule", actor: "agent", params: { rule: "attackRange", value: 2 } }), true);
});

test("evaluateWin: draw when all entities die, null while both live", () => {
  const spec = duelSpec();
  const m = new Match(spec, "s");
  assert.equal(evaluateWin(m.getState(), spec), null);
});

test("replay reproduces full state AND per-tick events (verifyReplay)", () => {
  const spec = duelSpec();
  const m = new Match(spec, "s");
  m.submit({ type: "edit_rule", actor: "agent", params: { rule: "attackRange", value: 2 } });
  m.submit({ type: "attack", actor: "human", params: { entity: "h1", target: "a1" } });
  m.tick();
  m.tick(); // trailing empty tick
  const v = verifyReplay(spec, m.transcript(), m.getState());
  assert.equal(v.stateOk, true, "final state matches");
  assert.equal(v.eventsOk, true, "per-tick events match");
  assert.equal(v.ok, true);
});

test("replay is fail-closed against a mismatched spec", () => {
  const spec = duelSpec();
  const m = new Match(spec, "s");
  m.submit({ type: "pass", actor: "human" });
  m.tick();
  const tampered = { ...spec, map: { width: 9, height: 1 } };
  assert.throws(() => replay(tampered, m.transcript()), /does not match header\.specHash/);
});

test("specs pass their OWN validator (regression: 'attack' was missing from isKnownActionType)", () => {
  assert.deepEqual(validateSpec(skirmishSpec), { ok: true, errors: [] });
  assert.deepEqual(validateSpec(duelSpec()), { ok: true, errors: [] });
});

test("legalActions enumerates the FULL edit range, not just boundaries (contract B)", () => {
  const spec = duelSpec(); // moveRange editable in [1,3] by human
  const m = new Match(spec, "s");
  const edits = legalActions(m.getState(), spec, "human").filter((a) => a.type === "edit_rule" && a.params.rule === "moveRange");
  const values = edits.map((a) => a.params.value).sort();
  assert.deepEqual(values, [1, 2, 3], "every legal integer in range is offered, incl. the interior value 2");
  // And every enumerated edit is actually accepted by step's gate — the module's stated contract.
  for (const a of legalActions(m.getState(), spec, "human")) {
    assert.equal(isLegal(m.getState(), spec, a), true, `enumerated action must be legal: ${JSON.stringify(a)}`);
  }
});

test("the shipped skirmishSpec runs and replays deterministically", () => {
  const m = new Match(skirmishSpec, "seed-001");
  const a1 = legalActions(m.getState(), skirmishSpec, "agent")[0]! as Action;
  m.submit(a1);
  m.submit({ type: "move", actor: "human", params: { entity: "h1", x: 1, y: 0 } });
  m.tick();
  const v = verifyReplay(skirmishSpec, m.transcript(), m.getState());
  assert.equal(v.ok, true);
});
