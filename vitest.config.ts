import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // The corpus tests read hundreds of files; give them room.
    testTimeout: 60_000,
  },
})
