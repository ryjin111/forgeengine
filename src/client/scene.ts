// Phaser board scene — the "human plays" door with a real game feel. It OWNS a Match and
// drives it through the exact same submit()/tick() path as the headless engine; everything
// here (tweens, flashes, timing) is presentation OUTSIDE the determinism boundary. The engine
// state is the single source of truth; sprites are reconciled/animated to match it each tick.

import Phaser from "phaser";
import { Match } from "../core/engine.ts";
import { legalActions } from "../core/validate.ts";
import { fixed } from "../core/fixed.ts";
import type { Action, GameSpec } from "../core/types.ts";
import { pickAgentAction } from "./agent.ts";
import { resolveAssets, type AssetProvider } from "./assets.ts";
import { runTurn } from "../runtime/turn.ts";

const HUMAN = "human";
const AGENT = "agent";
const OWNER_TINT: Record<string, number> = { human: 0x3b82f6, agent: 0xef4444 };

export interface SceneDeps {
  spec: GameSpec;
  cell: number;
  logEl: HTMLElement;
  statusEl: HTMLElement;
  mrEl: HTMLElement;
  /** Phase 2: resolves GameSpec assetRefs → sprite URLs. Presentation-only. */
  provider: AssetProvider;
}

interface Unit {
  container: Phaser.GameObjects.Container;
  hpText: Phaser.GameObjects.Text;
  disc: Phaser.GameObjects.Image;
  sprite?: Phaser.GameObjects.Image;
}

export class BoardScene extends Phaser.Scene {
  private readonly spec: GameSpec;
  private readonly cell: number;
  private readonly logEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly mrEl: HTMLElement;
  private readonly provider: AssetProvider;

  private match!: Match;
  private seed = "board-1";
  private selected: string | null = null;
  private units = new Map<string, Unit>();
  private highlight!: Phaser.GameObjects.Graphics;
  private busy = false; // lock input while a tick animates

  constructor(deps: SceneDeps) {
    super("board");
    this.spec = deps.spec;
    this.cell = deps.cell;
    this.logEl = deps.logEl;
    this.statusEl = deps.statusEl;
    this.mrEl = deps.mrEl;
    this.provider = deps.provider;
  }

  // --- geometry helpers ---
  private cx(x: number): number { return x * this.cell + this.cell / 2; }
  private cy(y: number): number { return y * this.cell + this.cell / 2; }

  preload(): void {
    // Build a white disc texture in code (no external assets) — tinted per owner.
    const g = this.make.graphics();
    const r = Math.floor(this.cell * 0.32);
    g.fillStyle(0xffffff, 1).fillCircle(r, r, r);
    g.lineStyle(3, 0x0b0f17, 1).strokeCircle(r, r, r);
    g.generateTexture("disc", r * 2, r * 2);
    g.destroy();
  }

