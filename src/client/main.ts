// Bootstrap: mount the Phaser board scene over the deterministic engine, and wire the DOM
// controls to scene methods. The scene owns the Match; this file is just the shell + buttons.
//
// Open Engine Kit door: `?spec=<url>` loads an EXTERNAL GameSpec — e.g. one an AI just
// generated — but it only reaches the board through the full safety gate (parse → limits
// → vocabulary → validate → playability). Rejection falls back to the built-in skirmish
// with the gate's reasons logged. No un-gated spec ever touches the engine.

import Phaser from "phaser";
import { skirmishSpec } from "../skirmish/spec.ts";
import { gateSpec } from "../builder/gate.ts";
import { BoardScene } from "./scene.ts";
import { proceduralProvider, mythosforgeProvider, type AssetProvider } from "./assets.ts";
import type { GameSpec } from "../core/types.ts";

const CELL = 76;

const logEl = document.getElementById("log")!;
const statusEl = document.getElementById("status")!;
const mrEl = document.getElementById("mr")!;

function logLine(text: string): void {
  const div = document.createElement("div");
  div.textContent = text;
  logEl.prepend(div);
}

/** Resolve the spec to play: gated external `?spec=` if present, else the built-in. */
async function resolveSpec(): Promise<GameSpec> {
  const url = new URLSearchParams(location.search).get("spec");
  if (!url) return skirmishSpec;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Pre-parse guards (kit review): a hostile URL must not feed us a
    // huge or non-JSON body before the gate even sees it. 1MB is ~50x the
    // largest legitimate spec under the gate's own resource limits.
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

async function boot(): Promise<void> {
  const spec = await resolveSpec();

  // Showcase polish: the page introduces the LOADED game, not the built-in one.
  document.title = `ForgeEngine — ${spec.meta.name}`;
  const h1 = document.querySelector("h1");
  if (h1) {
    h1.innerHTML = "";
    h1.append(`ForgeEngine — ${spec.meta.name} `);
    const small = document.createElement("small");
    small.textContent = "· human vs agent · gate-validated, replay-verifiable";
    h1.append(small);
  }

  // Phase 2 asset provider. Default = procedural (works with zero keys). To use real generated
  // art, swap to the MythosForge image service once the image-service endpoint + auth are configured:
  //   const provider = mythosforgeProvider({ endpoint: import.meta.env.VITE_MF_IMAGE_URL });
  // It stays behind the AssetProvider interface either way, so the engine never sees a pixel.
  void mythosforgeProvider; // referenced so the real-art provider ships wired but unused-by-default
  const provider: AssetProvider = proceduralProvider;

  const scene = new BoardScene({ spec, cell: CELL, logEl, statusEl, mrEl, provider });

  new Phaser.Game({
    type: Phaser.AUTO,
    parent: "game",
    width: spec.map.width * CELL,
    height: spec.map.height * CELL,
    backgroundColor: "#0b0f17",
    scene,
  });

  document.getElementById("pass")!.addEventListener("click", () => scene.passTurn());
  document.getElementById("auto")!.addEventListener("click", () => scene.autoStep());
  document.getElementById("reset")!.addEventListener("click", () => scene.reset());
  document.getElementById("mrUp")!.addEventListener("click", () => scene.editMoveRange(1));
  document.getElementById("mrDown")!.addEventListener("click", () => scene.editMoveRange(-1));
}

void boot();
