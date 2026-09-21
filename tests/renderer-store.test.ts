/** Unit tests for zustand store pure helpers (no React rendering). */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { bypassStrategyKeyOf, isDarkTheme } from '../src/renderer/store'

beforeEach(() => {
  vi.unstubAllGlobals()
})

function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal('window', {
    matchMedia: () => ({ matches })
  })
}

describe('bypassStrategyKeyOf', () => {
  it('joins active + id', () => {
    expect(bypassStrategyKeyOf('general', 'id1')).toBe('general::id1')
    expect(bypassStrategyKeyOf(null, null)).toBe('::')
    expect(bypassStrategyKeyOf(null, 'x')).toBe('::x')
  })

  it('changes when either part changes', () => {
    const a = bypassStrategyKeyOf('a', '1')
    expect(bypassStrategyKeyOf('b', '1')).not.toBe(a)
    expect(bypassStrategyKeyOf('a', '2')).not.toBe(a)
    expect(bypassStrategyKeyOf('a', '1')).toBe(a)
  })
})

describe('isDarkTheme', () => {
  it('fixed themes ignore OS', () => {
    stubMatchMedia(true)
    expect(isDarkTheme('dark')).toBe(true)
    expect(isDarkTheme('light')).toBe(false)
    stubMatchMedia(false)
    expect(isDarkTheme('dark')).toBe(true)
    expect(isDarkTheme('light')).toBe(false)
  })

  it('auto follows OS', () => {
    stubMatchMedia(true)
    expect(isDarkTheme('auto')).toBe(true)
    stubMatchMedia(false)
    expect(isDarkTheme('auto')).toBe(false)
  })
})
