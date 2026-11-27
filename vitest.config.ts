import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 60000,
    // PGlite(WASM) 인스턴스를 파일마다 띄우므로 병렬·기계 부하 시 초기화가 기본 타임아웃(hook 10s)을 넘긴다
    // (풀 스위트에서 연쇄 타임아웃 재현, 43파일 시점 30s도 간헐 초과). maxWorkers 캡 + 타임아웃 상향으로 봉인
    // — 상한이라 무부하 시 무영향. 근본 해법(워커당 PGlite 공유)은 백로그.
    hookTimeout: 60000,
    maxWorkers: 3,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      'next/font/google': path.resolve(__dirname, 'tests/helpers/next-font-stub.ts'),
    },
  },
})
