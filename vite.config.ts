import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 화면은 web/, 계산은 저장소 루트의 engine/과 data/를 그대로 가져다 쓴다
export default defineConfig({
  root: 'web',
  plugins: [react()],
  server: { port: 5173, fs: { allow: ['..'] } },
  build: { outDir: '../dist', emptyOutDir: true },
});
