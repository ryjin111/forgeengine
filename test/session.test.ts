// Phase 4 — tests for the FID → seat auth boundary. These run headless (the module imports no
// Phaser/SDK), proving the mapping is a pure, deterministic, fail-closed function.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mapViewerToSeat, humanSeats, isValidViewer } from "../src/client/session.ts";
import { skirmishSpec } from "../src/skirmish/spec.ts";
import type { GameSpec } from "../src/core/types.ts";

// A two-human spec to exercise multi-seat claiming (the skirmish has only one human seat).
const twoHumanSpec: GameSpec = {
  ...skirmishSpec,
  actors: [
    { id: "p1", kind: "human" },
    { id: "p2", kind: "human" },
    { id: "ai", kind: "agent" },
  ],
};

test("humanSeats returns only human-kind seats, in spec order", () => {
  assert.deepEqual(humanSeats(skirmishSpec), ["human"]);
  assert.deepEqual(humanSeats(twoHumanSpec), ["p1", "p2"]);
});

test("isValidViewer rejects null, zero, negative, and non-integer fids", () => {
  assert.equal(isValidViewer(null), false);
  assert.equal(isValidViewer(undefined), false);
  assert.equal(isValidViewer({ fid: 0 }), false);
  assert.equal(isValidViewer({ fid: -3 }), false);
  assert.equal(isValidViewer({ fid: 1.5 }), false);
  assert.equal(isValidViewer({ fid: NaN }), false);
  assert.equal(isValidViewer({ fid: 42 }), true);
});

test("FAIL-CLOSED: no identity → spectator (no seat)", () => {
  const s = mapViewerToSeat(null, skirmishSpec);
  assert.equal(s.seat, null);
  assert.equal(s.viewer, null);
  assert.match(s.label, /spectator/);
});

test("FAIL-CLOSED: invalid fid → spectator (no seat)", () => {
  assert.equal(mapViewerToSeat({ fid: 0 }, skirmishSpec).seat, null);
  assert.equal(mapViewerToSeat({ fid: -1 }, skirmishSpec).seat, null);
});

test("a valid viewer takes the lone human seat in the skirmish", () => {
  const s = mapViewerToSeat({ fid: 99, username: "alice" }, skirmishSpec);
  assert.equal(s.seat, "human");
  assert.equal(s.viewer?.fid, 99);
  assert.equal(s.label, "@alice → human");
});

test("label falls back to fid: when no username", () => {
  assert.equal(mapViewerToSeat({ fid: 7 }, skirmishSpec).label, "fid:7 → human");
});

test("agent seats are never claimable (mapping only sees human seats)", () => {
  // An all-agent spec offers no seat to any viewer.
  const allAgent: GameSpec = { ...skirmishSpec, actors: [{ id: "agent", kind: "agent" }] };
  const s = mapViewerToSeat({ fid: 5 }, allAgent);
  assert.equal(s.seat, null);
  assert.match(s.label, /all seats taken|spectator/);
});

test("multi-seat: viewer takes first UNclaimed human seat", () => {
  // p1 already held by fid 100; a new viewer gets p2.
  const s = mapViewerToSeat({ fid: 200, username: "bob" }, twoHumanSpec, { p1: 100 });
  assert.equal(s.seat, "p2");
});

test("multi-seat is idempotent: same fid re-resolves to its held seat", () => {
  // fid 100 holds p1 — re-resolving returns p1, not the next free seat.
  const s = mapViewerToSeat({ fid: 100, username: "carol" }, twoHumanSpec, { p1: 100, p2: 999 });
  assert.equal(s.seat, "p1");
});

test("FAIL-CLOSED: all human seats claimed by others → spectator", () => {
  const s = mapViewerToSeat({ fid: 300 }, twoHumanSpec, { p1: 100, p2: 200 });
  assert.equal(s.seat, null);
  assert.match(s.label, /all seats taken/);
});
