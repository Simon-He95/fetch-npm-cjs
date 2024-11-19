// vitest.config.js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 其他配置...
    watchExclude: [
      'src/@simon_he/**',
    ],
  },
});
