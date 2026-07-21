import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  build: {
    outDir: '../dist-web',
    emptyOutDir: true,
  },
  plugins: [
    cloudflare({ configPath: '../wrangler.jsonc' }),
  ],
});
