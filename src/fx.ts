import Phaser from 'phaser';
import { COLORS } from './config';

const SPARKLE = 'fx-sparkle';

/** A pulsing glow (WebGL only). The pulse tween is removed with the object, so rooms can be rebuilt freely. */
export function addGlow<T extends Phaser.GameObjects.GameObject>(scene: Phaser.Scene, obj: T, color: number): T {
  if (scene.game.renderer.type !== Phaser.WEBGL) return obj;
  obj.enableFilters();
  const glow = obj.filters?.internal.addGlow(color, 2, 0, 1, false, 10, 6);
  if (!glow) return obj;
  glow.setPaddingOverride(null);
  const pulse = scene.tweens.add({ targets: glow, outerStrength: 4.5, duration: 700 + Math.random() * 300, yoyo: true, repeat: -1, ease: 'Sine.inOut' });
  obj.once(Phaser.GameObjects.Events.DESTROY, () => pulse.remove());
  return obj;
}

/** Marks an object as loot with a gold glow, so treasure reads differently from hostiles. */
export const addTreasureGlow = <T extends Phaser.GameObjects.GameObject>(scene: Phaser.Scene, obj: T) => addGlow(scene, obj, COLORS.loot);

/** Every `everyMs`, puts a short-lived glint on one of the objects `targets()` returns. */
export function startSparkles(scene: Phaser.Scene, targets: () => Phaser.GameObjects.Components.Transform[], everyMs = 450) {
  if (!scene.textures.exists(SPARKLE)) {
    const g = scene.make.graphics({}, false);
    g.fillStyle(0xffffff).fillRect(2, 0, 1, 5).fillRect(0, 2, 5, 1);
    g.fillStyle(COLORS.loot).fillRect(2, 2, 1, 1);
    g.generateTexture(SPARKLE, 5, 5);
    g.destroy();
  }
  scene.time.addEvent({
    delay: everyMs,
    loop: true,
    callback: () => {
      const list = targets();
      if (!list.length) return;
      const t = Phaser.Utils.Array.GetRandom(list);
      const s = scene.add
        .image(t.x + Phaser.Math.Between(-6, 6), t.y + Phaser.Math.Between(-6, 4), SPARKLE)
        .setDepth(30)
        .setScale(0.4);
      scene.tweens.add({ targets: s, scale: 1, alpha: 0, duration: 450, ease: 'Quad.out', onComplete: () => s.destroy() });
    },
  });
}
