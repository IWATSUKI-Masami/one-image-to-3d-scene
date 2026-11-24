import path from 'path';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Version recorded with Arrange results: package version and git commit (if available)
const appVersion = (() => {
  const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')).version as string;
  try {
    const commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const dirty = execSync('git status --porcelain --untracked-files=no', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() ? '+changes' : '';
    return `${pkg} (${commit}${dirty})`;
  } catch {
    return pkg;
  }
})();

export default defineConfig(() => {
  return {
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
    },
    server: {
      port: 3000,
      host: '0.0.0.0',
      proxy: {
        '/api/rembg': {
          target: 'https://api-inference.huggingface.co/models/ZhengPeng7/BiRefNet',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/rembg/, '')
        },
        '/api/hf': {
          target: 'https://router.huggingface.co/hf-inference',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/hf/, '')
        }
      },
    },
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      }
    }
  };
});
