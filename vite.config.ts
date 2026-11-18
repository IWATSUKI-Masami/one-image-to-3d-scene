import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
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
    define: {
      'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY)
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      }
    }
  };
});