  create(): void {
    this.match = new Match(this.spec, this.seed);
    this.drawGrid();
    this.highlight = this.add.graphics();
    this.spawnUnits();
    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => this.onClick(p));
    this.refresh();
    void this.loadAssets(); // async sprite swap-in; board is fully playable before/without it
  }

  /** Phase 2: resolve the spec's assetRefs to sprite textures and skin the units. Pure
   *  presentation — if it resolves nothing (no provider/keys), units keep the disc look. */
  private async loadAssets(): Promise<void> {
    const urls = await resolveAssets(this.spec, this.provider);
    if (urls.size === 0) return;
    const toLoad: Array<[string, string]> = []; // [assetKey, texKey]
    for (const [key, url] of urls) {
      const texKey = `sprite:${key}`;
      if (this.textures.exists(texKey)) {
        this.applySprite(key, texKey);
      } else {
        this.load.image(texKey, url);
        toLoad.push([key, texKey]);
      }
    }
    if (toLoad.length === 0) return;
    this.load.once(Phaser.Loader.Events.COMPLETE, () => {
      for (const [key, texKey] of toLoad) if (this.textures.exists(texKey)) this.applySprite(key, texKey);
    });
    this.load.start();
  }

  /** Put the loaded sprite on top of the (now dimmed) owner-colored disc, which becomes a
   *  team-color halo so human/agent stay distinguishable even with shared art. */
  private applySprite(assetKey: string, texKey: string): void {
    for (const e of Object.values(this.match.getState().entities)) {
      if (this.spec.entityTypes[e.type]?.assetKey !== assetKey) continue;
      const u = this.units.get(e.id);
      if (!u || u.sprite) continue;
      u.disc.setAlpha(0.45);
      const sprite = this.add.image(0, -2, texKey);
      const target = this.cell * 0.7;
      sprite.setDisplaySize(target, target);
      u.container.addAt(sprite, 1); // above disc, below name/hp text
      u.sprite = sprite;
    }
  }

  private drawGrid(): void {
    const g = this.add.graphics();
    for (let y = 0; y < this.spec.map.height; y++) {
      for (let x = 0; x < this.spec.map.width; x++) {
        g.fillStyle((x + y) % 2 === 0 ? 0x1f2937 : 0x111827, 1);
        g.fillRect(x * this.cell, y * this.cell, this.cell, this.cell);
      }
    }
  }

  private spawnUnits(): void {
    for (const u of this.units.values()) u.container.destroy();
    this.units.clear();
    for (const e of Object.values(this.match.getState().entities)) {
      const disc = this.add.image(0, 0, "disc").setTint(OWNER_TINT[e.owner] ?? 0x888888);
      const name = this.add.text(0, -this.cell * 0.02, e.id, { fontSize: "14px", color: "#fff", fontStyle: "bold" }).setOrigin(0.5);
      const hpText = this.add.text(0, this.cell * 0.26, "", { fontSize: "11px", color: "#fff" }).setOrigin(0.5);
      const container = this.add.container(this.cx(e.pos.x), this.cy(e.pos.y), [disc, name, hpText]);
      this.units.set(e.id, { container, hpText, disc });
    }
    // Re-skin from any textures already loaded (e.g. after "New match"), without re-fetching.
    for (const key of Object.keys(this.spec.assets)) {
      const texKey = `sprite:${key}`;
      if (this.textures.exists(texKey)) this.applySprite(key, texKey);
    }
  }

  // --- input ---
  private legalForHuman(): Action[] {
    return legalActions(this.match.getState(), this.spec, HUMAN);
  }

  private moveCellsFor(id: string): Array<{ x: number; y: number }> {
    return this.legalForHuman()
      .filter((a) => a.type === "move" && a.params.entity === id)
      .map((a) => ({ x: Number(a.params.x), y: Number(a.params.y) }));
  }

  private attackTargetsFor(id: string): string[] {
    return this.legalForHuman()
      .filter((a) => a.type === "attack" && a.params.entity === id)
      .map((a) => String(a.params.target));
  }

  private onClick(p: Phaser.Input.Pointer): void {
    if (this.busy || this.match.getState().winner !== null) return;
    const x = Math.floor(p.worldX / this.cell);
    const y = Math.floor(p.worldY / this.cell);
    if (x < 0 || y < 0 || x >= this.spec.map.width || y >= this.spec.map.height) return;
    const s = this.match.getState();

    if (this.selected) {
      if (this.moveCellsFor(this.selected).some((m) => m.x === x && m.y === y)) {
        this.commitRound({ type: "move", actor: HUMAN, params: { entity: this.selected, x, y } });
        return;
      }
      const targetHere = Object.values(s.entities).find((e) => e.alive && e.pos.x === x && e.pos.y === y);
      if (targetHere && this.attackTargetsFor(this.selected).includes(targetHere.id)) {
        this.commitRound({ type: "attack", actor: HUMAN, params: { entity: this.selected, target: targetHere.id } });
        return;
      }
    }
    const here = Object.values(s.entities).find((e) => e.alive && e.pos.x === x && e.pos.y === y);
    this.selected = here && here.owner === HUMAN ? here.id : null;
    this.refresh();
  }

  // --- round + animation ---
  // Routes through the SHARED orchestrator (runtime/turn.ts) so the client paces matches by the
  // exact same turn model as the headless arena. The human's UI-chosen action is just the
  // `human` controller; the agent uses its policy. The orchestrator reads spec.turnModel.
  private commitRound(humanAction: Action): void {
    const tick = this.match.getState().tick;
    runTurn(this.match, this.spec, {
      [HUMAN]: () => humanAction,
      [AGENT]: (s, sp, a) => pickAgentAction(s, sp, a),
    });
    this.selected = null;
    this.animateTick(tick);
  }

  /** Drive an external action for the human too (Auto-step "watch the AIs"). */
  autoStep(): void {
    if (this.busy || this.match.getState().winner !== null) return;
    this.commitRound(pickAgentAction(this.match.getState(), this.spec, HUMAN));
  }

  passTurn(): void {
    if (this.busy || this.match.getState().winner !== null) return;
    this.commitRound({ type: "pass", actor: HUMAN, params: {} });
  }

  editMoveRange(delta: number): void {
    if (this.busy || this.match.getState().winner !== null) return;
    const cur = Number(this.match.getState().ruleParams.moveRange ?? 1);
    this.commitRound({ type: "edit_rule", actor: HUMAN, params: { rule: "moveRange", value: cur + delta } });
  }

  reset(): void {
    this.seed = `board-${this.match.finalTick}-${this.match.log.length}`; // vary w/o Date/Math.random
    this.match = new Match(this.spec, this.seed);
    this.selected = null;
    this.logEl.innerHTML = "";
    this.spawnUnits();
    this.refresh();
  }

  private animateTick(tick: number): void {
    this.busy = true;
    this.highlight.clear();
    // >= tick (not ==) so a sequential turn model, which advances multiple ticks per turn,
    // still animates every event the turn produced.
    const entries = this.match.log.filter((l) => l.tick >= tick);

    for (const entry of entries) {
      for (const ev of entry.events) {
        this.logLine(tick, ev);
        if (ev.kind === "moved") {
          const u = this.units.get(ev.entity);
          if (u) this.tweens.add({ targets: u.container, x: this.cx(ev.to.x), y: this.cy(ev.to.y), duration: 220, ease: "Quad.Out" });
        } else if (ev.kind === "attacked") {
          const atk = this.units.get(ev.attacker);
          const tgt = this.units.get(ev.target);
          if (atk && tgt) {
            const ox = atk.container.x, oy = atk.container.y;
            this.tweens.add({
              targets: atk.container, x: (ox + tgt.container.x) / 2, y: (oy + tgt.container.y) / 2,
              duration: 110, yoyo: true, ease: "Quad.InOut",
            });
            tgt.disc.setTint(0xffffff);
            this.time.delayedCall(110, () => tgt.disc.setTint(0xfca5a5));
            this.time.delayedCall(260, () => this.refreshTints());
            this.floatDamage(tgt.container.x, tgt.container.y - this.cell * 0.3, ev.damage);
          }
        } else if (ev.kind === "died") {
          const u = this.units.get(ev.entity);
          if (u) this.tweens.add({ targets: u.container, alpha: 0.25, scale: 0.8, duration: 300 });
        }
      }
    }
    // Settle: refresh hp/status/highlights after the tick's tweens.
    this.time.delayedCall(360, () => {
      this.busy = false;
      this.refresh();
    });
  }

  private floatDamage(x: number, y: number, dmg: number): void {
    const t = this.add.text(x, y, `-${dmg}`, { fontSize: "18px", color: "#fbbf24", fontStyle: "bold" }).setOrigin(0.5);
    this.tweens.add({ targets: t, y: y - 28, alpha: 0, duration: 600, ease: "Quad.Out", onComplete: () => t.destroy() });
  }

  // --- view sync ---
  private refresh(): void {
    const s = this.match.getState();
    // hp + alive
    for (const e of Object.values(s.entities)) {
      const u = this.units.get(e.id);
      if (!u) continue;
      u.hpText.setText(e.alive ? `hp ${fixed.toInt(e.stats.hp ?? fixed.fromInt(0))}` : "");
      u.container.setPosition(this.cx(e.pos.x), this.cy(e.pos.y));
      if (!e.alive) u.container.setAlpha(0.25);
    }
    this.refreshTints();
    this.refreshHighlights();
    this.mrEl.textContent = String(s.ruleParams.moveRange ?? "–");
    const over = s.winner !== null;
    this.statusEl.innerHTML = over
      ? `<div class="banner">${s.winner === "draw" ? "Draw." : `${s.winner} wins!`}</div>`
      : `<div>tick <b>${s.tick}</b> · attackRange <b>${s.ruleParams.attackRange}</b><br/>
         <span class="you">you = human (blue)</span> · <span class="ai">AI = agent (red)</span><br/>
         click your unit, then a green tile to move or a ringed enemy to attack</div>`;
  }

  private refreshTints(): void {
    for (const e of Object.values(this.match.getState().entities)) {
      const u = this.units.get(e.id);
      if (u) u.disc.setTint(OWNER_TINT[e.owner] ?? 0x888888);
    }
  }

  private refreshHighlights(): void {
    this.highlight.clear();
    if (!this.selected || this.match.getState().winner !== null) return;
    // green move tiles
    this.highlight.fillStyle(0x22c55e, 0.3);
    for (const m of this.moveCellsFor(this.selected)) {
      this.highlight.fillRect(m.x * this.cell, m.y * this.cell, this.cell, this.cell);
    }
    // white box on the selected unit
    const sel = this.match.getState().entities[this.selected];
    if (sel) {
      this.highlight.lineStyle(3, 0xffffff, 1).strokeRect(sel.pos.x * this.cell + 3, sel.pos.y * this.cell + 3, this.cell - 6, this.cell - 6);
    }
    // orange ring on attackable enemies
    this.highlight.lineStyle(4, 0xf59e0b, 1);
    for (const id of this.attackTargetsFor(this.selected)) {
      const t = this.match.getState().entities[id];
      if (t) this.highlight.strokeCircle(this.cx(t.pos.x), this.cy(t.pos.y), this.cell * 0.42);
    }
  }

  private logLine(tick: number, ev: import("../core/types.ts").GameEvent): void {
    const txt =
      ev.kind === "moved" ? `${ev.entity} → (${ev.to.x},${ev.to.y})`
      : ev.kind === "attacked" ? `${ev.attacker} hit ${ev.target} for ${ev.damage} (hp ${ev.targetHpAfter})`
      : ev.kind === "died" ? `💀 ${ev.entity} died`
      : ev.kind === "rule_edited" ? `⚙ ${ev.rule}: ${ev.from} → ${ev.to}`
      : ev.kind === "passed" ? `${ev.actor} passed`
      : ev.kind === "rejected" ? `✗ ${ev.action?.actor ?? "?"} ${ev.action?.type ?? "?"} rejected (${ev.reason})`
      : ev.kind === "scored" ? `★ ${ev.actor} +${ev.points} (score ${ev.total})`
      : `🏆 ${ev.winner} wins`;
    const div = document.createElement("div");
    div.className = "row";
    div.textContent = `t${tick}  ${txt}`;
    this.logEl.appendChild(div);
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }
}
