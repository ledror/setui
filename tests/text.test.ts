import { describe, expect, it } from 'vitest'
import { applySplices, detectEol, lineIndent } from '../src/core/text.js'

describe('applySplices', () => {
  it('returns the identical string for no splices', () => {
    const s = 'hello'
    expect(applySplices(s, [])).toBe(s)
  })

  it('applies a single replacement', () => {
    expect(applySplices('hello world', [{ start: 6, end: 11, text: 'there' }])).toBe('hello there')
  })

  it('applies multiple splices regardless of input order', () => {
    const src = 'aaa bbb ccc'
    const splices = [
      { start: 8, end: 11, text: 'Z' },
      { start: 0, end: 3, text: 'X' },
      { start: 4, end: 7, text: 'Y' },
    ]
    expect(applySplices(src, splices)).toBe('X Y Z')
  })

  it('supports pure insertions (start === end)', () => {
    expect(applySplices('ab', [{ start: 1, end: 1, text: '-' }])).toBe('a-b')
  })

  it('allows adjacent splices', () => {
    expect(applySplices('abcd', [
      { start: 0, end: 2, text: 'X' },
      { start: 2, end: 4, text: 'Y' },
    ])).toBe('XY')
  })

  it('rejects overlapping splices', () => {
    expect(() => applySplices('abcd', [
      { start: 0, end: 3, text: 'X' },
      { start: 2, end: 4, text: 'Y' },
    ])).toThrow(/overlap/i)
  })

  it('rejects out-of-range splices', () => {
    expect(() => applySplices('ab', [{ start: 0, end: 5, text: '' }])).toThrow(/range/i)
    expect(() => applySplices('ab', [{ start: 2, end: 1, text: '' }])).toThrow(/range/i)
  })

  it('keeps two insertions at the same offset in argument order', () => {
    expect(applySplices('ab', [
      { start: 1, end: 1, text: '1' },
      { start: 1, end: 1, text: '2' },
    ])).toBe('a12b')
  })
})

describe('detectEol', () => {
  it('detects CRLF', () => expect(detectEol('a\r\nb')).toBe('\r\n'))
  it('detects LF', () => expect(detectEol('a\nb')).toBe('\n'))
  it('uses the first occurrence', () => expect(detectEol('a\nb\r\nc')).toBe('\n'))
  it('defaults to LF with no newline', () => expect(detectEol('abc')).toBe('\n'))
})

describe('lineIndent', () => {
  it('returns the whitespace prefix of the line containing the offset', () => {
    const src = 'a\n    <X />\nb'
    expect(lineIndent(src, src.indexOf('<X'))).toBe('    ')
  })
  it('handles tabs', () => {
    const src = 'a\r\n\t\tfoo'
    expect(lineIndent(src, src.indexOf('foo'))).toBe('\t\t')
  })
  it('returns empty for an unindented first line', () => {
    expect(lineIndent('foo\nbar', 1)).toBe('')
  })
})
