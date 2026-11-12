import Phaser from 'phaser';
import { COLORS, FONT, HUD_H, HUD_SCALE, HUD_STATE, ROOM_H, ROOM_W, TEXT, TREASURE, WIDTH, HEIGHT, type TreasureKind } from '../config';
import type { Device } from '../controls';
import { GRID, type MapCell } from '../vault';
import { fitCamera } from '../view';

export interface HudState {
  score: number;
  lives: number;
  cargo: TreasureKind[];
  device: Device;
  level: number;
  /** Hostiles left in the current room. */
  hostiles: number;
  /** Room indexes are row * GRID + col; wreck is -1 when there's no marked drop. */
  map: { cells: MapCell[]; current: number; exit: number; wreck: number };
}

const CELL_COLOR: Record<MapCell, number> = {
  unvisited: COLORS.mapUnvisited, loot: COLORS.mapLoot, hostile: COLORS.mapHostile, clear: COLORS.mapClear,
};

// HUD space is the design size × HUD_SCALE (832×456): sprites drawn here at native 16px come out
// half the size of room sprites, with no resampling.
const S = HUD_SCALE;
const W = WIDTH * S, H = HEIGHT * S, BAR = HUD_H * S, RW = ROOM_W * S, RB = (HUD_H + ROOM_H) * S;
const MAP = { x: 675, y: BAR + 36, cell: 20, gap: 2 };
const MAP_BOTTOM = MAP.y + GRID * (MAP.cell + MAP.gap) - MAP.gap;
const LEGEND: Array<[MapCell, string]> = [['loot', 'LOOT'], ['clear', 'CLEAR'], ['hostile', 'ENEMY'], ['unvisited', 'UNSEEN']];
const PANEL = { x: 660, right: 820, y: MAP_BOTTOM + 52 };
const TIERS = Object.keys(TREASURE) as TreasureKind[];
const ROW_H = 24;
/** Reserve ships shown as icons before the top bar switches to "icon x N". */
const MAX_SHIP_ICONS = 5;

const pts = (n: number) => n.toLocaleString('en-US');
type TierRow = { icon: Phaser.GameObjects.Image; count: Phaser.GameObjects.Text; value: Phaser.GameObjects.Text };

/** Top bar, vault map, cargo tally and hint strip, drawn over the room at twice the room's resolution. */
export class HudScene extends Phaser.Scene {
  private score!: Phaser.GameObjects.Text;
  private cargoValue!: Phaser.GameObjects.Text;
  private cargoTotal!: Phaser.GameObjects.Text;
  private shipCount!: Phaser.GameObjects.Text;
  private level!: Phaser.GameObjects.Text;
  private hostiles!: Phaser.GameObjects.Text;
  private hint!: Phaser.GameObjects.Text;
  private mapCells!: Phaser.GameObjects.Graphics;
  private currentCell!: Phaser.GameObjects.Rectangle;
  private tiers!: Record<TreasureKind, TierRow>;
  private ships: Phaser.GameObjects.Image[] = [];
  private shownLives = -1;
  private shownCargo = '';

  constructor() {
    super('hud');
  }

  create() {
    fitCamera(this, HUD_SCALE);
    this.ships = [];
    this.shownLives = -1;
    this.shownCargo = '';
    const label = (x: number, y: number, text: string, color = TEXT.dim) =>
      this.add.text(x, y, text, { fontFamily: FONT, fontSize: '16px', color });

    const g = this.add.graphics();
    g.fillStyle(COLORS.void).fillRect(0, 0, W, BAR);
    g.fillStyle(COLORS.line).fillRect(0, BAR - 2, W, 2);
    g.fillStyle(COLORS.void).fillRect(RW, BAR, W - RW, H - BAR);
    g.fillStyle(COLORS.line).fillRect(RW, BAR, 2, H - BAR);
    g.fillStyle(COLORS.void).fillRect(0, RB, RW, H - RB);

    label(8, 10, 'SCORE');
    this.score = label(76, 10, '', TEXT.amber);
    label(208, 10, 'SHIPS');
    this.shipCount = label(300, 10, '', TEXT.amber);
    label(432, 10, 'VAULT');
    this.level = label(500, 10, '', TEXT.amber);
    label(544, 10, 'CARGO');
    this.cargoValue = label(612, 10, '', TEXT.amber);

    label(740, BAR + 12, 'VAULT MAP').setOrigin(0.5, 0);
    this.mapCells = this.add.graphics();
    this.currentCell = this.add.rectangle(0, 0, MAP.cell - 2, MAP.cell - 2).setOrigin(0).setStrokeStyle(2, COLORS.mapCurrent);
    this.tweens.add({ targets: this.currentCell, alpha: 0.2, duration: 400, yoyo: true, repeat: -1 });
    LEGEND.forEach(([cell, text], i) => {
      const x = PANEL.x + (i % 2) * 80, y = MAP_BOTTOM + 10 + Math.floor(i / 2) * 18;
      g.fillStyle(CELL_COLOR[cell]).fillRect(x, y + 2, 10, 10);
      label(x + 16, y, text);
    });

    // Cargo tally: one row per tier, so any amount of loot fits in the same space.
    label(PANEL.x, PANEL.y, 'CARGO');
    this.cargoTotal = label(PANEL.right, PANEL.y, '', TEXT.amber).setOrigin(1, 0);
    g.fillStyle(COLORS.line).fillRect(PANEL.x, PANEL.y + 22, PANEL.right - PANEL.x, 2);
    this.tiers = Object.fromEntries(
      TIERS.map((kind, i) => {
        const y = PANEL.y + 32 + i * ROW_H;
        return [kind, {
          icon: this.add.image(PANEL.x + 8, y + 8, kind),
          count: label(PANEL.x + 24, y, ''),
          value: label(PANEL.right, y, '').setOrigin(1, 0),
        }];
      }),
    ) as Record<TreasureKind, TierRow>;

    const below = PANEL.y + 32 + TIERS.length * ROW_H + 8;
    this.hostiles = label(PANEL.x, below, '');
    this.hint = label(RW / 2, RB + 2, '').setOrigin(0.5, 0);
  }

