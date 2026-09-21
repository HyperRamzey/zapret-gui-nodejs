/** Hardening: edge cases in already-covered modules (regression locks). */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseScState,
  validateGameFilterRange,
  expandEnvVars,
  normalizeWindowsPath,
  extractExePathFromImagePath,
  buildServiceImagePath,
  quoteImagePathForSc,
  ensureListFilesExist
} from '../src/main/service-manager'
import { visibleStrategies, truncateLabel, trayTooltip, trayIconFile, trayActionsState } from '../src/main/tray'
import {
  isValidUserListName,
  normalizeUserListContent,
  countUserListEntries,
  writeUserList,
  MAX_USER_LIST_BYTES
} from '../src/main/user-lists'
import { tokenizeCommandLine, quoteArg, parseBatContent } from '../src/main/strategy-parser'
import { stopTgProxy, getTgProxyStatus } from '../src/main/tg-proxy'

describe('service-manager edges', () => {
  it('parseScState unknown on non-English output', () => {
    expect(parseScState('СОСТОЯНИЕ          : 4  RUNNING')).toBe('UNKNOWN')
    expect(parseScState('')).toBe('UNKNOWN')
  })

  it('validateGameFilterRange rejects bad, accepts compact', () => {
    expect(validateGameFilterRange('0')).toBeNull()
    expect(validateGameFilterRange('01')).toBeNull()
    expect(validateGameFilterRange('65536')).toBeNull()
    expect(validateGameFilterRange('5-3')).toBeNull()
    expect(validateGameFilterRange('')).toBeNull()
    expect(validateGameFilterRange('1,2,3,4,5,6')).toBe('1,2,3,4,5,6') // no item-count cap in code
    expect(validateGameFilterRange('1024-65535')).toBe('1024-65535')
    expect(validateGameFilterRange(' 80, 443 ')).toBe('80,443')
  })

  it('expandEnvVars case-insensitive, unknown -> empty', () => {
    process.env.ZAPRET_TEST_VAR = 'hello'
    expect(expandEnvVars('%zapret_test_var%/x')).toBe('hello/x')
    expect(expandEnvVars('%DEFINITELY_UNKNOWN_VAR_XYZ%/x')).toBe('/x')
    delete process.env.ZAPRET_TEST_VAR
  })

  it('normalizeWindowsPath unifies + lowercases + strips quotes', () => {
    expect(normalizeWindowsPath('"C:/A/B"')).toBe('c:\\a\\b')
    expect(normalizeWindowsPath('C:\\X\\')).toBe('c:\\x\\')
  })

  it('extractExePathFromImagePath quoted vs bare', () => {
    expect(extractExePathFromImagePath('"C:\\a\\winws.exe" --foo')).toBe('C:\\a\\winws.exe')
    expect(extractExePathFromImagePath('C:\\a\\winws.exe --foo')).toBe('C:\\a\\winws.exe')
  })

  it('buildServiceImagePath + quoteImagePathForSc round-trip', () => {
    const img = buildServiceImagePath('C:\\bin\\winws.exe', ['--foo', 'a b'])
    expect(img).toContain('winws.exe')
    expect(quoteImagePathForSc(img).startsWith('"')).toBe(true)
  })

  it('ensureListFilesExist rejects outside-dir refs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zapret-outside-'))
    // Forward slash: path separator on both Windows and Linux (backslash is
    // a valid filename char on Linux, so '..\\evil' would stay inside).
    expect(() => ensureListFilesExist(dir, ['--hostlist=../evil.txt'] as never)).toThrow(/outside/i)
  })
})

describe('tray edges', () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ id: `id${i}`, name: `s${i}` }))

  it('visibleStrategies respects limit<=0', () => {
    expect(visibleStrategies(items, 'id9', 's9', 0)).toEqual([])
    expect(visibleStrategies(items, 'id9', 's9', -3)).toEqual([])
  })

  it('visibleStrategies appends active outside window', () => {
    const v = visibleStrategies(items, 'id9', 's9', 3)
    expect(v).toHaveLength(4)
    expect(v[v.length - 1].id).toBe('id9')
  })

  it('truncateLabel ascii + short passthrough', () => {
    expect(truncateLabel('short')).toBe('short')
    const t = truncateLabel('x'.repeat(100), 10)
    expect(t.length).toBeLessThanOrEqual(10)
    expect(t.endsWith('…')).toBe(true)
  })

  it('trayTooltip trims + caps 127', () => {
    expect(trayTooltip('run', '  ')).not.toContain('·')
    expect(trayTooltip('run', 's', 'tg').length).toBeLessThanOrEqual(127)
    expect(trayTooltip('run', 'x'.repeat(500)).length).toBeLessThanOrEqual(127)
  })

  it('trayIconFile + actions matrix', () => {
    expect(trayIconFile('running')).toMatch(/\.png$/)
    expect(trayActionsState('running', true, 'ours')).toEqual({ start: false, stop: true, restart: true })
    expect(trayActionsState('running', false, 'ours').stop).toBe(false)
    expect(trayActionsState('running', true, 'foreign').stop).toBe(false)
    expect(trayActionsState('not-installed', true, 'ours')).toEqual({ start: false, stop: false, restart: false })
    expect(trayActionsState('unknown', true, 'ours').start).toBe(true)
  })
})

describe('user-lists edges', () => {
  it('rejects 65-char names, accepts 64 (suffix -user.txt is 9 chars)', () => {
    expect(isValidUserListName(`${'a'.repeat(55)}-user.txt`)).toBe(true) // 64 total
    expect(isValidUserListName(`${'a'.repeat(56)}-user.txt`)).toBe(false) // 65 total
  })

  it('BOM-prefixed comment is still treated as comment (trim strips FEFF)', () => {
    expect(countUserListEntries('﻿# comment\n')).toBe(0)
    expect(countUserListEntries('﻿example.com\n')).toBe(1)
  })

  it('CRLF + trailing spaces normalized', () => {
    expect(normalizeUserListContent('a.com  \r\n\r\n')).toBe('a.com\n')
  })

  it('oversize content rejected', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zapret-big-'))
    // Just over the 16 MB cap (single huge line — bytes, not lines, matter).
    const big = 'x'.repeat(MAX_USER_LIST_BYTES + 1024)
    expect(() => writeUserList(dir, 'list-exclude-user.txt', big)).toThrow(/too large|exceed/i)
  })
})

describe('strategy-parser edges', () => {
  it('tokenize keeps quoted value together (quote-stripping is a later stage)', () => {
    expect(tokenizeCommandLine('--hostlist="a b.txt" --foo')).toEqual(['--hostlist="a b.txt"', '--foo'])
  })

  it('quoteArg quotes shell metachars', () => {
    expect(quoteArg('a&b')).toBe('"a&b"')
    expect(quoteArg('plain')).toBe('plain')
  })

  it('parseBatContent without winws yields empty args + warning', () => {
    const { strategy, warnings } = parseBatContent('@echo hi\n', 'x.bat')
    expect(strategy.args).toEqual([])
    expect(warnings.length).toBeGreaterThan(0)
  })
})

describe('tg-proxy lifecycle idempotence', () => {
  it('stop without start is safe, status stopped', async () => {
    await stopTgProxy()
    expect(getTgProxyStatus().status).toBe('stopped')
    await stopTgProxy()
    expect(getTgProxyStatus().status).toBe('stopped')
  })
})
