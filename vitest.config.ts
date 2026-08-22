import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The corpus tests read hundreds of files; give them room.
    testTimeout: 60_000,
  },
})
