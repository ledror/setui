import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // The corpus tests read hundreds of files; give them room.
    testTimeout: 60_000,
    // The Ink tests open a file in a real spawned editor with stdio: 'inherit',
    // which only lands when this suite owns the process stdio. Run the files in
    // parallel and that spawn quietly does nothing, failing those tests only in
    // a full run and never on their own. Serial is also faster here, because
    // the corpus tests already saturate the machine on their own.
    fileParallelism: false,
  },
})