  update() {
    const s = this.registry.get(HUD_STATE) as HudState | undefined;
    if (!s) return;
    const total = s.cargo.reduce((sum, k) => sum + TREASURE[k].value, 0);
    this.score.setText(String(s.score).padStart(6, '0').replace(/\B(?=(\d{3})+(?!\d))/g, ','));
    this.cargoValue.setText(pts(total));
    this.level.setText(String(s.level).padStart(2, '0'));
    this.hostiles.setText(s.hostiles ? `HOSTILES ${s.hostiles}` : 'ROOM SECURE').setColor(s.hostiles ? TEXT.danger : TEXT.dim);
    this.hint.setText(s.device === 'pad' ? 'L-STICK MOVE  ·  R-STICK AIM + FIRE' : 'WASD MOVE  ·  MOUSE AIM  ·  CLICK FIRE');
    this.drawMap(s.map);

    // Ships in reserve (not counting the one in play).
    if (s.lives !== this.shownLives) {
      this.shownLives = s.lives;
      const reserve = Math.max(0, s.lives - 1);
      const shown = reserve > MAX_SHIP_ICONS ? 1 : reserve;
      this.ships.forEach((i) => i.destroy());
      this.ships = Array.from({ length: shown }, (_, i) => this.add.image(288 + i * 20, 18, 'player'));
      this.shipCount.setText(reserve > MAX_SHIP_ICONS ? `x${reserve}` : '');
    }

    const cargoKey = s.cargo.join();
    if (cargoKey !== this.shownCargo) {
      this.shownCargo = cargoKey;
      this.cargoTotal.setText(s.cargo.length ? pts(total) : 'EMPTY');
      for (const kind of TIERS) {
        const n = s.cargo.filter((k) => k === kind).length;
        const row = this.tiers[kind];
        row.icon.setAlpha(n ? 1 : 0.3);
        row.count.setText(`x${n}`).setColor(n ? TEXT.ink : TEXT.dim);
        row.value.setText(n ? pts(n * TREASURE[kind].value) : '-').setColor(n ? TEXT.amber : TEXT.dim);
      }
    }
  }

  /** One colour per room state; the exit gets a cyan frame once found, your latest drop a white X. */
  private drawMap(map: HudState['map']) {
    const g = this.mapCells.clear();
    map.cells.forEach((cell, i) => {
      const { x, y } = this.cellOrigin(i);
      g.fillStyle(CELL_COLOR[cell]).fillRect(x, y, MAP.cell, MAP.cell);
      if (i === map.exit && cell !== 'unvisited') {
        g.fillStyle(COLORS.beam).fillRect(x + 4, y + 4, MAP.cell - 8, MAP.cell - 8);
        g.fillStyle(CELL_COLOR[cell]).fillRect(x + 6, y + 6, MAP.cell - 12, MAP.cell - 12);
      }
    });
    if (map.wreck >= 0) {
      const { x, y } = this.cellOrigin(map.wreck);
      g.fillStyle(COLORS.mapCurrent);
      for (let i = 4; i < MAP.cell - 4; i += 2) g.fillRect(x + i, y + i, 2, 2).fillRect(x + MAP.cell - 2 - i, y + i, 2, 2);
    }
    const here = this.cellOrigin(map.current);
    this.currentCell.setPosition(here.x + 1, here.y + 1);
  }

  private cellOrigin(index: number) {
    const col = index % GRID, row = Math.floor(index / GRID);
    return { x: MAP.x + col * (MAP.cell + MAP.gap), y: MAP.y + row * (MAP.cell + MAP.gap) };
  }
}
