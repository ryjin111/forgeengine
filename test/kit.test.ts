// Open Engine Kit — vocabulary + AI-play contract tests.
// Two jobs: (1) pin the vocabulary catalog against what the engine/validator
// actually implement, so the kit's public docs can never drift from reality;
// (2) assert the AI-play contract (observe / legalActions / submit / result /
// replay) holds for EVERY shipped example spec — hand-authored and generated
// alike, per the locked review criteria.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gateSpec } from "../src/builder/gate.ts";
import {
  ACTION_TYPES,
  describeVocabulary,
  IMPLEMENTED_WIN_KINDS,
  RESERVED_WIN_KINDS,
  vocabularyErrors,
} from "../src/builder/vocabulary.ts";
import { Match, initialState, verifyReplay } from "../src/core/engine.ts";
import { evaluateWin, legalActions, validateSpec } from "../src/core/validate.ts";
import { observe } from "../src/core/observe.ts";
import { runMatch } from "../src/arena/run.ts";
import { pickAgentAction } from "../src/client/agent.ts";
import { skirmishSpec } from "../src/skirmish/spec.ts";
import type { GameSpec } from "../src/core/types.ts";
import type { ActorController } from "../src/runtime/turn.ts";

// ---------- vocabulary pinned against the engine (no drift) -------------------

test("vocabulary action types exactly match what validateSpec accepts", () => {
  // Every cataloged action type validates; any other token is rejected.
  for (const a of ACTION_TYPES) {
    const spec = structuredClone(skirmishSpec) as GameSpec;
    spec.rules = { ...spec.rules, allowedActions: [a] };
    const v = validateSpec(spec);
    assert.equal(
      v.errors.some((e) => e.includes("unknown action")),
      false,
      `cataloged action "${a}" must validate`,
    );
  }
  const bad = structuredClone(skirmishSpec) as GameSpec;
  (bad.rules.allowedActions as string[]) = ["teleport"];
  assert.equal(validateSpec(bad).ok, false);
});

test("implemented win kinds actually evaluate; reserved kinds do not", () => {
  // eliminate_all: a state with one side wiped must produce a winner.
  const s = initialState(skirmishSpec);
  for (const id of Object.keys(s.entities)) {
    if (s.entities[id].owner === "agent") s.entities[id] = { ...s.entities[id], alive: false };
  }
  assert.equal(evaluateWin(s, skirmishSpec), "human");
  // The catalogs partition: nothing is both implemented and reserved.
  for (const k of RESERVED_WIN_KINDS) assert.equal(IMPLEMENTED_WIN_KINDS.includes(k), false);
});

test("gate rejects reserved win kinds at the vocabulary stage", async () => {
  const spec = structuredClone(skirmishSpec) as GameSpec;
  spec.winConditions = [{ id: "w1", kind: "custom" }];
  const r = await gateSpec(spec);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.stage, "vocabulary");
});

test("gate rejects a spec with no win conditions (must be endable)", async () => {
  const spec = structuredClone(skirmishSpec) as GameSpec;
  spec.winConditions = [];
  const r = await gateSpec(spec);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.stage, "vocabulary");
  assert.equal(vocabularyErrors(spec).length, 1);
});

test("describeVocabulary is JSON-serializable and lists the play contract", () => {
  const v = JSON.parse(JSON.stringify(describeVocabulary()));
  assert.ok(Array.isArray(v.actionTypes.values));
  assert.deepEqual(v.winConditions.implemented, IMPLEMENTED_WIN_KINDS);
  assert.ok(v.playContract.observe && v.playContract.legalActions && v.playContract.replay);
});

// ---------- the AI-play contract holds for EVERY example spec -----------------

function exampleSpecs(): Array<{ name: string; candidate: unknown }> {
  const dir = join(process.cwd(), "examples");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.startsWith("rejected-"))
    .map((f) => ({ name: f, candidate: JSON.parse(readFileSync(join(dir, f), "utf8")) }));
}

test("every example spec passes the gate and satisfies the AI-play contract", async () => {
  const examples = exampleSpecs();
  assert.ok(examples.length >= 1, "kit must ship at least one trusted example");

  for (const ex of examples) {
    const verdict = await gateSpec(ex.candidate);
    assert.equal(verdict.ok, true, `${ex.name} must pass the gate`);
    if (!verdict.ok) continue;
    const spec = verdict.spec;
    const init = initialState(spec);

    for (const actor of spec.actors) {
      // observe: a per-actor projection exists and is JSON-safe.
      const obs = observe(init, actor.id);
      assert.equal(obs.viewer, actor.id);
      JSON.stringify(obs);
      // legalActions: every seat can act on the opening state.
      assert.ok(legalActions(init, spec, actor.id).length > 0, `${ex.name}: ${actor.id} can act`);
    }

    // submit/result/replay: a full agent-driven match completes and replays.
    const controllers: Record<string, ActorController> = {};
    for (const a of spec.actors) controllers[a.id] = (s, sp, ac) => pickAgentAction(s, sp, ac);
    const result = runMatch(spec, "contract-seed", controllers);
    assert.equal(result.replayOk, true, `${ex.name}: transcript must replay`);

    // submit path: an illegal action is rejected without corrupting state.
    const m = new Match(spec, "contract-2");
    m.submit({ type: "move", actor: spec.actors[0].id, params: { entity: "nope", x: 0, y: 0 } });
    m.tick();
    const v = verifyReplay(spec, m.transcript(), m.getState());
    assert.equal(v.ok, true);
  }
});

test("rejected-* examples are genuinely rejected (the gate is a real wall)", async () => {
  const dir = join(process.cwd(), "examples");
  const rejected = readdirSync(dir).filter((f) => f.startsWith("rejected-") && f.endsWith(".json"));
  for (const f of rejected) {
    const r = await gateSpec(JSON.parse(readFileSync(join(dir, f), "utf8")));
    assert.equal(r.ok, false, `${f} must be rejected`);
  }
});
