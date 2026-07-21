import { fileURLToPath } from 'node:url';
import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  server: process.env.PORT ? { port: Number(process.env.PORT), strictPort: true } : undefined,
  build: {
    outDir: '../dist-web',
    emptyOutDir: true,
  },
  environments: {
    client: {
      build: {
        rollupOptions: {
          input: {
            main: fileURLToPath(new URL('web/index.html', import.meta.url)),
            about: fileURLToPath(new URL('web/about/index.html', import.meta.url)),
          },
        },
      },
    },
  },
  plugins: [
    cloudflare({ configPath: '../wrangler.jsonc' }),
  ],
});
