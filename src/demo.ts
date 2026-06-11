// Runnable smoke of the scaffold: one match, all four doors touched, then a
// replay-determinism check. Run: `npx tsx src/demo.ts` (after `npm i`).
//
// This is NOT gameplay — it proves the core loop, the seq-ordered total order across
// concurrent actors, the recorded (seq, tick) log, and that replay reproduces state.

import { Match, replay } from "./core/engine.ts";
import { observe } from "./core/observe.ts";
import { legalActions } from "./core/validate.ts";
import { canonicalize } from "./core/canonicalize.ts";
import { skirmishSpec } from "./skirmish/spec.ts";

const match = new Match(skirmishSpec, "seed-001");
console.log("match header:", match.header);

// --- Tick 0: human and agent act in the SAME tick (concurrent actors). ---
// DOOR: human plays — submit a move (a real client would gather this from UI).
match.submit({ type: "move", actor: "human", params: { entity: "h1", x: 1, y: 0 } });

// DOOR: agent plays — observe, enumerate legal moves, pick deterministically.
const obs = observe(match.getState(), "agent");
const options = legalActions(match.getState(), skirmishSpec, obs.viewer);
const choice = options[0]!; // deterministic pick for the demo
match.submit(choice);

// DOOR: rule-editable — agent widens moveRange live (humans use the same action).
match.submit({ type: "edit_rule", actor: "agent", params: { rule: "moveRange", value: 2 } });

// Try an illegal move → must be rejected, state unchanged.
match.submit({ type: "move", actor: "human", params: { entity: "a1", x: 0, y: 0 } }); // not owner

match.tick();
// A trailing empty tick — replay must still run it (the old grouped-by-logged-tick model missed this).
match.tick();

console.log("\nlog after tick 0:");
for (const e of match.log) console.log(`  seq=${e.seq} tick=${e.tick}`, JSON.stringify(e.events));

// --- Replay determinism: re-fold the transcript → identical FULL state. ---
// Stricter than before: canonicalize the WHOLE state (entities + ruleParams + tick + winner),
// so a tick-counter or rule drift can't hide behind an entities-only compare.
const rebuilt = replay(skirmishSpec, match.transcript());
const ok = canonicalize(rebuilt) === canonicalize(match.getState());
console.log(`\nreplay reproduces FULL state (tick=${match.finalTick}): ${ok ? "OK" : "MISMATCH"}`);
if (!ok) {
  console.log("  live   :", canonicalize(match.getState()));
  console.log("  replay :", canonicalize(rebuilt));
}
