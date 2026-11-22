import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    base: './',
    plugins: [
      react(),
      tailwindcss(),
      // Copies src/assets into dist/ so root-relative URLs like
      // "/src/assets/images/..." (e.g. generate_image output) still resolve
      // in production builds. Do not remove.
      {
        name: 'copy-unbundled-src-assets',
        apply: 'build',
        closeBundle(error?: Error): void {
          if (error) {
            return;
          }
          const distDir = path.resolve(__dirname, 'dist');
          const srcAssets = path.resolve(__dirname, 'src/assets');
          const distAssets = path.resolve(distDir, 'src/assets');
          if (fs.existsSync(distDir) && fs.existsSync(srcAssets)) {
            fs.cpSync(srcAssets, distAssets, {recursive: true, force: true});
          }
        },
      },
      // Emits and serves PDF.js worker with a standard .js extension so static hosts
      // like GitHub Pages always return application/javascript instead of failing on .mjs.
      {
        name: 'pdfjs-worker-js',
        configureServer(server) {
          const workerFile = path.resolve(
            __dirname,
            'node_modules/pdfjs-dist/build/pdf.worker.min.mjs',
          );
          server.middlewares.use((req, res, next) => {
            const urlPath = (req.url || '').split('?')[0];
            if (urlPath.endsWith('/pdf.worker.min.js')) {
              if (fs.existsSync(workerFile)) {
                res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
                res.setHeader('Cache-Control', 'public, max-age=3600');
                fs.createReadStream(workerFile).pipe(res);
                return;
              }
            }
            next();
          });
        },
        closeBundle(error?: Error): void {
          if (error) return;
          const workerSrc = path.resolve(
            __dirname,
            'node_modules/pdfjs-dist/build/pdf.worker.min.mjs',
          );
          const workerDest = path.resolve(__dirname, 'dist/pdf.worker.min.js');
          if (fs.existsSync(workerSrc) && fs.existsSync(path.dirname(workerDest))) {
            fs.copyFileSync(workerSrc, workerDest);
          }
        },
      },
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
