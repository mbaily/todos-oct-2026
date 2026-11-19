import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function offlineApp() {
  return {
    name: 'todos-offline-app',
    apply: 'build',
    async writeBundle({ dir }) {
      const worker = await readFile(new URL('./src/service-worker.js', import.meta.url), 'utf8');
      const assets = await readdir(join(dir, 'assets'));
      const files = [
        'index.html', 'reset.css', 'manifest.webmanifest',
        'icons/todos-192.png', 'icons/todos-512.png',
        ...assets.sort().map(name => `assets/${name}`),
      ];
      const hash = createHash('sha256').update(worker).update(JSON.stringify(files));
      for (const file of files) {
        hash.update(createHash('sha256').update(await readFile(join(dir, file))).digest());
      }
      const buildConfig = JSON.stringify({ version: hash.digest('hex'), files });
      await writeFile(join(dir, 'sw.js'), `const build = ${buildConfig};\n${worker}`);
    },
  };
}

export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [svelte(), offlineApp()],
  build: { target: 'es2022' },
  worker: { format: 'es' },
});
