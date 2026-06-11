// Phase 5, half 2 of the gate: the SAFETY GATE between an untrusted spec producer (the
// prompt→game LLM) and the engine. The ONLY trusted GameSpec is one
// that came out of this function. Fail-closed everywhere: any parse error, semantic error,
// resource blowout, runtime throw, or replay divergence → reject. On repair-cap exhaustion
// → hard reject, never a best-effort spec. The gate itself is LLM-free and network-free —
// repair is an injected callback so this module stays pure and testable.
//
// Pipeline per attempt:  parse → limits → validateSpec → playability (headless matches,
// replay-verified, same orchestrator the client + arena use). Deterministic: fixed seeds,
// no Date/Math.random, so gating the same candidate twice gives the same verdict.

import { parseSpec } from "./parse.ts";
import { vocabularyErrors } from "./vocabulary.ts";
import { evaluateWin, legalActions, validateSpec } from "../core/validate.ts";
import { initialState } from "../core/engine.ts";
import { runMatch, type MatchResult } from "../arena/run.ts";
import { pickAgentAction } from "../client/agent.ts";
import type { ActorController } from "../runtime/turn.ts";
import type { GameSpec } from "../core/types.ts";

/** Resource caps — semantic validity is not enough; an LLM can emit a valid 10^6-cell map. */
export interface GateLimits {
  /** map.width * map.height upper bound. */
  maxMapArea: number;
  maxEntities: number;
  maxActors: number;
  /** Repair attempts AFTER the first try (0 = single shot, no repair). */
  maxRepairs: number;
  /** Seeds for the playability matches — fixed by default so verdicts are reproducible. */
  playSeeds: string[];
  /** Turn cap per playability match (bounds gate CPU, not the future game). */
  maxTurns: number;
}

export const DEFAULT_LIMITS: GateLimits = {
  maxMapArea: 1024, // 32x32 — generous for prompt-built boards
  maxEntities: 64,
  maxActors: 8,
  maxRepairs: 2,
  playSeeds: ["gate-a", "gate-b", "gate-c"],
  maxTurns: 200,
};

/** Stage names a rejection can point at, in pipeline order. */
export type GateStage = "parse" | "limits" | "vocabulary" | "validate" | "playability" | "internal";

/** One playability match, summarized for the gate report (transcript dropped — too big). */
export interface PlayCheck {
  seed: string;
  winner: string | null;
  turns: number;
  replayOk: boolean;
  timedOut: boolean;
}

export type GateResult =
  | {
      ok: true;
      /** Deep-frozen — downstream code cannot mutate the trusted spec. */
      spec: GameSpec;
      /** Total candidates examined (1 = first try passed). */
      attempts: number;
      play: PlayCheck[];
      /**
       * LOUD aggregate of per-seed timeouts: true if ANY playability match hit the turn
       * cap unresolved. Not a rejection (long/draw-ish games are legitimate), but callers
       * MUST surface it — a never-ending "game" should not reach a human silently.
       */
      timedOut: boolean;
    }
  | {
      ok: false;
      /** The stage the LAST candidate failed at. */
      stage: GateStage;
      errors: string[];
      attempts: number;
      /** True when the verdict is "reject because the repair budget ran out". */
      repairsExhausted: boolean;
    };

/**
 * Injected repair hook (the LLM side). Receives the failing candidate and the error list,
 * returns a NEW candidate. The gate treats its output as untrusted — it goes back through
 * the full pipeline. May throw / return garbage; the gate absorbs both.
 */
export type RepairFn = (candidate: unknown, errors: string[]) => unknown | Promise<unknown>;

