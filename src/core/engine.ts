// The match driver: turns a GameSpec + seed into a running match, folds `step` over
// a seq-ordered action queue, and produces the append-only log that IS the replay.
//
// Total order across concurrent actors: every submitted action gets a globally-unique,
// monotonic `seq` at intake. A tick's actions resolve strictly by `seq` ascending — that
// is the tie-break when a human and an agent act on the same tick. The log records BOTH
// the `seq` AND the `tick` each action was assigned to, so replay re-folds (spec, seed,
// ordered actions→ticks) from recorded data — the tick cut is never recomputed from timing.
//
// REPLAY EQUIVALENCE: live `tick()` and `replay()` call the SAME per-tick procedure
// (`resolveTick`) across the SAME full range 0..finalTick. So once a per-tick mechanic
// exists (combat, win-eval, regen, a per-tick rng draw), live and replay stay identical —
// "group log by observed tick and fold" would NOT have been equivalent.

import type { Action, GameEvent, GameSpec, LogEntry, MatchHeader, State } from "./types.ts";
import { ENGINE_VERSION, SYSTEM_SEQ } from "./types.ts";
import { canonicalize, hashCanonical } from "./canonicalize.ts";
import { makePrng, type Prng } from "./prng.ts";
import { step } from "./step.ts";
import { accrueCapturePoints, collectItemPickups, evaluateWin, spawnWaveEntities } from "./validate.ts";

/** A submitted-but-not-yet-resolved action, stamped with its order + tick assignment. */
interface PendingAction {
  seq: number;
  tick: number;
  action: Action;
}

/** Everything replay needs: the header, the log, and how many ticks actually elapsed
 *  (so replay runs EVERY tick 0..finalTick-1, including empty ones, not just logged ones). */
export interface Transcript {
  header: MatchHeader;
  log: LogEntry[];
  finalTick: number;
}

/** The single per-tick procedure. Called by BOTH live tick() and replay() so their
 *  behavior is identical across the full tick range — actions or not. Pure given (rng).
 *  `due` is this tick's actions in seq order. Returns next state + the log entries produced. */
function resolveTick(
  state: State,
  spec: GameSpec,
  rng: Prng,
  tick: number,
  due: readonly PendingAction[],
): { state: State; entries: LogEntry[] } {
  let s = state;
  const entries: LogEntry[] = [];
  for (const p of due) {
    const r = step(s, spec, p.action, { rng, tick });
    s = r.state;
    entries.push({ seq: p.seq, tick, action: p.action, events: r.events });
  }
  // Intrinsic per-tick mechanics run HERE (after this tick's actions), as system entries
  // (action: null, seq: SYSTEM_SEQ) so live and replay share one code path across the full
  // range. Fixed order: waves spawn → items collect → capture zones score → win-eval
  // sees the fresh world. All pure, all zero-RNG (waves are schedule-driven).
  // TODO(gameplay): per-tick status/regen, and resolve simultaneous adjacency if added.
  if (s.winner === null) {
    const systemEvents: GameEvent[] = [];
    const wave = spawnWaveEntities(s, spec, tick);
    if (wave) {
      s = { ...s, entities: wave.entities };
      for (const sp of wave.spawned) systemEvents.push({ kind: "spawned", ...sp });
    }
    const picked = collectItemPickups(s, spec);
    if (picked) {
      s = { ...s, items: picked.items, scores: picked.scores };
      for (const p of picked.picked) systemEvents.push({ kind: "collected", ...p });
    }
    const cap = accrueCapturePoints(s, spec);
    if (cap) {
      s = { ...s, scores: cap.scores };
      for (const g of cap.gains) systemEvents.push({ kind: "scored", ...g });
    }
    if (systemEvents.length > 0) {
      entries.push({ seq: SYSTEM_SEQ, tick, action: null, events: systemEvents });
    }
  }
  if (s.winner === null) {
    const winner = evaluateWin(s, spec);
    if (winner !== null) {
      s = { ...s, winner };
      entries.push({ seq: SYSTEM_SEQ, tick, action: null, events: [{ kind: "win", winner }] });
    }
  }
  return { state: s, entries };
}

export class Match {
  readonly header: MatchHeader;
  private readonly spec: GameSpec;
  private state: State;
  private rng: Prng;
  private nextSeq = 0;
  private pending: PendingAction[] = [];
  readonly log: LogEntry[] = [];

  constructor(spec: GameSpec, seed: string) {
    this.spec = spec;
    this.state = initialState(spec);
    this.rng = makePrng(seed);
    this.header = {
      specHash: hashCanonical(spec),
      seed,
      engineVersion: ENGINE_VERSION,
      specVersion: spec.specVersion,
    };
  }

