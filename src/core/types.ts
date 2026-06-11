// mythosforge-engine — core types.
// The SINGLE source of truth the engine loads is GameSpec. Editors (human) and
// builder tools (agent) both emit this exact shape — one format, no fork.

/** Engine + spec versioning. Reserved now so logs don't silently rot (migration deferred). */
export const ENGINE_VERSION = "0.1.0" as const;

/** A fixed-point scalar (Q16.16). Stored as a plain integer = value * 65536.
 *  State math is integer/fixed-point ONLY — never JS floats — so the log is
 *  identical on any machine. See core/fixed.ts. */
export type Fixed = number & { readonly __fixed?: unique symbol };

/** Stable identifiers. */
export type ActorId = string;
export type EntityId = string;
export type RuleId = string;

// ---------------------------------------------------------------------------
// GameSpec — the one shared format (build side emits this; play side loads it).
// ---------------------------------------------------------------------------

export interface GameSpec {
  /** Reserved for migration; logs carry this so they don't rot against newer engines. */
  specVersion: number;
  meta: { name: string; authors?: string[] };
  map: MapSpec;
  /** Templates entities are spawned from. */
  entityTypes: Record<string, EntityTypeSpec>;
  /** Concrete entities present at match start. */
  entities: EntitySpec[];
  actors: ActorSpec[];
  /** The editable rule surface. `edit_rule` actions mutate these values at runtime,
   *  which is exactly what makes the match "rule-editable" by humans AND agents. */
  rules: RulesSpec;
  /** Asset URIs (sprites/audio) — filled by the mythosforge image services.
   *  GameSpec references assets; it never embeds pixels. */
  assets: Record<string, AssetRef>;
  winConditions: WinCondition[];
  /** How turns are paced. Read by the turn ORCHESTRATOR (runtime/turn.ts), NOT by the engine
   *  — the engine stays a pure resolver of whatever lands in a tick. Optional; a sensible
   *  default is derived from `actors` when absent. Lets a card game vs a tactics game (or a
   *  prompt-authored game) declare different turn economies from data. */
  turnModel?: TurnModel;
}

/** Turn economy, consumed only by the orchestrator. */
export interface TurnModel {
  /** Max actions each actor may take per turn. Default 1. */
  actionsPerActorPerTurn: number;
  /** simultaneous = every actor's actions resolve in ONE shared tick (seq-ordered);
   *  sequential = each actor's actions resolve in their own tick, in `order`. Default simultaneous. */
  resolution: "simultaneous" | "sequential";
  /** Actor ids in turn order. Default = the spec's `actors` order. */
  order: ActorId[];
}

export interface MapSpec {
  /** Grid dimensions in cells. */
  width: number;
  height: number;
  /** Optional per-cell blocking, row-major; absent = all passable. */
  blocked?: boolean[];
}

export interface EntityTypeSpec {
  stats: Record<string, Fixed>;
  assetKey?: string;
}

export interface EntitySpec {
  id: EntityId;
  type: string;
  owner: ActorId;
  pos: Cell;
  stats?: Record<string, Fixed>; // overrides on top of the type template
}

export interface ActorSpec {
  id: ActorId;
  /** How this actor is driven. Both share the same engine + action schema. */
  kind: "human" | "agent";
}

export interface Cell {
  x: number;
  y: number;
}

/** Tunable, editable rule values. Mutable at runtime via `edit_rule`.
 *  `allowedActions` gates the action schema; `params` holds numeric knobs;
 *  `editable` is the per-rule policy that bounds who may edit and to what range. */
export interface RulesSpec {
  allowedActions: ActionType[];
  params: Record<RuleId, number>; // integers only (e.g. moveRange: 1)
  /** Per-rule edit policy. A rule absent from this map is NOT editable at runtime,
   *  even if it exists in `params`. Present = editable within bounds, by allowed actors. */
  editable?: Record<RuleId, EditPolicy>;
}

