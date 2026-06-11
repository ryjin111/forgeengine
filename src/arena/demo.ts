// Runnable arena demo: `npm run arena`. Two agent policies battle across several seeds through
// the SAME engine + turn orchestrator the board uses, then prints a leaderboard. Every match is
// replay-checked. No rendering, no human — the "built for AI" loop, headless.

import { runSeries } from "./run.ts";
import { pickAgentAction } from "../client/agent.ts";
import { skirmishSpec } from "../skirmish/spec.ts";
import type { Action } from "../core/types.ts";

// Two distinct policies so the leaderboard is decisive:
//  - "human" slot = Aggressor (our policy: close in and attack)
//  - "agent" slot = Idler (always passes — never fights back)
const aggressor = pickAgentAction;
const idler = (_s: unknown, _sp: unknown, actor: string): Action => ({ type: "pass", actor, params: {} });

const seeds = ["s1", "s2", "s3", "s4", "s5"];
const { results, table } = runSeries(skirmishSpec, seeds, { human: aggressor, agent: idler });

console.log("MythosForge arena — Aggressor (human) vs Idler (agent)\n");
for (const r of results) {
  console.log(`  seed ${r.seed}: winner=${r.winner}  turns=${r.turns}  replayOk=${r.replayOk}`);
}
console.log("\nStandings (win=3, draw=1):");
for (const s of table) {
  console.log(`  ${s.actor.padEnd(6)} ${String(s.points).padStart(3)} pts   W${s.wins} D${s.draws} L${s.losses} T${s.timeouts}`);
}
const allReplayOk = results.every((r) => r.replayOk);
console.log(`\nall matches replay-verified: ${allReplayOk ? "OK" : "MISMATCH"}`);
