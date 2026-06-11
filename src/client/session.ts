// Phase 4 — FID → player(actorId) mapping boundary.
//
// This is the ONE place a Farcaster identity (FID) becomes an engine SEAT (actorId). It lives
// ENTIRELY on the presentation/session side of the determinism boundary:
//   - The engine and the match log only ever see `actorId`s (spec seats).
//   - A viewer's FID is a label of WHO is sitting in a seat this session — NEVER a game input.
// So replay/determinism are untouched: the same actions submitted by the `human` seat replay
// identically no matter which FID produced them. Nothing in this file imports core/engine,
// core/step, or the SDK — keeping the auth boundary provably out of the deterministic core
// (it's the same discipline assets follow: presentation in, determinism untouched).
//
// Design rule, review-locked: FAIL-CLOSED. Absent/invalid identity, or no free seat, yields
// a spectator (watch-only) — a viewer is never silently granted a seat.

import type { ActorId, GameSpec } from "../core/types.ts";

/** The subset of `sdk.context.user` we consume. Kept local so the boundary does not couple to
 *  the SDK's evolving shape — the miniapp adapter maps the SDK object into this. */
export interface FarcasterViewer {
  fid: number;
  username?: string;
  displayName?: string;
}

/** The resolved session: which seat (if any) this viewer drives, plus a display label. */
export interface PlaySession {
  /** The Farcaster identity, or null when opened outside a Mini App host (no context). */
  viewer: FarcasterViewer | null;
  /** The seat this viewer controls, or null = spectator (watch-only). */
  seat: ActorId | null;
  /** Human-readable label for the status bar. */
  label: string;
}

/** True when `v` is a usable Farcaster identity (real, positive, finite FID). */
export function isValidViewer(v: FarcasterViewer | null | undefined): v is FarcasterViewer {
  return !!v && Number.isInteger(v.fid) && v.fid > 0;
}

/** The playable human seats in a spec, in spec order. Agent seats are never viewer-claimable. */
export function humanSeats(spec: GameSpec): ActorId[] {
  return spec.actors.filter((a) => a.kind === "human").map((a) => a.id);
}

/**
 * Map a Farcaster viewer to a seat — the auth boundary.
 *
 * FAIL-CLOSED in three ways:
 *   1. No/invalid identity (opened outside a Mini App, or host gave no user) → spectator.
 *   2. No free human seat → spectator (never bumps an occupant).
 *   3. Only `kind: "human"` seats are claimable; agent seats are never handed to a viewer.
 *
 * `claimed` maps an already-occupied seat → the FID holding it, letting a multi-seat host
 * pre-assign seats. It is idempotent: re-resolving the SAME fid returns the SAME held seat.
 * For the current single-human skirmish `claimed` is empty and any authenticated viewer takes
 * the lone `human` seat (1 player vs the agent).
 */
export function mapViewerToSeat(
  viewer: FarcasterViewer | null | undefined,
  spec: GameSpec,
  claimed: Partial<Record<ActorId, number>> = {},
): PlaySession {
  if (!isValidViewer(viewer)) {
    return { viewer: null, seat: null, label: "spectator · watch-only" };
  }
  const seats = humanSeats(spec);
  // Idempotent: if this FID already holds a seat, return it.
  const held = seats.find((s) => claimed[s] === viewer.fid);
  if (held) return { viewer, seat: held, label: seatLabel(viewer, held) };
  // Else take the first UNclaimed human seat.
  const free = seats.find((s) => claimed[s] === undefined);
  if (!free) return { viewer, seat: null, label: "spectator · all seats taken" };
  return { viewer, seat: free, label: seatLabel(viewer, free) };
}

function seatLabel(viewer: FarcasterViewer, seat: ActorId): string {
  const who = viewer.username ? `@${viewer.username}` : `fid:${viewer.fid}`;
  return `${who} → ${seat}`;
}
