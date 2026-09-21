/** Unit tests for extracted renderer pure helpers (single source for pages). */
import { describe, it, expect } from 'vitest'
import {
  countListEntries,
  dedupListContent,
  sortListContent,
  splitAddParts,
  mergeAddEntries,
  splitEntries,
  parsePortDraft,
  shouldCommitDraft,
  isZapretActiveForReset,
  stateTone,
  stateKey,
  shortExePath,
  toBypassUi,
  diagTone,
  diagIcon,
  splitStrategyName
} from '../src/renderer/lib/ui-logic'

describe('countListEntries', () => {
  it('ignores blanks and #/; comments', () => {
    expect(countListEntries('# c\n; c\n\nexample.com\n  discord.com  \n')).toBe(2)
    expect(countListEntries('')).toBe(0)
    expect(countListEntries('#only\n;only')).toBe(0)
  })
})

describe('dedupListContent', () => {
  it('drops case-insensitive dupes, keeps comments', () => {
    const out = dedupListContent('# keep\nexample.com\nEXAMPLE.com\ndiscord.com\n')
    expect(out).toBe('# keep\nexample.com\ndiscord.com\n')
  })

  it('normalizes CRLF and trims entries', () => {
    expect(dedupListContent('a.com\r\n  b.com  \r\na.com\r\n')).toBe('a.com\nb.com\n')
  })

  it('empty stays empty', () => {
    expect(dedupListContent('')).toBe('')
  })
})

describe('sortListContent', () => {
  it('comments first, entries uniq + sorted', () => {
    const out = sortListContent('z.com\n# c\na.com\nZ.com\n; s\n')
    const lines = out.trim().split('\n')
    expect(lines[0]).toBe('# c')
    expect(lines[1]).toBe('; s')
    expect(lines.slice(2).map((s) => s.toLowerCase())).toEqual(['a.com', 'z.com'])
  })

  it('empty stays empty', () => {
    expect(sortListContent('  \n # only blanks? \n')).not.toBe('')
    expect(sortListContent('')).toBe('')
  })
})

describe('splitAddParts / mergeAddEntries', () => {
  it('splits on whitespace/commas/semicolons', () => {
    expect(splitAddParts('a.com, b.com;c.com d.com\n\te.com')).toEqual(['a.com', 'b.com', 'c.com', 'd.com', 'e.com'])
    expect(splitAddParts('  ,,;;  ')).toEqual([])
  })

  it('merges fresh entries, skips existing case-insensitively', () => {
    expect(mergeAddEntries('a.com\n', 'b.com, A.COM')).toBe('a.com\nb.com\n')
    expect(mergeAddEntries('a.com\n', 'a.com')).toBeNull()
    expect(mergeAddEntries('', 'x.com')).toBe('x.com\n')
  })

  it('adds trailing newline when base misses it', () => {
    expect(mergeAddEntries('a.com', 'b.com')).toBe('a.com\nb.com\n')
  })

  it('null on empty input', () => {
    expect(mergeAddEntries('a.com\n', '  ,, ')).toBeNull()
  })
})

describe('splitEntries (Settings TG inputs)', () => {
  it('splits commas/semicolons/newlines/tabs', () => {
    expect(splitEntries('a.com, b.com;c.com\nd.com\te.com')).toEqual(['a.com', 'b.com', 'c.com', 'd.com', 'e.com'])
    expect(splitEntries('  1.1.1.1  2:2.2.2.2 ')).toEqual(['1.1.1.1', '2:2.2.2.2'])
    expect(splitEntries('')).toEqual([])
  })
})