/** Run one candidate through parse → limits → validate → playability. Never throws. */
function checkOnce(
  candidate: unknown,
  limits: GateLimits,
): { ok: true; spec: GameSpec; play: PlayCheck[] } | { ok: false; stage: GateStage; errors: string[] } {
  // 1. Parse: untrusted shape -> typed candidate.
  const parsed = parseSpec(candidate);
  if (!parsed.ok) return { ok: false, stage: "parse", errors: parsed.errors };
  const spec = parsed.spec;

  // 2. Limits: bound resources BEFORE anything walks the map or spawns entities.
  const limitErrors: string[] = [];
  const area = spec.map.width * spec.map.height;
  if (area > limits.maxMapArea) {
    limitErrors.push(`map area ${area} exceeds cap ${limits.maxMapArea}`);
  }
  if (spec.entities.length > limits.maxEntities) {
    limitErrors.push(`${spec.entities.length} entities exceeds cap ${limits.maxEntities}`);
  }
  if (spec.actors.length > limits.maxActors) {
    limitErrors.push(`${spec.actors.length} actors exceeds cap ${limits.maxActors}`);
  }
  if (limitErrors.length > 0) return { ok: false, stage: "limits", errors: limitErrors };

  // 2b. Vocabulary conformance: reject blocks the spec format reserves but the
  //     engine can't actually run (e.g. unimplemented win kinds) — an external
  //     AI's spec must not validate-then-never-end. Fail-closed.
  const vocabErrs = vocabularyErrors(spec);
  if (vocabErrs.length > 0) return { ok: false, stage: "vocabulary", errors: vocabErrs };

  // 3. Semantic validation (owners exist, positions in bounds, edit policies sane, ...).
  const valid = validateSpec(spec);
  if (!valid.ok) return { ok: false, stage: "validate", errors: valid.errors };

  // 4a. Degeneracy — objective "broken on arrival" rejections, BEFORE any match runs.
  //     These are safety/quality facts about the opening state, not design opinions.
  const init = initialState(spec);
  // Already decided at tick 0 (e.g. asymmetric spawn where one side has nothing to
  // eliminate): the game was over before anyone acted.
  const preDecided = evaluateWin(init, spec);
  if (preDecided !== null) {
    return {
      ok: false,
      stage: "playability",
      errors: [`game is already decided on the initial state (result: ${preDecided}) before any action`],
    };
  }
  // A seat that literally cannot play. NOTE: pickAgentAction silently falls back to
  // "pass" when it has zero legal actions — and if "pass" isn't in allowedActions that
  // submission is rejected every turn, so without this explicit check a can't-move spec
  // would slip through playability as a timeout instead of a rejection.
  const stuck = spec.actors
    .filter((a) => legalActions(init, spec, a.id).length === 0)
    .map((a) => `actor "${a.id}" has no legal action on the opening state`);
  if (stuck.length > 0) return { ok: false, stage: "playability", errors: stuck };

  // 4b. Playability: prove the spec RUNS. Headless matches through the same runtime/turn.ts
  //    orchestrator the client uses, every actor driven by the deterministic agent policy
  //    (kind is irrelevant headlessly — a "human" seat is just a seat). A throw anywhere,
  //    or a replay divergence, rejects the spec. Timeout (no winner at maxTurns) is NOT a
  //    rejection — "runs without a winner" is a game-design question, not a safety one —
  //    but it is reported so the caller can decide to surface it.
  const controllers: Record<string, ActorController> = {};
  for (const actor of spec.actors) {
    controllers[actor.id] = (s, sp, a) => pickAgentAction(s, sp, a);
  }
  const play: PlayCheck[] = [];
  for (const seed of limits.playSeeds) {
    let result: MatchResult;
    try {
      result = runMatch(spec, seed, controllers);
    } catch (err) {
      return {
        ok: false,
        stage: "playability",
        errors: [`match threw on seed "${seed}": ${err instanceof Error ? err.message : String(err)}`],
      };
    }
    if (!result.replayOk) {
      return {
        ok: false,
        stage: "playability",
        errors: [`replay verification failed on seed "${seed}" — non-deterministic spec behavior`],
      };
    }
    play.push({
      seed,
      winner: result.winner,
      turns: result.turns,
      replayOk: result.replayOk,
      timedOut: result.timedOut,
    });
  }

  return { ok: true, spec, play };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/**
 * The gate. Takes an UNTRUSTED candidate (raw LLM output, already JSON-decoded) and either
 * returns a trusted, deep-frozen GameSpec or a hard rejection. Optionally loops through an
 * injected repair hook up to limits.maxRepairs times — each repaired candidate re-enters the
 * FULL pipeline from parse.
 */
export async function gateSpec(
  candidate: unknown,
  opts: { repair?: RepairFn; limits?: Partial<GateLimits> } = {},
): Promise<GateResult> {
  const limits: GateLimits = { ...DEFAULT_LIMITS, ...opts.limits };

  let current = candidate;
  let attempts = 0;
  let last: { stage: GateStage; errors: string[] } = { stage: "internal", errors: ["gate never ran"] };

  // First try + up to maxRepairs repaired retries.
  for (let round = 0; round <= limits.maxRepairs; round++) {
    attempts++;
    const result = checkOnce(current, limits);
    if (result.ok) {
      return {
        ok: true,
        spec: deepFreeze(result.spec),
        attempts,
        play: result.play,
        timedOut: result.play.some((p) => p.timedOut),
      };
    }
    last = { stage: result.stage, errors: result.errors };

    // No repair hook, or budget about to run out — stop here.
    if (!opts.repair || round === limits.maxRepairs) break;
    try {
      current = await opts.repair(current, result.errors);
    } catch (err) {
      return {
        ok: false,
        stage: "internal",
        errors: [`repair hook threw: ${err instanceof Error ? err.message : String(err)}`],
        attempts,
        repairsExhausted: false,
      };
    }
  }

  return {
    ok: false,
    stage: last.stage,
    errors: last.errors,
    attempts,
    repairsExhausted: opts.repair !== undefined && attempts > limits.maxRepairs,
  };
}
