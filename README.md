# ForgeEngine

**ForgeEngine** (`@mythosforge/forgeengine`) — an agent-native, deterministic game engine: **one core, four doors**. Any AI can build games for it, safely — see [KIT.md](KIT.md) for the Open Engine Kit (vocabulary, safety gate, CLI, AI-play contract). MIT licensed.

```
agent ─plays→ ┐                          ┌ ←builds─ agent
              ├─► [ Action API ] ──┐  ┌── [ GameSpec ] ◄─┤
human ─plays→ ┘                    ▼  ▼                  └ ←builds─ human
                            ┌──────────────────┐
                            │  deterministic    │   pure step(state, action, ctx)
                            │   ENGINE CORE     │   → append-only event log → replay
                            └──────────────────┘
```

Agents and humans are just different **interfaces** over the same core. Play-side shares one
engine; build-side shares one **GameSpec** format. That's what makes the 2×2 one product, not four.

## Spec v1 contracts (reviewed)

1. **Total order across concurrent actors** — every submitted action gets a globally-unique,
   monotonic `seq` at intake (`Match.submit`). A tick resolves its actions strictly by `seq`
   ascending. The log records **both `seq` and the assigned `tick`**, so replay re-folds from
   recorded data — the tick cut is never recomputed from timing. (`core/engine.ts`)
   - **Replay equivalence:** live `tick()` and `replay()` call the SAME per-tick procedure
     (`resolveTick`) across the SAME full range `0..finalTick` — including empty ticks. So once a
     per-tick mechanic exists (combat, win-eval, regen, a per-tick rng draw) live and replay stay
     identical. A `Transcript` carries `finalTick` so replay runs every tick, not just logged ones.
   - **Fail-closed:** `replay` verifies `hashCanonical(spec) === header.specHash` and the engine
     version BEFORE folding — a mismatched spec throws rather than silently producing wrong state.
2. **Integer/fixed-point only** — state math uses ints or Q16.16 (`core/fixed.ts`); no JS floats
   touch state, so the log is identical on any machine. Floats are renderer-only (outside the
   determinism boundary). `canonicalize` rejects non-integers as a guardrail.
3. **Canonical serialization** — one `canonicalize()` feeds both `specHash` and log hashing
   (`core/canonicalize.ts`). `specHash = hashCanonical(GameSpec)`.
4. **`observe(state, actorId)` per-actor projection from day one** (`core/observe.ts`) — MVP is
   full-information, but the signature never has to break for hidden info.

Reserved/locked: `specVersion` + `engineVersion` in every match header (migration deferred);
`isLegal` is **pure, zero-RNG** (RNG only colors outcomes inside `step`, never legality); the
validator + legality live in **one shared module** (`core/validate.ts`) imported by engine,
editor, and builder — the editor cannot drift from the engine.

## Layout

```
src/core/
  types.ts         GameSpec, Action, State, MatchHeader, LogEntry, events
  fixed.ts         Q16.16 fixed-point (BigInt-exact mul/div)
  prng.ts          SplitMix64 seeded integer PRNG
  canonicalize.ts  canonical JSON + specHash
  validate.ts      validateSpec + isLegal/legalActions  (ONE shared module, pure, no RNG)
  step.ts          the pure transition  step(state, spec, action, ctx)
  engine.ts        Match driver (seq intake, tick fold, log) + replay()
  observe.ts       per-actor observation projection
skirmish/spec.ts   the MVP match — one rule-editable human-vs-agent skirmish
demo.ts            runnable smoke: all four doors + replay-determinism check
```

## Gameplay (skirmish v1)

- **Combat** — an `attack` action (`{ entity, target }`), legal vs. an adjacent enemy within
  `attackRange`. Legality is RNG-free; the **damage roll uses RNG inside `step` only** (base
  `attack` stat + `rng.int(attackVariance+1)`), so an agent's enumerated legal set never depends
  on the roll. hp is Q16.16; at ≤0 the entity dies (`attacked` + `died` events).
- **Win-condition eval** — an intrinsic **per-tick** mechanic in `resolveTick` (not an action).
  `eliminate_all` → last actor with living units wins; none → draw. Emitted as a **system log
  entry** (`action: null`, `seq: SYSTEM_SEQ`). Once `winner` is set, all further actions are
  rejected `"match is over"`.
- **Edit policy** — `rules.editable[rule] = { min, max, editableBy? }`. `edit_rule` is gated on
  bounds AND authority (e.g. in the skirmish, `moveRange` is editable by both players in [1,3];
  `attackRange` is agent-only in [1,2]). A rule absent from `editable` is not runtime-editable.
- **Replay insurance** — `verifyReplay` asserts the replay reproduces BOTH final state AND the
  per-tick event stream (an event-level divergence can hide behind a coincidentally-equal final
  state). System per-tick entries are recomputed by `resolveTick`, not replayed from the log.

## Turn orchestrator & arena (Phase 3)

The *turn economy* (a game rule) lives ABOVE the engine in `runtime/turn.ts`, not inside it —
the engine stays a pure resolver of whatever lands in a tick. The orchestrator reads
`spec.turnModel` DATA (`actionsPerActorPerTurn`, `simultaneous` vs `sequential`, `order`) with a
sensible default, and the SAME `runTurn` backs both the Phaser client and the headless arena, so
matches are paced identically across doors. `validateSpec` validates `turnModel` too, so it also
gates Phase-5 prompt-generated specs.

- `runtime/turn.ts` — `turnModelFor`, `runTurn`, `runToEnd`; `ActorController = (state, spec, actor) => Action | Action[]`.
- `arena/run.ts` — `runMatch` / `runSeries`: two agent policies drive the action API headless,
  each match yields a replay-verified `Transcript`, series yields a ranking.

## Run

```
npm install
npx tsc -p tsconfig.json --noEmit   # typecheck (clean)
npm test                            # 16 tests: combat, win, edit policy, replay, turn model, arena
npx tsx src/demo.ts                 # engine smoke + replay check
npm run arena                       # headless AI-vs-AI series + leaderboard (replay-verified)
npm run dev                         # the Phaser board (human vs agent)
```

## Still TODO(gameplay)

Marked inline: `reach_cell`/`custom` win predicates, per-tick status/regen, asset-effect wiring,
fog-of-war projection in `observe`, and resolving simultaneous adjacency if a same-tick mutual-
attack rule is added. Contracts are settled so these land without interface churn.