describe('parsePortDraft / shouldCommitDraft', () => {
  it('accepts 1..65535 except current', () => {
    expect(parsePortDraft('1443', 1443)).toBeNull()
    expect(parsePortDraft('80', 1443)).toBe(80)
    expect(parsePortDraft('0', 1443)).toBeNull()
    expect(parsePortDraft('65536', 1443)).toBeNull()
    expect(parsePortDraft('abc', 1443)).toBeNull()
    expect(parsePortDraft(null, 1443)).toBeNull()
  })

  it('commit guard', () => {
    expect(shouldCommitDraft(undefined, 'a')).toBe(false)
    expect(shouldCommitDraft('a', 'a')).toBe(false)
    expect(shouldCommitDraft('b', 'a')).toBe(true)
  })
})

describe('isZapretActiveForReset', () => {
  const base = { zapret: 'STOPPED', winwsRunning: false, isAdmin: true } as unknown as import('../src/shared/types').StatusSnapshot
  it('running/pending states block reset', () => {
    for (const s of ['RUNNING', 'START_PENDING', 'STOP_PENDING'] as const) {
      expect(isZapretActiveForReset({ ...base, zapret: s }, 'win32')).toBe(true)
    }
    expect(isZapretActiveForReset({ ...base, zapret: 'STOPPED' }, 'win32')).toBe(false)
    expect(isZapretActiveForReset(null, 'win32')).toBe(false)
  })

  it('stray winws blocks except unprivileged linux', () => {
    expect(isZapretActiveForReset({ ...base, winwsRunning: true }, 'win32')).toBe(true)
    expect(isZapretActiveForReset({ ...base, winwsRunning: true, isAdmin: true }, 'linux')).toBe(true)
    expect(isZapretActiveForReset({ ...base, winwsRunning: true, isAdmin: false }, 'linux')).toBe(false)
  })
})

describe('dashboard pure', () => {
  it('stateTone/stateKey matrix', () => {
    expect(stateTone('RUNNING')).toBe('green')
    expect(stateTone('STOPPED')).toBe('red')
    expect(stateTone('NOT_INSTALLED')).toBe('red')
    expect(stateTone('START_PENDING')).toBe('yellow')
    expect(stateTone('STOP_PENDING')).toBe('yellow')
    expect(stateTone('UNKNOWN')).toBe('gray')
    expect(stateKey('RUNNING')).toBe('running')
    expect(stateKey('STOPPED')).toBe('stopped')
    expect(stateKey('NOT_INSTALLED')).toBe('not-installed')
    expect(stateKey('UNKNOWN')).toBe('unknown')
  })

  it('shortExePath first token', () => {
    expect(shortExePath('"C:\\a\\winws.exe" --foo')).toBe('"C:\\a\\winws.exe"')
    expect(shortExePath('C:\\a\\winws.exe --foo')).toBe('C:\\a\\winws.exe')
    expect(shortExePath('')).toBe('')
    expect(shortExePath('—')).toBe('—')
    expect(shortExePath('"unterminated')).toBe('"unterminated')
  })

  it('toBypassUi mapping', () => {
    expect(toBypassUi(null)).toEqual({ status: 'idle' })
    expect(toBypassUi({ ok: true, latencyMs: 5, httpStatus: 200 } as never)).toEqual({
      status: 'ok',
      latencyMs: 5,
      httpStatus: 200
    })
    const fail = toBypassUi({ ok: false, latencyMs: 7, httpStatus: 403, error: 'e' } as never)
    expect(fail.status).toBe('fail')
  })
})

describe('diagnostics pure', () => {
  it('tone/icon', () => {
    expect(diagTone('ok')).toBe('green')
    expect(diagTone('warn')).toBe('yellow')
    expect(diagTone('fail')).toBe('red')
    expect(diagIcon('ok')).toBe('✅')
  })

  it('splitStrategyName', () => {
    expect(splitStrategyName('general (ALT)')).toEqual({ base: 'general', tag: 'ALT' })
    expect(splitStrategyName('plain')).toEqual({ base: 'plain', tag: null })
    expect(splitStrategyName('(only-tag)')).toEqual({ base: '(only-tag)', tag: null })
    expect(splitStrategyName('a (b) (c)')).toEqual({ base: 'a (b)', tag: 'c' })
  })
})