  /** Intake. Assigns the monotonic seq + the current tick. Does NOT advance state —
   *  resolution happens in tick(), so order within a tick is by seq, not arrival. */
  submit(action: Action): number {
    const seq = this.nextSeq++;
    this.pending.push({ seq, tick: this.state.tick, action });
    return seq;
  }

  /** Resolve this tick's actions (seq order) via the shared per-tick procedure, then advance. */
  tick(): void {
    const t = this.state.tick;
    const due = this.pending.filter((p) => p.tick === t).sort((a, b) => a.seq - b.seq);
    this.pending = this.pending.filter((p) => p.tick !== t);

    const { state, entries } = resolveTick(this.state, this.spec, this.rng, t, due);
    this.state = state;
    for (const e of entries) this.log.push(e);
    this.state = { ...this.state, tick: t + 1 };
  }

  getState(): State {
    return this.state;
  }

  /** finalTick = number of ticks elapsed = current tick counter. Replay needs this to run
   *  the full range including trailing/empty ticks. */
  get finalTick(): number {
    return this.state.tick;
  }

  transcript(): Transcript {
    return { header: this.header, log: this.log, finalTick: this.finalTick };
  }
}

/** Build initial runtime state from a GameSpec. Pure. */
export function initialState(spec: GameSpec): State {
  const entities: State["entities"] = {};
  for (const e of spec.entities) {
    const tmpl = spec.entityTypes[e.type];
    entities[e.id] = {
      id: e.id,
      type: e.type,
      owner: e.owner,
      pos: { ...e.pos },
      stats: { ...(tmpl?.stats ?? {}), ...(e.stats ?? {}) },
      alive: true,
    };
  }
  const scores: State["scores"] = {};
  for (const a of spec.actors) scores[a.id] = 0;
  const items: State["items"] = {};
  for (const it of spec.items ?? []) items[it.id] = false;
  return {
    tick: 0,
    entities,
    ruleParams: { ...spec.rules.params },
    scores,
    items,
    winner: null,
  };
}

/** Replay a transcript against a fresh match → must reproduce the SAME full state.
 *  Runs EVERY tick 0..finalTick-1 through the same `resolveTick` as live, in recorded
 *  seq order, never recomputing the tick cut from timing.
 *
 *  FAIL-CLOSED: verifies the caller's spec actually matches header.specHash and that the
 *  engine version matches, before folding. A mismatched spec throws rather than silently
 *  producing wrong state. */
export function replay(spec: GameSpec, transcript: Transcript): State {
  return replayDetailed(spec, transcript).state;
}

/** Replay that also reconstructs the log it regenerates — used by `verifyReplay` for the
 *  event-level equality check. Same fail-closed guards and full-range fold as `replay`. */
export function replayDetailed(spec: GameSpec, transcript: Transcript): { state: State; log: LogEntry[] } {
  const { header, log, finalTick } = transcript;
  if (hashCanonical(spec) !== header.specHash) {
    throw new Error("replay: spec does not match header.specHash (refusing to fold wrong state)");
  }
  if (header.engineVersion !== ENGINE_VERSION) {
    throw new Error(
      `replay: engineVersion mismatch (log=${header.engineVersion}, engine=${ENGINE_VERSION})`,
    );
  }

  // Index logged ACTOR actions by recorded tick (system entries are regenerated, not replayed).
  const byTick = new Map<number, PendingAction[]>();
  for (const entry of log) {
    if (entry.action === null) continue; // system entries are recomputed by resolveTick
    const bucket = byTick.get(entry.tick) ?? [];
    bucket.push({ seq: entry.seq, tick: entry.tick, action: entry.action });
    byTick.set(entry.tick, bucket);
  }

  let state = initialState(spec);
  const rebuilt: LogEntry[] = [];
  const rng = makePrng(header.seed);
  for (let t = 0; t < finalTick; t++) {
    state = { ...state, tick: t };
    const due = (byTick.get(t) ?? []).sort((a, b) => a.seq - b.seq);
    const r = resolveTick(state, spec, rng, t, due);
    state = { ...r.state, tick: t + 1 };
    rebuilt.push(...r.entries);
  }
  return { state, log: rebuilt };
}

/** Banked insurance: assert the replay reproduces BOTH the final state AND the per-tick
 *  events — an event-level divergence can hide behind a coincidentally-equal final state.
 *  Returns a structured verdict so tests/callers can see which half diverged. */
export function verifyReplay(
  spec: GameSpec,
  transcript: Transcript,
  liveFinalState: State,
): { ok: boolean; stateOk: boolean; eventsOk: boolean } {
  const r = replayDetailed(spec, transcript);
  const stateOk = canonicalize(r.state) === canonicalize(liveFinalState);
  const eventsOk = canonicalize(r.log) === canonicalize(transcript.log);
  return { ok: stateOk && eventsOk, stateOk, eventsOk };
}
