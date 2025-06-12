import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build}.config.*',
      '**/src/**/__temp__/**',
      '**/__temp__/**',
      '**/temp/**',
    ],
    // 配置 watch 模式忽略的文件
    watchExclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/src/**/__temp__/**',
      '**/__temp__/**',
      '**/temp/**',
    ],
  },
})
