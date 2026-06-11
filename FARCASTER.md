# Farcaster Mini App — Phase 4

Hosts the existing skirmish board as a Farcaster Mini App. It is a host *around* the same
`BoardScene` + engine — not a second renderer. Now supports BOTH **watch** (spectator) and
**in-feed play** (a seated viewer plays the `human` seat vs the agent), chosen by the FID→seat
auth boundary.

## What this slice IS (built)
- `miniapp.html` — the Mini App page, with the `fc:miniapp` / `fc:frame` embed card meta, a seat
  banner (`#seat`), and a play-mode control row (`#controls`, hidden until play mode).
- `src/client/session.ts` — **the FID → player(actorId) mapping boundary** (see below).
- `src/client/miniapp.ts` — mounts the **same** `BoardScene`, reads the Farcaster viewer, maps it
  to a seat, and branches:
  - **seated** → PLAY: input enabled, viewer drives the `human` seat through the scene's existing
    `commitRound()`/`runTurn()` path (the shared orchestrator paces it — no turn logic re-baked).
  - **spectator** → WATCH: input disabled, both actors auto-played, matches loop.
  Then calls `sdk.actions.ready()` to dismiss the host splash.
- `test/session.test.ts` — headless tests proving the boundary is pure + fail-closed.
- `public/.well-known/farcaster.json` — the Mini App manifest.
- `vite.config.ts` — multi-page build so the board (`/`) and the Mini App (`/miniapp.html`)
  build/serve from one project, sharing all `src/` code.

Run locally:
```
npm run dev        # board at /, Mini App at /miniapp.html, manifest at /.well-known/farcaster.json
npm run build:web  # static output in dist/ (deployable)
npm test           # includes the session-boundary tests
```

## The FID → seat boundary (review surface)
`src/client/session.ts` is the ONLY place a Farcaster identity becomes an engine seat. It is
deliberately a pure function with **zero** `core/*` or SDK imports, so the auth mapping is
provably outside the determinism boundary:
- A viewer's **FID is only a label** of who sits in a seat this session — it is NEVER a game
  input. The action submitted is always `{ actor: "human", … }` regardless of FID, so replay /
  determinism are untouched (same discipline assets follow).
- **FAIL-CLOSED**: absent/invalid identity → spectator; no free human seat → spectator; only
  `kind: "human"` seats are claimable (agent seats never handed to a viewer). A viewer is never
  silently granted a seat.
- The SDK shape is adapted into a local `FarcasterViewer` in `miniapp.ts` (`readViewer()`, which
  races `sdk.context` against a timeout and swallows errors → `null` outside a host), keeping
  `session.ts` decoupled from the SDK.

For the single-human skirmish, any authenticated viewer takes the lone `human` seat. The
`claimed` arg + idempotent re-resolve already support multi-seat specs (e.g. 2-player) for when
the agent-arena lands; generalizing the *scene's* hardcoded local seat (`HUMAN = "human"`) to an
arbitrary mapped seat is the follow-on at that point.

**Multi-human follow-on (review note).** This boundary is a CLIENT-SIDE seat
guard — correct today because each viewer plays their own match vs the agent, so there is no
shared state to cheat. When real **multi-human shared PvP** matches land, seat ownership must be
enforced **host/server-side**: a client can fake its own FID or `claimed` map, so the
fail-closed mapping here can't be the authority for shared matches. That + generalizing the
hardcoded local seat above are the same multi-human slice.

Current hosting: the kit is published on **GitHub Pages** (`https://ryjin111.github.io/forgeengine/`),
and the Mini App embed in `miniapp.html` is **already wired to launch the bundled demo**
(`miniapp.html?spec=demo.json` → "The Forge Gauntlet"). The **web** showcase works today — share
`https://ryjin111.github.io/forgeengine/?spec=demo.json` and it's playable in a browser. The
**in-feed** Mini App embed needs the remaining maintainer-only steps below.

## What the maintainer needs to provide for the IN-FEED Mini App (gated, not buildable by an agent)
1. **Manifest at the domain ROOT.** Farcaster fetches `/.well-known/farcaster.json` at the domain
   root — a GitHub Pages *project* site (`ryjin111.github.io/forgeengine/`) can't serve the root, so
   in-feed launch needs either a **custom domain** or a **user/org Pages site**. The same `dist/`
   deploys there unchanged; then point the embed origin at it (the demo `?spec=demo.json` carries over).
2. **`accountAssociation`** in `farcaster.json` is empty on purpose — it must be **signed with
   the maintainer's Farcaster custody key for the serving domain** (Warpcast/Farcaster developer
   "Manifest" tool). An agent cannot produce this (needs the key + final domain).
3. **Card art** (`preview.png` 3:2, `icon.png`, `splash.png`) — add to `public/` (the embed already
   references them at the host). Needed for the card to render in-feed; optional for the web demo.
5. **Image service** (optional): the public shell uses the keyless procedural provider only.
   The real MythosForge image service stays unwired until the maintainer supplies the endpoint + key via
   env (never baked into the public build).
