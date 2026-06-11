// The Open Engine Kit's BOUNDED VOCABULARY — the typed catalog of every building
// block an external AI may compose into a GameSpec. This is the Ludii-style
// "small Lego set" the prompt side works from: a model is handed THIS catalog
// (via describeVocabulary()), composes a spec from it, and the gate rejects
// anything outside it.
//
// Discipline: the engine stays frozen — this module MIRRORS what the engine
// actually implements, and test/vocabulary.test.ts pins the mirror against the
// real validator/engine so the two can never drift apart. When the engine
// grows a block (e.g. reach_cell wins), it gets ADDED here deliberately.

import type { ActionType } from "../core/types.ts";

/** Action types the engine resolves. Mirrors core/validate.ts isKnownActionType. */
export const ACTION_TYPES: readonly ActionType[] = ["move", "attack", "edit_rule", "pass"];

/**
 * Win-condition kinds the engine ACTUALLY EVALUATES today (Phase 1 added
 * reach_cell — racing/objective games — and survive_turns — survival games).
 * The GameSpec type still reserves "custom"; a spec relying on an unimplemented
 * kind would validate, run, and simply never end, so the kit treats reserved
 * kinds as a hard reject (fail-closed beats silently-unwinnable).
 *
 * Promotion discipline: a kind appears here ONLY after core/validate.ts
 * evaluateWin actually evaluates it — test/winkinds.test.ts pins this.
 */
export const IMPLEMENTED_WIN_KINDS: readonly string[] = [
  "eliminate_all",
  "reach_cell",
  "survive_turns",
  "score_target",
];

/** Reserved in the spec format but NOT yet runnable — rejected by the gate. */
export const RESERVED_WIN_KINDS: readonly string[] = ["custom"];

/** Turn resolution models the orchestrator implements (runtime/turn.ts). */
export const TURN_RESOLUTIONS: readonly string[] = ["simultaneous", "sequential"];

/** Actor seat kinds. */
export const ACTOR_KINDS: readonly string[] = ["human", "agent"];

/** Asset reference kinds (presentation only — never gameplay). */
export const ASSET_KINDS: readonly string[] = ["sprite", "audio"];

/**
 * Machine-readable catalog handed to spec-generating AIs (and printed by the
 * CLI's `vocab` command). Everything an external model needs to compose a
 * valid spec, with the constraints stated next to each block.
 */
export function describeVocabulary(): Record<string, unknown> {
  return {
    specVersion: 1,
    actionTypes: {
      values: ACTION_TYPES,
      note: "rules.allowedActions picks a subset; legality is evaluated per tick by the engine",
    },
    winConditions: {
      implemented: IMPLEMENTED_WIN_KINDS,
      reserved: RESERVED_WIN_KINDS,
      note: "specs using reserved kinds are REJECTED by the gate until the engine implements them",
    },
    turnModel: {
      resolutions: TURN_RESOLUTIONS,
      note: "optional; omitted = 1 action per actor per turn, simultaneous, spec actor order",
    },
    actors: {
      kinds: ACTOR_KINDS,
      note: "any seat is AI-playable through the play contract; 'human' marks seats clients offer to people",
    },
    assets: {
      kinds: ASSET_KINDS,
      note: "presentation only — the engine never reads pixels; missing assets fall back procedurally",
    },
    rules: {
      params: "free numeric parameters keyed by rule id",
      editable: "optional per-rule {min,max,editableBy} — in-game rule editing stays bounded",
    },
    playContract: {
      observe: "observe(state, actor) -> per-actor Observation projection",
      legalActions: "legalActions(state, spec, actor) -> every action the engine will accept",
      submit: "Match.submit(action) -> seq; Match.tick() resolves in seq order",
      result: "state.winner: actorId | 'draw' | null",
      replay: "verifyReplay(spec, transcript, state) must reproduce state + per-tick events",
    },
  };
}

/**
 * Vocabulary conformance check, used by the gate as its own stage: rejects
 * spec features that parse + validate but are NOT runnable engine blocks.
 */
export function vocabularyErrors(spec: {
  winConditions: Array<{ kind: string }>;
}): string[] {
  const errors: string[] = [];
  for (const w of spec.winConditions) {
    if (!IMPLEMENTED_WIN_KINDS.includes(w.kind)) {
      errors.push(
        `winConditions: kind "${w.kind}" is reserved but not implemented by the engine yet — ` +
          `use one of: ${IMPLEMENTED_WIN_KINDS.join(", ")}`,
      );
    }
  }
  if (spec.winConditions.length === 0) {
    errors.push("winConditions: at least one implemented win condition is required (games must be endable)");
  }
  return errors;
}
