import type Phaser from 'phaser';
import { HEIGHT, RENDER_SCALE, WIDTH } from './config';

/** Zooms a scene's camera so its own coordinate space fills the canvas, with (0, 0) at the top left. */
export function fitCamera(scene: Phaser.Scene, zoom: number) {
  const w = (WIDTH * RENDER_SCALE) / zoom, h = (HEIGHT * RENDER_SCALE) / zoom;
  scene.cameras.main.setZoom(zoom).centerOn(w / 2, h / 2);
}
