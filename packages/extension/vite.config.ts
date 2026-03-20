import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import fs from 'fs';
import type { Plugin } from 'vite';
import sharp from 'sharp';

function copyManifestPlugin(): Plugin {
  return {
    name: 'copy-manifest',
    async writeBundle() {
      const src = resolve(__dirname, 'src/manifest.json');
      const dest = resolve(__dirname, 'dist/manifest.json');
      fs.copyFileSync(src, dest);

      for (const size of [16, 48, 128]) {
        const svgPath = resolve(__dirname, `dist/icon${size}.svg`);
        const pngPath = resolve(__dirname, `dist/icon${size}.png`);

        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">
  <circle cx="12" cy="12" r="10" fill="#6366f1"/>
  <path d="M9 7.5h4a4.5 4.5 0 0 1 0 9H9" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

        fs.writeFileSync(svgPath, svg);

        const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
        fs.writeFileSync(pngPath, pngBuffer);
      }
    },
  };
}

// Wrap scripts in IIFEs so re-injection doesn't cause
// "Identifier has already been declared" errors from top-level const/let.
// Content script also gets a guard to skip re-initialization entirely.
function wrapIIFE(): Plugin {
  return {
    name: 'wrap-iife',
    generateBundle(_options, bundle) {
      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (chunk.type !== 'chunk') continue;
        if (fileName === 'content.js') {
          chunk.code = `(function(){if(window.__docext_loaded__)return;window.__docext_loaded__=true;${chunk.code}})();\n`;
        } else if (fileName === 'background.js') {
          chunk.code = `(function(){${chunk.code}})();\n`;
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), copyManifestPlugin(), wrapIIFE()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'src/popup/index.html'),
        background: resolve(__dirname, 'src/background.ts'),
        content: resolve(__dirname, 'src/content.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: '[name].[ext]',
        // Disable shared chunking so content/background remain self-contained.
        // Content scripts are injected as classic scripts (not module), so
        // static `import ... from "./chunks/...js"` would break.
        manualChunks: () => null,
      },
    },
  },
  resolve: {
    alias: {
      '@docext/shared': resolve(__dirname, '../shared/src'),
    },
  },
});
