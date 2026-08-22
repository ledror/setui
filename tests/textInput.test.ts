import { describe, expect, it } from 'vitest'
import { edit, forRender, start, type TextState } from '../src/tui/textInput.js'

/** Renders the caret as `|` so expectations read like what you would see. */
const show = (s: TextState) => `${s.value.slice(0, s.cursor)}|${s.value.slice(s.cursor)}`

describe('edit', () => {
  it('starts with the caret at the end', () => {
    expect(show(start('main.c'))).toBe('main.c|')
  })

  it('inserts text at the caret', () => {
    expect(show(edit(start('main.c'), 'x', {}))).toBe('main.cx|')
  })

  it('moves left and right with the arrow keys', () => {
    let s = start('abc')
    s = edit(s, '', { leftArrow: true })
    expect(show(s)).toBe('ab|c')
    s = edit(s, '', { leftArrow: true })
    expect(show(s)).toBe('a|bc')
    s = edit(s, '', { rightArrow: true })
    expect(show(s)).toBe('ab|c')
  })

  it('does not run off either end', () => {
    expect(show(edit({ value: 'ab', cursor: 0 }, '', { leftArrow: true }))).toBe('|ab')
    expect(show(edit(start('ab'), '', { rightArrow: true }))).toBe('ab|')
  })

  it('inserts in the middle after moving left', () => {
    let s = start('main.c')
    s = edit(s, '', { leftArrow: true })
    s = edit(s, '', { leftArrow: true })
    s = edit(s, 'X', {})
    expect(s.value).toBe('mainX.c')
    expect(show(s)).toBe('mainX|.c')
  })

  it('backspaces the character before the caret', () => {
    let s = start('abc')
    s = edit(s, '', { leftArrow: true })
    s = edit(s, '', { backspace: true })
    expect(show(s)).toBe('a|c')
  })

  it('does nothing when backspacing at the start', () => {
    expect(edit({ value: 'abc', cursor: 0 }, '', { backspace: true })).toEqual({ value: 'abc', cursor: 0 })
  })

  it('deletes forwards with the delete key', () => {
    expect(show(edit({ value: 'abc', cursor: 1 }, '', { delete: true }))).toBe('a|c')
  })

  it('treats delete at the end as a backspace, which is how some terminals report it', () => {
    expect(show(edit(start('abc'), '', { delete: true }))).toBe('ab|')
  })

  it('jumps to the start and end with ctrl+a and ctrl+e', () => {
    let s = start('abc')
    s = edit(s, 'a', { ctrl: true })
    expect(show(s)).toBe('|abc')
    s = edit(s, 'e', { ctrl: true })
    expect(show(s)).toBe('abc|')
  })

  it('kills to the start with ctrl+u and to the end with ctrl+k', () => {
    expect(edit({ value: 'abcdef', cursor: 3 }, 'u', { ctrl: true })).toEqual({ value: 'def', cursor: 0 })
    expect(edit({ value: 'abcdef', cursor: 3 }, 'k', { ctrl: true })).toEqual({ value: 'abc', cursor: 3 })
  })

  it('kills the previous word with ctrl+w', () => {
    expect(show(edit(start('one two'), 'w', { ctrl: true }))).toBe('one |')
    expect(show(edit(start('one two '), 'w', { ctrl: true }))).toBe('one |')
  })

  it('moves by word with alt+b and alt+f', () => {
    let s = start('one two three')
    s = edit(s, 'b', { meta: true })
    expect(show(s)).toBe('one two |three')
    s = edit(s, 'f', { meta: true })
    expect(show(s)).toBe('one two three|')
  })

  it('maps up and down to the start and end of the line', () => {
    expect(show(edit(start('abc'), '', { upArrow: true }))).toBe('|abc')
    expect(show(edit({ value: 'abc', cursor: 0 }, '', { downArrow: true }))).toBe('abc|')
  })

  it('ignores enter, escape and tab', () => {
    const s = start('abc')
    expect(edit(s, '', { return: true })).toEqual(s)
    expect(edit(s, '', { escape: true })).toEqual(s)
    expect(edit(s, '\t', { tab: true })).toEqual(s)
  })

  it('inserts a pasted chunk in one go', () => {
    expect(edit({ value: '', cursor: 0 }, 'ab', {})).toEqual({ value: 'ab', cursor: 2 })
  })

  it('drops control characters from pasted input', () => {
    expect(edit({ value: '', cursor: 0 }, 'ab', {}).value).toBe('ab')
  })

  it('keeps backslashes, which every path here has', () => {
    expect(edit({ value: '', cursor: 0 }, 'sub\\dir\\a.c', {}).value).toBe('sub\\dir\\a.c')
  })

  it('ignores an unbound ctrl chord', () => {
    const s = start('abc')
    expect(edit(s, 'z', { ctrl: true })).toEqual(s)
  })
})

describe('forRender', () => {
  it('splits around the caret', () => {
    expect(forRender({ value: 'abc', cursor: 1 })).toEqual({ before: 'a', at: 'b', after: 'c' })
  })

  it('gives a blank cell to render at the end of the line', () => {
    expect(forRender({ value: 'abc', cursor: 3 })).toEqual({ before: 'abc', at: ' ', after: '' })
  })
})
