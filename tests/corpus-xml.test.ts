import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applySplices } from '../src/core/text.js'
import { parseXml } from '../src/core/xml.js'
import { CORPUS, corpusFiles } from './helpers/corpus.js'
import { checkCoverage } from './helpers/coverage.js'

const files = corpusFiles('.vcxproj', '.vcxproj.filters')

describe('XML CST over the sample corpus', () => {
  it('found a corpus to test against', () => {
    expect(files.length).toBeGreaterThan(100)
  })

  it('parses every project file byte-identically', () => {
    const broken: string[] = []
    for (const file of files) {
      const bytes = readFileSync(file)
      const source = bytes.toString('utf8')
      try {
        const doc = parseXml(source)
        checkCoverage(doc)
        // No splices means no change, right down to the bytes.
        expect(Buffer.from(applySplices(doc.source, []), 'utf8').equals(bytes)).toBe(true)
      } catch (e) {
        broken.push(`${relative(CORPUS, file)}: ${(e as Error).message}`)
      }
    }
    expect(broken).toEqual([])
  })
})
