import { defineConfig } from 'vitest/config';

// vite.config.ts는 화면용(root = web/)이라, 테스트는 저장소 전체(engine/·web/)에서 찾도록 따로 둔다
export default defineConfig({ test: { include: ['engine/test/**/*.test.ts', 'web/src/**/*.test.{ts,tsx}'] } });
