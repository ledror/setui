import { describe, expect, it } from 'vitest'
import { wrapLines } from '../src/tui/build.js'

describe('wrapLines', () => {
  it('leaves short lines alone', () => {
    expect(wrapLines(['abc', 'de'], 10)).toEqual(['abc', 'de'])
  })

  it('keeps blank lines as one row each', () => {
    expect(wrapLines(['', 'a', ''], 10)).toEqual(['', 'a', ''])
  })

  it('breaks at a space rather than mid-word', () => {
    expect(wrapLines(['hello brave world'], 12)).toEqual(['hello brave', 'world'])
  })

  it('hard-breaks a word longer than the width, losing nothing', () => {
    const path = 'C:\\a\\very\\long\\path\\without\\any\\spaces\\at\\all\\file.cpp'
    const rows = wrapLines([path], 20)
    expect(rows.join('')).toBe(path)
    expect(rows.every((r) => r.length <= 20)).toBe(true)
  })

  it('never drops characters when breaking at spaces', () => {
    const line = 'one two three four five six seven eight nine ten'
    expect(wrapLines([line], 11).join(' ')).toBe(line)
  })

  it('wraps a line into as many rows as it needs', () => {
    expect(wrapLines(['a'.repeat(25)], 10)).toHaveLength(3)
  })

  it('copes with a width of one', () => {
    expect(wrapLines(['abc'], 1)).toEqual(['a', 'b', 'c'])
  })

  it('copes with a nonsense width', () => {
    expect(wrapLines(['abc'], 0)).toEqual(['a', 'b', 'c'])
  })

  it('counts rows across several lines', () => {
    expect(wrapLines(['short', 'x'.repeat(30), 'short'], 10)).toHaveLength(5)
  })
})
