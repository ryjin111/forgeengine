// Phase 4 — Farcaster Mini App: WATCH shell + in-feed PLAY door.
//
// This is a HOST around the EXISTING board, not a second renderer. It mounts the very same
// `BoardScene` over the same deterministic engine. Which mode the viewer gets is decided by the
// FID → seat mapping boundary (session.ts):
//   - seated viewer  -> PLAY: input enabled, the viewer drives the `human` seat vs the agent,
//                       through the scene's existing commitRound()/runTurn() path. NO turn logic
//                       is re-baked here — pacing is the shared orchestrator (runtime/turn.ts).
//   - spectator      -> WATCH: input disabled, both actors auto-played, matches loop.
//
// Open Engine Kit door (Farcaster-native): `?spec=<url>` loads an EXTERNAL GameSpec — e.g. one an
// AI just generated — but it ONLY reaches the board through the full safety gate (parse → limits
// → vocabulary → validate → playability), exactly like the main board's loader. Rejection or any
// error falls back to the built-in skirmish with the gate's reasons logged. No un-gated spec ever
// touches the engine — that's the public boundary that makes it safe to load untrusted AI games
// in-feed. The FID → seat mapping then runs against whatever spec the gate cleared.
//
// The public shell ships with ZERO keys/endpoints — keyless procedural assets only; the real
// MythosForge image service is wired via env later.

import Phaser from "phaser";
import { sdk } from "@farcaster/miniapp-sdk";
import { skirmishSpec } from "../skirmish/spec.ts";
import { gateSpec } from "../builder/gate.ts";
import { BoardScene } from "./scene.ts";
import { proceduralProvider } from "./assets.ts";
import { mapViewerToSeat, humanSeats, type FarcasterViewer } from "./session.ts";
import type { GameSpec } from "../core/types.ts";

const CELL = 64;

const logEl = document.getElementById("log")!;
const statusEl = document.getElementById("status")!;
const mrEl = document.getElementById("mr")!;
const seatEl = document.getElementById("seat")!;
const controlsEl = document.getElementById("controls")!;

function logLine(text: string): void {
  const div = document.createElement("div");
  div.textContent = text;
  logEl.prepend(div);
}

// Assigned in boot() once the (gated) spec is resolved — the watch/play helpers read these.
let spec: GameSpec;
let scene: BoardScene;
let game: Phaser.Game;

// --- gated spec resolution (mirrors src/client/main.ts — same public boundary) -----------------
/** Resolve the spec to play: gated external `?spec=` if present, else the built-in skirmish. */
async function resolveSpec(): Promise<GameSpec> {
  const url = new URLSearchParams(location.search).get("spec");
  if (!url) return skirmishSpec;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Pre-parse guards (kit review): a hostile URL must not feed us a huge or non-JSON body
    // before the gate even sees it. 1MB is ~50x the largest legitimate spec under the gate limits.
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("json") && !type.includes("text/plain")) {
      throw new Error(`unexpected content-type "${type}" — expected JSON`);
    }
    const body = await res.text();
    if (body.length > 1_000_000) throw new Error("spec body exceeds 1MB cap");
    const candidate: unknown = JSON.parse(body);
    const verdict = await gateSpec(candidate);
    if (verdict.ok) {
      logLine(`✓ external spec "${verdict.spec.meta.name}" passed the gate — playing it`);
      if (verdict.timedOut) logLine("⚠ gate note: a playability match hit the turn cap");
      return verdict.spec;
    }
    logLine(`✗ external spec REJECTED at "${verdict.stage}" — falling back to built-in skirmish`);
    for (const e of verdict.errors.slice(0, 5)) logLine(`  - ${e}`);
    return skirmishSpec;
  } catch (err) {
    logLine(`✗ could not load external spec (${err instanceof Error ? err.message : String(err)}) — using built-in`);
    return skirmishSpec;
  }
}

