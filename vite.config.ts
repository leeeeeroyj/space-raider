import { defineConfig } from 'vite';

// assets/ is the public dir, so tools/sprites.py's exports are served as sprites/<slot>.png.
// Relative base so the build works from a subpath (GitHub Pages serves it at /space-raider/).
export default defineConfig({
  base: './',
  publicDir: 'assets',
});
