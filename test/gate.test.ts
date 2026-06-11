// Phase 5 safety gate — the boundary between untrusted spec producers and the engine.
// Every path is fail-closed: these tests prove good specs pass, every bad-input class
// rejects, the repair loop is capped hard, and verdicts are deterministic.

import { test } from "node:test";
import assert from "node:assert/strict";
import { gateSpec, DEFAULT_LIMITS } from "../src/builder/gate.ts";
import { skirmishSpec } from "../src/skirmish/spec.ts";
import type { GameSpec } from "../src/core/types.ts";

/** Structured-clone the known-good spec so tests can break it freely. */
function goodCandidate(): unknown {
  return structuredClone(skirmishSpec) as unknown;
}

test("known-good spec passes the full gate on the first attempt", async () => {
  const r = await gateSpec(goodCandidate());
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.attempts, 1);
  assert.equal(r.play.length, DEFAULT_LIMITS.playSeeds.length);
  for (const p of r.play) assert.equal(p.replayOk, true);
});

test("trusted spec is deep-frozen — downstream mutation is impossible", async () => {
  const r = await gateSpec(goodCandidate());
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(Object.isFrozen(r.spec), true);
  assert.equal(Object.isFrozen(r.spec.rules.params), true);
  assert.throws(() => {
    (r.spec.rules.params as Record<string, number>).moveRange = 99;
  });
});

test("garbage input rejects at parse, repair never invoked when absent", async () => {
  const r = await gateSpec("not even an object");
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.stage, "parse");
  assert.equal(r.attempts, 1);
  assert.equal(r.repairsExhausted, false);
  assert.ok(r.errors.length > 0);
});

test("semantically broken spec rejects at validate", async () => {
  const c = goodCandidate() as GameSpec;
  c.entities[0] = { ...c.entities[0], owner: "nobody" }; // owner is not an actor
  const r = await gateSpec(c);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.stage, "validate");
});

test("resource blowout rejects at limits even though it would validate", async () => {
  const c = goodCandidate() as GameSpec;
  c.map = { width: 1000, height: 1000 };
  const r = await gateSpec(c);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.stage, "limits");
  assert.match(r.errors[0], /map area/);
});

test("repair loop: a fixable candidate passes after one repair", async () => {
  const broken = goodCandidate() as Record<string, unknown>;
  delete broken.map;
  let calls = 0;
  const r = await gateSpec(broken, {
    repair: (_candidate, errors) => {
      calls++;
      assert.ok(errors.length > 0); // repair sees the real error list
      return goodCandidate();
    },
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(calls, 1);
  assert.equal(r.attempts, 2);
});

test("repair cap exhaustion -> hard reject, no best-effort spec", async () => {
  const broken = goodCandidate() as Record<string, unknown>;
  delete broken.map;
  let calls = 0;
  const r = await gateSpec(broken, {
    limits: { maxRepairs: 2 },
    repair: (candidate) => {
      calls++;
      return candidate; // "repair" that never fixes anything
    },
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(calls, 2); // capped exactly at maxRepairs
  assert.equal(r.attempts, 3); // first try + 2 repairs
  assert.equal(r.repairsExhausted, true);
  assert.equal(r.stage, "parse"); // verdict points at the last real failure
});

test("repair hook throwing is absorbed as a rejection, not a crash", async () => {
  const broken = goodCandidate() as Record<string, unknown>;
  delete broken.map;
  const r = await gateSpec(broken, {
    repair: () => {
      throw new Error("LLM unavailable");
    },
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.stage, "internal");
  assert.match(r.errors[0], /repair hook threw/);
});

test("repair output is untrusted — garbage repair rejects through the full pipeline", async () => {
  const broken = goodCandidate() as Record<string, unknown>;
  delete broken.map;
  const r = await gateSpec(broken, {
    limits: { maxRepairs: 1 },
    repair: () => 42, // repair returns nonsense
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.stage, "parse");
  assert.equal(r.repairsExhausted, true);
});

test("degenerate: game already decided at tick 0 rejects at playability", async () => {
  // Strip one side's entities — eliminate_all is satisfied before any action.
  const c = goodCandidate() as GameSpec;
  c.entities = c.entities.filter((e) => e.owner === "human");
  const r = await gateSpec(c);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.stage, "playability");
  assert.match(r.errors[0], /already decided on the initial state/);
});

test("degenerate: an actor with zero legal opening actions rejects at playability", async () => {
  // Only attacks allowed, but spawns are out of reach — and no "pass" to fall back on.
  // Without the explicit check this slips through as a timeout (pickAgentAction
  // submits an illegal pass that gets rejected every turn).
  const c = goodCandidate() as GameSpec;
  c.rules = { ...c.rules, allowedActions: ["attack"], editable: undefined };
  const r = await gateSpec(c);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.stage, "playability");
  assert.match(r.errors[0], /no legal action on the opening state/);
});

test("accepted result carries a loud aggregate timedOut flag", async () => {
  const r = await gateSpec(goodCandidate());
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(typeof r.timedOut, "boolean");
  assert.equal(r.timedOut, r.play.some((p) => p.timedOut));
});

test("gate verdict is deterministic — same candidate, identical play report", async () => {
  const a = await gateSpec(goodCandidate());
  const b = await gateSpec(goodCandidate());
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.deepEqual(a.play, b.play);
});

test("custom limits are respected", async () => {
  const c = goodCandidate() as GameSpec;
  const r = await gateSpec(c, { limits: { maxEntities: 1 } });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.stage, "limits");
  assert.match(r.errors[0], /entities exceeds cap/);
});