/** Bounds + authority for one editable rule. */
export interface EditPolicy {
  min: number;
  max: number;
  /** Actor ids permitted to edit this rule. Omitted/empty = any actor may edit. */
  editableBy?: ActorId[];
}

export interface AssetRef {
  uri: string;
  kind: "sprite" | "audio";
}

export interface WinCondition {
  id: string;
  /** Declarative predicate evaluated by the (pure) rules module. Scaffold: stub. */
  kind: "eliminate_all" | "reach_cell" | "custom";
  params?: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Runtime state — derived from GameSpec, advanced only by `step`.
// ---------------------------------------------------------------------------

export interface State {
  tick: number;
  entities: Record<EntityId, EntityState>;
  /** Live copy of editable rule params (seeded from spec, then mutated by edit_rule). */
  ruleParams: Record<RuleId, number>;
  /** Set once a win condition fires. */
  winner: ActorId | "draw" | null;
}

export interface EntityState {
  id: EntityId;
  type: string;
  owner: ActorId;
  pos: Cell;
  stats: Record<string, Fixed>;
  alive: boolean;
}

// ---------------------------------------------------------------------------
// Action schema — every action is { type, actor, params }. Legality is DERIVED
// from GameSpec rules (see core/validate.ts), never hardcoded.
// ---------------------------------------------------------------------------

export type ActionType = "move" | "attack" | "edit_rule" | "pass";

export interface Action {
  type: ActionType;
  actor: ActorId;
  params: Record<string, number | string>;
}

// ---------------------------------------------------------------------------
// Match header + log. The header pins the match; the log is append-only and is
// the ONLY thing replay needs.
// ---------------------------------------------------------------------------

export interface MatchHeader {
  /** hash(canonicalize(GameSpec)) — pins which spec this match ran. */
  specHash: string;
  /** Seeds the integer PRNG. All nondeterminism flows from here. */
  seed: string;
  engineVersion: string;
  specVersion: number;
}

/** Sentinel seq for engine-generated per-tick system events (win-eval, regen). These have no
 *  intake `seq`. Ordering is positional, NOT seq-based: resolveTick appends them AFTER the
 *  tick's actor actions, and replay regenerates them in that same position — so the log is
 *  never sorted by seq. (Do not seq-sort the whole log: -1 would float system entries to the
 *  front. If a global seq-sort is ever needed, give system entries an end-of-tick ordinal.) */
export const SYSTEM_SEQ = -1;

/** One log entry: either an actor action + its resolved events, or an engine-generated
 *  per-tick system entry (action === null, seq === SYSTEM_SEQ).
 *  Records BOTH the submission `seq` AND the `tick` it was assigned to — replay
 *  re-folds (spec, seed, ordered actions→ticks) from these, never recomputing the
 *  tick cut from timing. */
export interface LogEntry {
  seq: number; // globally unique monotonic at intake (or SYSTEM_SEQ) — the total-order key
  tick: number; // the tick this entry was assigned to (recorded, not recomputed)
  action: Action | null; // null = engine-generated per-tick system events
  events: GameEvent[];
}

export type GameEvent =
  | { kind: "moved"; entity: EntityId; from: Cell; to: Cell }
  | { kind: "attacked"; attacker: EntityId; target: EntityId; damage: number; targetHpAfter: number }
  | { kind: "died"; entity: EntityId }
  | { kind: "rule_edited"; rule: RuleId; from: number; to: number }
  | { kind: "passed"; actor: ActorId }
  | { kind: "rejected"; action: Action; reason: string } // illegal → state unchanged
  | { kind: "win"; winner: ActorId | "draw" };

/** What `step` returns: the next state plus the events it produced. Pure. */
export interface StepResult {
  state: State;
  events: GameEvent[];
}

/** Injected context — the ONLY channel for nondeterminism into the pure core. */
export interface StepCtx {
  /** Seeded integer PRNG. Affects outcomes inside step, never legality. */
  rng: import("./prng.ts").Prng;
  /** Current tick (a counter, never the system clock). */
  tick: number;
}
