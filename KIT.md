# ForgeEngine — the Open Engine Kit

**A deterministic, replay-verifiable game engine that any AI can build games for — safely.**

Brand: **ForgeEngine** · package `@mythosforge/forgeengine` · repo `ryjin111/forgeengine` · MIT.

An AI (Claude, Fable, Codex, GPT, anything) writes a game as **data** — a `GameSpec`
JSON composed from a small, typed vocabulary. The kit's **safety gate** decides whether
that spec can be trusted: it must parse, fit resource limits, use only implemented
building blocks, validate semantically, and **provably run** (seeded headless matches,
each replay-verified). Only then does it reach the engine — where it is deterministic,
fully replayable, AI-playable through a standard contract, and renderable as a
**Farcaster Mini App** for in-feed play.

```
your AI ──writes──▶ GameSpec JSON ──▶ THE GATE ──trusted──▶ engine: play / replay / arena
                                        │                      │
                                        ▼ rejected             ▼
                              actionable error list      Farcaster Mini App (in-feed)
```

**Nothing reaches the engine without passing the gate.** The gate is fail-closed:
parse errors, oversized maps, unimplemented blocks, semantic violations, crashes,
replay divergence, games that are over before they start, seats that can't move —
all reject with a machine-readable error list your AI can repair against (capped).

## Quickstart

```bash
npm install

# 1. The building-blocks catalog — hand this to your model:
npm run kit -- vocab

# 2. Your model writes mygame.json. Gate it:
npm run kit -- validate mygame.json     # exit 0 = trusted

# 3. Play a headless, replay-verified match:
npm run kit -- run mygame.json --seed demo

# Worked examples:
npm run kit -- validate examples/skirmish.json              # passes
npm run kit -- validate examples/rejected-unwinnable.json   # rejected: reserved win kind
```

## What an AI needs to know (the 4 documents-in-one)

### 1. The spec format
A `GameSpec` is pure data (see `src/core/types.ts`): `meta`, `map` (w×h grid, optional
blocked cells), `entityTypes` (stat templates), `entities` (placed instances with an
owner), `actors` (seats: `human` | `agent` — every seat is AI-playable), `rules`
(`allowedActions` subset + numeric `params` + optional bounded `editable` policies),
`assets` (presentation-only references), `winConditions`, optional `turnModel`.

### 2. The bounded vocabulary (`npm run kit -- vocab`)
The Ludii-style "small Lego set". Compose ONLY from it:
- **actions:** `move`, `attack`, `edit_rule`, `pass`
- **win kinds:** `eliminate_all` (last side standing), `reach_cell` (racing/objective —
  first unit on the goal cell; unreachable goals are rejected statically), `survive_turns`
  (survival — sole survivor at the deadline wins, several = draw), `score_target`
  (deathmatch/points — kills award the `killScore` rule param; unachievable or
  editable-to-unwinnable targets are rejected statically), `capture_point`
  (king-of-the-hill — holding the zone at {x,y} awards {perTick} points each tick,
  first to {target} wins; unreachable zones rejected statically). `custom` is reserved —
  the gate REJECTS reserved kinds until the engine implements them (no silently-unwinnable games).
- **mechanics:** `items` (collectibles — walk on one, your owner scores its points) and
  `waves` (scheduled reinforcements — spawn at exactly their tick, zero RNG; pending waves
  count as presence for eliminate_all). Score sources: kills × `killScore`, items, capture zones.
- **turn models:** `simultaneous` | `sequential`, N actions per actor per turn
- **limits (gate-enforced):** map ≤ 1024 cells, ≤ 64 entities (wave reinforcements counted), ≤ 8 actors
The vocabulary is pinned to engine reality by `test/kit.test.ts` — docs cannot drift.

### 3. The AI-play contract (how any agent plays any gated game)
- `observe(state, actor)` → per-actor projection (full-info today; the signature
  already supports hidden info later)
- `legalActions(state, spec, actor)` → every action the engine will accept — the
  enumerated set IS the accepted set, no guessing
- `match.submit(action)` → seq; `match.tick()` resolves in seq order; illegal actions
  reject with a reason, never corrupt state
- `state.winner` → `actorId | "draw" | null`
- `verifyReplay(spec, transcript, state)` → the match reproduces exactly: same final
  state AND same per-tick event stream, on any machine (integer/Q16.16 state math)
Every shipped example is tested against this contract — generated specs get the same
guarantee as hand-authored ones.

### 4. The repair loop (for spec-generating pipelines)
`gateSpec(candidate, { repair, limits })` accepts an injected repair callback: on
rejection your model gets the error list, returns a new candidate, and the FULL
pipeline re-runs (repaired output is still untrusted). Capped (default 2); cap
exhaustion is a hard reject — there is no best-effort spec.

## Farcaster-native

The target surface is Farcaster: the kit ships the Mini App door (`miniapp.html`,
`src/client/miniapp.ts`) where a gated game runs **in-feed** — viewers get a seat via
fail-closed FID→seat mapping, or spectate. The web door (`index.html`) supports
`?spec=<url>` loading: the fetched JSON goes **through the gate** before the board
ever sees it; rejection falls back to the built-in skirmish with the reasons shown.
Publishing in-feed for real requires the standard Farcaster go-live items (public
HTTPS domain + signed `accountAssociation`).

## Trust model (why an AI-built game can't hurt you)

| Threat | Wall |
|---|---|
| Malformed / hostile JSON | `parseSpec` — never throws, types everything |
| Resource bombs (10⁶-cell maps) | limits stage, before anything walks the map |
| Valid-but-unrunnable blocks | vocabulary stage (reserved win kinds, endless games) |
| Semantic cheats (out-of-bounds, ghost owners, unbounded rule edits) | `validateSpec` |
| Crashes / nondeterminism | playability stage: seeded matches, replay-verified |
| Born-finished games / stuck seats | degeneracy checks on the initial state |
| Spec mutation after trust | accepted specs are deep-frozen |
| LLM code execution | impossible by construction — specs are DATA, never code |

Engine core: pure `step(state, spec, action, ctx)`, RNG only on damage (never
legality), seq total-order, single shared resolve path for live and replay.
