// Open Engine Kit CLI — the public validate-and-run path. The ONLY way in is
// through the safety gate: every command that touches a spec file runs the
// full parse → limits → vocabulary → validate → playability pipeline first.
// An external AI's workflow is exactly these three commands:
//
//   npm run kit -- vocab                 # the building-blocks catalog (give this to your model)
//   npm run kit -- validate game.json    # full gate verdict (exit 0 = trusted)
//   npm run kit -- run game.json         # gate, then play a headless match + verify replay
//
// No raw spec ever reaches the engine from here without passing the gate.

import { readFileSync } from "node:fs";
import { gateSpec } from "../builder/gate.ts";
import { describeVocabulary } from "../builder/vocabulary.ts";
import { runMatch } from "../arena/run.ts";
import { pickAgentAction } from "../client/agent.ts";
import type { ActorController } from "../runtime/turn.ts";

function readCandidate(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    fail(`cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return JSON.parse(raw!);
  } catch (err) {
    fail(`${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

async function cmdValidate(path: string): Promise<void> {
  const verdict = await gateSpec(readCandidate(path));
  if (verdict.ok) {
    console.log(`✓ TRUSTED — "${verdict.spec.meta.name}" passed the full gate`);
    console.log(`  playability: ${verdict.play.length} seeded matches, all replay-verified`);
    for (const p of verdict.play) {
      console.log(
        `    seed=${p.seed} winner=${p.winner ?? "none"} turns=${p.turns}${p.timedOut ? " (TIMED OUT at cap — game may be unwinnable as designed)" : ""}`,
      );
    }
    if (verdict.timedOut) {
      console.log("  ⚠ at least one match hit the turn cap — review the game's win design");
    }
    return;
  }
  console.error(`✗ REJECTED at stage "${verdict.stage}" (attempts: ${verdict.attempts}):`);
  for (const e of verdict.errors) console.error(`  - ${e}`);
  process.exit(1);
}

async function cmdRun(path: string, seed: string): Promise<void> {
  const verdict = await gateSpec(readCandidate(path));
  if (!verdict.ok) {
    console.error(`✗ REJECTED at stage "${verdict.stage}" — refusing to run an untrusted spec:`);
    for (const e of verdict.errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  const spec = verdict.spec;
  const controllers: Record<string, ActorController> = {};
  for (const a of spec.actors) controllers[a.id] = (s, sp, ac) => pickAgentAction(s, sp, ac);
  const result = runMatch(spec, seed, controllers);
  console.log(`✓ match complete — "${spec.meta.name}" seed=${seed}`);
  console.log(`  winner: ${result.winner ?? "none"}  turns: ${result.turns}  timedOut: ${result.timedOut}`);
  console.log(`  replay verified: ${result.replayOk ? "YES — transcript reproduces state + events" : "NO (engine bug, report this)"}`);
  console.log(`  transcript entries: ${result.transcript.log.length}, final tick: ${result.transcript.finalTick}`);
  if (!result.replayOk) process.exit(1);
}

function cmdVocab(): void {
  console.log(JSON.stringify(describeVocabulary(), null, 2));
}

async function main(): Promise<void> {
  const [cmd, arg, ...rest] = process.argv.slice(2);
  const seedFlag = rest.indexOf("--seed");
  const seed = (seedFlag >= 0 ? rest[seedFlag + 1] : undefined) ?? "kit-1";

  switch (cmd) {
    case "vocab":
      cmdVocab();
      break;
    case "validate":
      if (!arg) fail("usage: kit validate <spec.json>");
      await cmdValidate(arg);
      break;
    case "run":
      if (!arg) fail("usage: kit run <spec.json> [--seed s]");
      await cmdRun(arg, seed);
      break;
    default:
      console.log("MythosForge Open Engine Kit");
      console.log("  vocab                      print the building-blocks catalog (feed it to your model)");
      console.log("  validate <spec.json>       full safety-gate verdict (exit 0 = trusted)");
      console.log("  run <spec.json> [--seed s] gate, then run a headless replay-verified match");
      process.exit(cmd ? 1 : 0);
  }
}

main();
