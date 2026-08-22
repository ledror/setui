import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseSln, type SlnDocument } from '../src/core/sln.js'
import { CORPUS, corpusFiles } from './helpers/corpus.js'

const files = corpusFiles('.sln')

const parsed: { file: string; doc: SlnDocument }[] = []
const broken: string[] = []
for (const file of files) {
  try {
    parsed.push({ file, doc: parseSln(readFileSync(file).toString('utf8')) })
  } catch (e) {
    broken.push(`${relative(CORPUS, file)}: ${(e as Error).message}`)
  }
}

describe('SLN CST over the sample corpus', () => {
  it('found a corpus to test against', () => {
    expect(files.length).toBeGreaterThan(100)
  })

  it('parses every solution', () => {
    expect(broken).toEqual([])
  })

  it('covers every byte of every solution', () => {
    for (const { file, doc } of parsed) {
      const rebuilt = doc.bom + doc.lines.map((l) => doc.source.slice(l.start, l.end)).join('')
      expect(rebuilt, relative(CORPUS, file)).toBe(doc.source)
      expect(Buffer.from(doc.source, 'utf8').equals(readFileSync(file))).toBe(true)
    }
  })

  it('resolves a usable virtual path for every project', () => {
    for (const { file, doc } of parsed) {
      for (const project of doc.projects) {
        const vp = doc.virtualPath(project.guid)
        expect(vp, `${relative(CORPUS, file)} ${project.name}`).not.toBe('')
        expect(vp).not.toMatch(/[/.]/)
      }
    }
  })

  it('produces multi-segment paths for solutions with folders', () => {
    const nested = parsed.filter(({ doc }) => doc.nested.size > 0)
    expect(nested.length).toBeGreaterThan(40)
    for (const { file, doc } of nested) {
      const deep = doc.projects.filter((p) => doc.nested.has(p.guid))
      expect(deep.length, relative(CORPUS, file)).toBeGreaterThan(0)
      for (const p of deep) expect(doc.virtualPath(p.guid)).toContain('\\')
    }
  })

  it('reads configurations and platforms from every solution', () => {
    for (const { file, doc } of parsed) {
      expect(doc.configurations.length, relative(CORPUS, file)).toBeGreaterThan(0)
      expect(doc.platforms.length, relative(CORPUS, file)).toBeGreaterThan(0)
      const { configuration, platform } = doc.defaultConfigPlatform()
      expect(doc.configurations).toContain(configuration)
      expect(doc.platforms).toContain(platform)
    }
  })
})
