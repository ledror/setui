import { afterEach, describe, expect, it } from 'vitest'
import { findFiles, findSolutions } from '../src/tui/discover.js'
import { CORPUS } from './helpers/corpus.js'

/**
 * fd and rg are tried first and either may be installed, so the readdir walk --
 * "the path that always works on Windows" -- would otherwise go untested wherever
 * they exist. Emptying PATH makes both spawns fail and forces the fallback.
 */
const withoutFdOrRg = async <T,>(work: () => Promise<T>): Promise<T> => {
  const path = process.env['PATH']
  process.env['PATH'] = ''
  try {
    return await work()
  } finally {
    process.env['PATH'] = path
  }
}

afterEach(() => {
  expect(process.env['PATH']).toBeTruthy()
})

describe('findSolutions', () => {
  it('finds every solution in the sample corpus', async () => {
    const found = await findSolutions(CORPUS)
    expect(found.length).toBe(136)
    expect(found.every((p) => p.endsWith('.sln'))).toBe(true)
  })

  it('returns nothing for a directory with no solutions', async () => {
    expect(await findSolutions(new URL('.', import.meta.url).pathname)).toEqual([])
  })

  it('finds the same solutions with the readdir walk as with fd', async () => {
    const walked = await withoutFdOrRg(() => findSolutions(CORPUS))
    expect(walked).toEqual(await findSolutions(CORPUS))
  })
})

describe('findFiles', () => {
  it('matches an exact filename, not just an extension', async () => {
    const found = await findFiles(CORPUS, 'Directory.Build.props')
    expect(found).toHaveLength(1)
    expect(found[0]!.endsWith('Directory.Build.props')).toBe(true)
  })

  it('matches an exact filename in the readdir walk too', async () => {
    const walked = await withoutFdOrRg(() => findFiles(CORPUS, 'Directory.Build.props'))
    expect(walked).toEqual(await findFiles(CORPUS, 'Directory.Build.props'))
  })

  it('does not treat an exact name as a suffix', async () => {
    // 'Build.props' must not match 'Directory.Build.props'.
    expect(await withoutFdOrRg(() => findFiles(CORPUS, 'Build.props'))).toEqual([])
  })
})
