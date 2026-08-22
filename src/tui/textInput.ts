/**
 * Line editing for the TUI's prompts, kept as a pure function so the key handling
 * can be tested without rendering anything. Ink's `useInput` hands us the same
 * (input, key) pair this takes.
 */

export interface TextState {
  value: string
  /** Caret position, 0..value.length. */
  cursor: number
}

/** The subset of Ink's Key we act on. */
export interface EditKey {
  leftArrow?: boolean
  rightArrow?: boolean
  upArrow?: boolean
  downArrow?: boolean
  backspace?: boolean
  delete?: boolean
  ctrl?: boolean
  meta?: boolean
  return?: boolean
  escape?: boolean
  tab?: boolean
}

export const start = (value: string): TextState => ({ value, cursor: value.length })

const clamp = (n: number, max: number) => Math.max(0, Math.min(n, max))

/** Start of the word before the caret, for ctrl+w and ctrl+left. */
function wordStart(value: string, cursor: number): number {
  let i = cursor
  while (i > 0 && /\s/.test(value[i - 1] ?? '')) i--
  while (i > 0 && !/\s/.test(value[i - 1] ?? '')) i--
  return i
}

function wordEnd(value: string, cursor: number): number {
  let i = cursor
  while (i < value.length && /\s/.test(value[i] ?? '')) i++
  while (i < value.length && !/\s/.test(value[i] ?? '')) i++
  return i
}

export function edit(state: TextState, input: string, key: EditKey): TextState {
  const { value, cursor } = state

  if (key.ctrl) {
    switch (input) {
      case 'a':
        return { value, cursor: 0 }
      case 'e':
        return { value, cursor: value.length }
      case 'b':
        return { value, cursor: clamp(cursor - 1, value.length) }
      case 'f':
        return { value, cursor: clamp(cursor + 1, value.length) }
      case 'u': // kill to start
        return { value: value.slice(cursor), cursor: 0 }
      case 'k': // kill to end
        return { value: value.slice(0, cursor), cursor }
      case 'w': { // kill the word before the caret
        const at = wordStart(value, cursor)
        return { value: value.slice(0, at) + value.slice(cursor), cursor: at }
      }
      case 'd': { // delete forwards
        return { value: value.slice(0, cursor) + value.slice(cursor + 1), cursor }
      }
      default:
        return state
    }
  }

  // Alt/Option + b and f: word-wise movement, as in readline.
  if (key.meta) {
    if (input === 'b') return { value, cursor: wordStart(value, cursor) }
    if (input === 'f') return { value, cursor: wordEnd(value, cursor) }
    return state
  }

  if (key.leftArrow) return { value, cursor: clamp(cursor - 1, value.length) }
  if (key.rightArrow) return { value, cursor: clamp(cursor + 1, value.length) }
  // Home and End arrive as up/down in most terminals' Ink mapping; treat both.
  if (key.upArrow) return { value, cursor: 0 }
  if (key.downArrow) return { value, cursor: value.length }

  if (key.backspace) {
    if (cursor === 0) return state
    return { value: value.slice(0, cursor - 1) + value.slice(cursor), cursor: cursor - 1 }
  }
  if (key.delete) {
    // Ink reports the Backspace key as `delete` on some terminals; a caret at the
    // end can only mean backspace, so fall back to that rather than doing nothing.
    if (cursor >= value.length) {
      if (cursor === 0) return state
      return { value: value.slice(0, cursor - 1), cursor: cursor - 1 }
    }
    return { value: value.slice(0, cursor) + value.slice(cursor + 1), cursor }
  }

  if (key.return || key.escape || key.tab || !input) return state

  // Printable text, which may arrive as a whole pasted chunk.
  const printable = [...input].filter((c) => c >= ' ' && c !== '\x7f').join('')
  if (!printable) return state
  return { value: value.slice(0, cursor) + printable + value.slice(cursor), cursor: cursor + printable.length }
}

/** Splits the value for rendering a block caret at the cursor. */
export function forRender(state: TextState): { before: string; at: string; after: string } {
  return {
    before: state.value.slice(0, state.cursor),
    at: state.value[state.cursor] ?? ' ',
    after: state.value.slice(state.cursor + 1),
  }
}
