import { describe, expect, it } from 'vitest'
import { findSolutions } from '../src/tui/discover.js'
import { CORPUS } from './helpers/corpus.js'

describe('findSolutions', () => {
  it('finds every solution in the sample corpus', async () => {
    const found = await findSolutions(CORPUS)
    expect(found.length).toBe(136)
    expect(found.every((p) => p.endsWith('.sln'))).toBe(true)
  })

  it('returns nothing for a directory with no solutions', async () => {
    expect(await findSolutions(new URL('.', import.meta.url).pathname)).toEqual([])
  })
})
