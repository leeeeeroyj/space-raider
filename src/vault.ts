import Phaser from 'phaser';
import { COLS, HUNTER, ROWS, tileCenter, type TreasureKind } from './config';

/** The vault is GRID × GRID rooms. */
export const GRID = 6;

export type Side = 'top' | 'right' | 'bottom' | 'left';
export const SIDES: readonly Side[] = ['top', 'right', 'bottom', 'left'];
export const OPPOSITE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
const STEP: Record<Side, { dc: number; dr: number }> = {
  top: { dc: 0, dr: -1 }, right: { dc: 1, dr: 0 }, bottom: { dc: 0, dr: 1 }, left: { dc: -1, dr: 0 },
};

/** Inclusive span of open wall tiles, counted along the wall: columns for top/bottom, rows for left/right. */
export interface Door { from: number; to: number }
export interface Loot { kind: TreasureKind; x: number; y: number }
export interface Room {
  col: number;
  row: number;
  doors: Partial<Record<Side, Door>>;
  /** Treasure lying in the room, including cargo dropped here. */
  loot: Loot[];
  /** Hostiles not yet destroyed; drops only on a kill. */
  hostilesLeft: number;
  visited: boolean;
}
export interface Vault {
  level: number;
  rooms: Room[];
  entrance: Room;
  exit: Room;
  /** Your most recent drop. Marked with an X for one life (Atari 5200 rules). */
  wreck?: { room: Room; x: number; y: number };
}

export type MapCell = 'unvisited' | 'loot' | 'hostile' | 'clear';

export const roomIndex = (room: Room) => room.row * GRID + room.col;

export function neighbor(vault: Vault, room: Room, side: Side): Room | undefined {
  const c = room.col + STEP[side].dc, r = room.row + STEP[side].dr;
  return c >= 0 && r >= 0 && c < GRID && r < GRID ? vault.rooms[r * GRID + c] : undefined;
}

/** What the vault map shows for a room. Loot outranks hostiles. */
export function mapCell(room: Room): MapCell {
  if (!room.visited) return 'unvisited';
  if (room.loot.length) return 'loot';
  if (room.hostilesLeft) return 'hostile';
  return 'clear';
}

// Treasure tiers get rarer as they get more valuable.
const TIER_ODDS: Array<[TreasureKind, number]> = [['t1_coin', 0.4], ['t2_chip', 0.28], ['t3_star', 0.18], ['t4_crystal', 0.1], ['t5_idol', 0.04]];
const LOOT_COUNT_ODDS = [0.2, 0.4, 0.3, 0.1]; // chance of 0, 1, 2, 3 treasures in a room

function pickWeighted<T>(rnd: Phaser.Math.RandomDataGenerator, options: Array<[T, number]>): T {
  let roll = rnd.frac();
  for (const [value, weight] of options) {
    if ((roll -= weight) < 0) return value;
  }
  return options[options.length - 1][0];
}

/** Builds a vault: a random spanning tree of doors plus a few loops, then fills rooms. Same seed, same vault. */
export function generateVault(level: number, seed: string): Vault {
  const rnd = new Phaser.Math.RandomDataGenerator([seed]);
  const rooms: Room[] = [];
  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) rooms.push({ col, row, doors: {}, loot: [], hostilesLeft: 0, visited: false });
  }
  const vault = { level, rooms } as Vault;

  const link = (room: Room, side: Side) => {
    const other = neighbor(vault, room, side)!;
    const horizontalWall = side === 'top' || side === 'bottom';
    const width = rnd.between(2, horizontalWall ? 6 : 4);
    const last = (horizontalWall ? COLS : ROWS) - 3; // keep doors off the corner tiles
    const from = rnd.between(2, last - width + 1);
    room.doors[side] = other.doors[OPPOSITE[side]] = { from, to: from + width - 1 };
  };

  // Depth-first maze, so every room is reachable.
  const seen = new Set<Room>();
  const stack = [rnd.pick(rooms)];
  seen.add(stack[0]);
  while (stack.length) {
    const room = stack[stack.length - 1];
    const options = SIDES.filter((s) => {
      const n = neighbor(vault, room, s);
      return n && !seen.has(n);
    });
    if (!options.length) {
      stack.pop();
      continue;
    }
    const side = rnd.pick(options);
    link(room, side);
    const next = neighbor(vault, room, side)!;
    seen.add(next);
    stack.push(next);
  }
  // A few extra doors make loops, so you're not always backtracking.
  for (let added = 0, tries = 0; added < 7 && tries < 200; tries++) {
    const room = rnd.pick(rooms), side = rnd.pick([...SIDES]);
    if (neighbor(vault, room, side) && !room.doors[side]) {
      link(room, side);
      added++;
    }
  }

  // Entrance anywhere; exit is the room farthest from it by door.
  vault.entrance = rnd.pick(rooms);
  const distance = new Map<Room, number>([[vault.entrance, 0]]);
  const queue = [vault.entrance];
  while (queue.length) {
    const room = queue.shift()!;
    for (const side of SIDES) {
      const n = room.doors[side] && neighbor(vault, room, side);
      if (n && !distance.has(n)) {
        distance.set(n, distance.get(room)! + 1);
        queue.push(n);
      }
    }
  }
  vault.exit = [...distance.entries()].reduce((a, b) => (b[1] > a[1] ? b : a))[0];

  for (const room of rooms) {
    if (room === vault.entrance) room.hostilesLeft = HUNTER.entranceRoom;
    else if (rnd.frac() < 0.15) room.hostilesLeft = 0;
    else room.hostilesLeft = rnd.between(HUNTER.perRoom[0], HUNTER.perRoom[1]) + (level - 1);

    if (room === vault.exit) continue; // the extraction pad sits where loot would
    const count = room === vault.entrance ? 2 : pickWeighted(rnd, LOOT_COUNT_ODDS.map((p, n): [number, number] => [n, p]));
    // Loot sits away from the walls and out of the middle, where you arrive or the pad sits.
    const tiles: Array<{ c: number; r: number }> = [];
    for (let r = 3; r <= ROWS - 4; r++) {
      for (let c = 3; c <= COLS - 4; c++) if (Math.abs(c - 10) > 1 || Math.abs(r - 6) > 1) tiles.push({ c, r });
    }
    for (const { c, r } of rnd.shuffle(tiles).slice(0, count)) {
      room.loot.push({ kind: room === vault.entrance ? 't1_coin' : pickWeighted(rnd, TIER_ODDS), ...tileCenter(c, r) });
    }
  }
  return vault;
}
