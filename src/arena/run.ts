// Phase 3 — the headless AI arena. Two agent policies drive the SAME engine through the SAME
// turn orchestrator the Phaser client uses (runtime/turn.ts), so an arena match and a watched
// match are paced identically and directly comparable. Each match yields a replayable
// Transcript; many matches yield a ranking. No rendering, no human — pure agent-vs-agent.

import { Match, verifyReplay, type Transcript } from "../core/engine.ts";
import { runToEnd, type ActorController } from "../runtime/turn.ts";
import type { GameSpec } from "../core/types.ts";

const MAX_TURNS = 500;

export interface MatchResult {
  seed: string;
  winner: string | "draw" | null;
  turns: number;
  transcript: Transcript;
  /** Full determinism guarantee: the transcript replays to the SAME final state AND the same
   *  per-tick event stream — not just the same winner (a mid-match divergence can spare the
   *  winner). Uses verifyReplay so the arena's "every match verifiable" claim is airtight. */
  replayOk: boolean;
  /** True if the match hit the turn cap unresolved (a stuck pairing) — distinct from a genuine
   *  draw, so the two never get conflated in scoring. */
  timedOut: boolean;
}

/** Run one headless match between named controllers. The agents are just policies over the
 *  action API — exactly what an external agent would do via observe()/legalActions()/submit(). */
export function runMatch(spec: GameSpec, seed: string, controllers: Record<string, ActorController>): MatchResult {
  const match = new Match(spec, seed);
  const turns = runToEnd(match, spec, controllers, MAX_TURNS);
  const transcript = match.transcript();
  const winner = match.getState().winner;
  // runToEnd only stops early on a decided match; a null winner here means it hit the cap.
  const timedOut = winner === null;
  if (timedOut) console.warn(`[arena] match seed=${seed} hit the ${MAX_TURNS}-turn cap unresolved`);
  const replayOk = verifyReplay(spec, transcript, match.getState()).ok;
  return { seed, winner, turns, transcript, replayOk, timedOut };
}

export interface Standing {
  actor: string;
  wins: number;
  losses: number;
  draws: number;
  /** Matches that hit the turn cap unresolved — counted separately from draws, scored 0. */
  timeouts: number;
  points: number; // win=3, draw=1, timeout=0
}

/** Run a series of matches across seeds and tabulate a simple ranking. Seeds are passed in
 *  (no Date/Math.random) so the whole tournament is reproducible. */
export function runSeries(
  spec: GameSpec,
  seeds: string[],
  controllers: Record<string, ActorController>,
): { results: MatchResult[]; table: Standing[] } {
  const standings = new Map<string, Standing>();
  const ensure = (a: string) => {
    let s = standings.get(a);
    if (!s) { s = { actor: a, wins: 0, losses: 0, draws: 0, timeouts: 0, points: 0 }; standings.set(a, s); }
    return s;
  };
  for (const a of Object.keys(controllers)) ensure(a);

  const results: MatchResult[] = [];
  for (const seed of seeds) {
    const r = runMatch(spec, seed, controllers);
    results.push(r);
    if (r.timedOut) {
      for (const a of Object.keys(controllers)) ensure(a).timeouts++; // unresolved → no points
    } else if (r.winner === "draw") {
      for (const a of Object.keys(controllers)) { const s = ensure(a); s.draws++; s.points += 1; }
    } else {
      for (const a of Object.keys(controllers)) {
        const s = ensure(a);
        if (a === r.winner) { s.wins++; s.points += 3; } else { s.losses++; }
      }
    }
  }
  const table = [...standings.values()].sort((a, b) => b.points - a.points || b.wins - a.wins);
  return { results, table };
}