// --- SDK adapter: read the viewer identity, fail-closed to null --------------------------------
// `sdk.context` resolves to the host context inside a Mini App and hangs/throws outside one.
// We race it against a short timeout and swallow errors → a missing identity becomes `null`,
// which the boundary maps to spectator. The SDK shape is mapped into our local FarcasterViewer
// so session.ts stays decoupled from the SDK.
async function readViewer(): Promise<FarcasterViewer | null> {
  try {
    const ctx = (await Promise.race([
      sdk.context,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 1500)),
    ])) as { user?: { fid?: number; username?: string; displayName?: string } } | undefined;
    const u = ctx?.user;
    if (!u || typeof u.fid !== "number") return null;
    // Build conditionally so optional keys are omitted, not set to `undefined`
    // (the project compiles with exactOptionalPropertyTypes).
    const v: FarcasterViewer = { fid: u.fid };
    if (u.username !== undefined) v.username = u.username;
    if (u.displayName !== undefined) v.displayName = u.displayName;
    return v;
  } catch {
    return null;
  }
}

// --- read-only WATCH driver (spectator) --------------------------------------------------------
// autoStep() drives BOTH actors via the agent policy through the SAME shared turn-orchestrator
// the live board uses, so a watched match is paced identically to a played one. autoStep()
// self-guards on busy/winner, so polling it on a timer is safe.
const STEP_MS = 800;
const RESTART_AFTER = 4; // ~3.2s lingering on the win banner, then loop a fresh match
let overTicks = 0;

function isOver(): boolean {
  return !!statusEl.querySelector(".banner");
}

function watchTick(): void {
  // Before the scene's create() runs, its methods touch an undefined Match and throw; swallow
  // those few early ticks, then run the loop once the board is live.
  try {
    if (isOver()) {
      if (++overTicks >= RESTART_AFTER) {
        scene.reset();
        overTicks = 0;
      }
      return;
    }
    overTicks = 0;
    scene.autoStep();
  } catch {
    /* scene not booted yet — retry next tick */
  }
}

// --- mode selection ----------------------------------------------------------------------------
async function boot(): Promise<void> {
  // Resolve the (gated) spec FIRST, then mount the same scene over it. An external AI-generated
  // game only gets here if it passed the gate; otherwise this is the built-in skirmish.
  spec = await resolveSpec();
  scene = new BoardScene({ spec, cell: CELL, logEl, statusEl, mrEl, provider: proceduralProvider });
  game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: "game",
    width: spec.map.width * CELL,
    height: spec.map.height * CELL,
    backgroundColor: "#0b0f17",
    scene,
  });

  const viewer = await readViewer();
  // The boundary: identity → seat, against whatever spec the gate cleared.
  const session = mapViewerToSeat(viewer, spec);
  seatEl.textContent = session.label;

  if (session.seat && humanSeats(spec).includes(session.seat)) {
    enterPlayMode(); // seated viewer plays a human seat vs the agent
  } else {
    enterWatchMode(); // spectator: auto-play loop
  }

  // Signal the Farcaster host the app is up (dismisses splash). No-op/harmless outside a host;
  // never allowed to throw back into the app.
  void sdk.actions.ready().catch(() => {});
}

function enterWatchMode(): void {
  seatEl.dataset.mode = "watch";
  // Drop pointer input so a viewer can't steer the watched match.
  if (scene.input) scene.input.enabled = false;
  if (game.input) game.input.enabled = false;
  controlsEl.style.display = "none";
  setInterval(watchTick, STEP_MS);
}

function enterPlayMode(): void {
  seatEl.dataset.mode = "play";
  // The scene's existing play door (onClick → commitRound → runTurn) already drives the `human`
  // seat against the agent. We just leave input enabled and surface the controls. No watch loop.
  controlsEl.style.display = "flex";
  document.getElementById("pass")!.addEventListener("click", () => scene.passTurn());
  document.getElementById("reset")!.addEventListener("click", () => scene.reset());
  document.getElementById("mrUp")!.addEventListener("click", () => scene.editMoveRange(1));
  document.getElementById("mrDown")!.addEventListener("click", () => scene.editMoveRange(-1));
}

void boot();
