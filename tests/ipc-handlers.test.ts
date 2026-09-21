/** Unit tests for IPC-layer pure helpers (merge, validators, secret). */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zapret-ipc-'))
vi.spyOn(app, 'getPath').mockImplementation((name: string) => {
  if (name === 'exe') return process.execPath
  return tmp
})
vi.spyOn(app, 'getAppPath').mockImplementation(() => process.cwd())

import {
  listStrategies,
  ensureTgProxySecret,
  validateTgHost,
  validateDcIpEntries,
  validatePoolSize,
  validateBufferKb,
  validateDomainEntries,
  validateFakeTlsDomain,
  normalizeLogCategory,
  stopAllTesting
} from '../src/main/ipc-handlers'
import { getStrategiesDir } from '../src/main/paths'

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('validateTgHost', () => {
  it('accepts loopback + any', () => {
    expect(validateTgHost('127.0.0.1')).toBe('127.0.0.1')
    expect(validateTgHost('0.0.0.0')).toBe('0.0.0.0')
  })

  it('rejects non-strings and empty, trims padded loopback', () => {
    expect(() => validateTgHost(123)).toThrow(/Invalid TG proxy host/)
    expect(() => validateTgHost('')).toThrow(/Invalid TG proxy host/)
    // padded fallback trims to fallback and is accepted (normalizeTgHost trims)
    expect(validateTgHost(' 127.0.0.1 ')).toBe('127.0.0.1')
  })
})

describe('validateDcIpEntries', () => {
  it('empty -> []', () => {
    expect(validateDcIpEntries('')).toEqual([])
    expect(validateDcIpEntries([])).toEqual([])
  })

  it('parses dc:ip pairs', () => {
    expect(validateDcIpEntries(['1:9.9.9.9'])).toEqual(['1:9.9.9.9'])
    expect(validateDcIpEntries('2:8.8.8.8, 3:1.1.1.1')).toHaveLength(2)
  })

  it('throws on malformed entry', () => {
    expect(() => validateDcIpEntries(['nope'])).toThrow()
    expect(() => validateDcIpEntries(['1:not-an-ip'])).toThrow()
  })
})

describe('validatePoolSize / validateBufferKb', () => {
  it('pool 0..32', () => {
    expect(validatePoolSize(0)).toBe(0)
    expect(validatePoolSize(32)).toBe(32)
    expect(validatePoolSize('8')).toBe(8)
    expect(() => validatePoolSize(-1)).toThrow()
    expect(() => validatePoolSize(33)).toThrow()
    expect(() => validatePoolSize('x')).toThrow()
  })

  it('buffer 4..4096', () => {
    expect(validateBufferKb(64)).toBe(64)
    expect(() => validateBufferKb(3)).toThrow()
    expect(() => validateBufferKb(5000)).toThrow()
    expect(() => validateBufferKb(Number.NaN)).toThrow()
  })
})

describe('validateDomainEntries / validateFakeTlsDomain', () => {
  it('accepts valid domains, throws on bad', () => {
    expect(validateDomainEntries(['example.com'], 'cf')).toEqual(['example.com'])
    expect(validateDomainEntries('', 'cf')).toEqual([])
    expect(() => validateDomainEntries(['not a domain!!'], 'cf')).toThrow(/Invalid cf/)
  })

  it('empty fake-tls allowed, bad rejected', () => {
    expect(validateFakeTlsDomain('')).toBe('')
    expect(validateFakeTlsDomain('  ')).toBe('')
    expect(validateFakeTlsDomain('Example.COM')).toBe('example.com')
    expect(() => validateFakeTlsDomain('bad..domain')).toThrow()
  })
})

describe('normalizeLogCategory', () => {
  it('passes through known, falls back to all', () => {
    expect(normalizeLogCategory('app')).toBe('app')
    expect(normalizeLogCategory('zapret')).toBe('zapret')
    expect(normalizeLogCategory('tg-proxy')).toBe('tg-proxy')
    expect(normalizeLogCategory('x')).toBe('all')
    expect(normalizeLogCategory(undefined)).toBe('all')
  })
})

describe('listStrategies merge', () => {
  it('data wins over bundled, broken JSON skipped, sorted', () => {
    const dir = getStrategiesDir()
    fs.mkdirSync(dir, { recursive: true })
    const bundled = listStrategies()
    expect(bundled.length).toBeGreaterThan(0)

    // broken file is skipped
    fs.writeFileSync(path.join(dir, 'broken.json'), '{oops', 'utf8')
    // data override of the first bundled id
    const first = bundled[0]
    fs.writeFileSync(
      path.join(dir, `${first.id}.json`),
      JSON.stringify({ ...first, name: 'ZZZ custom', origin: 'imported' }),
      'utf8'
    )
    const merged = listStrategies()
    const found = merged.find((s) => s.id === first.id)
    expect(found?.name).toBe('ZZZ custom')
    expect(found?.origin).toBe('imported')
    // sorted by name (en numeric)
    const names = merged.map((s) => s.name)
    expect([...names].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))).toEqual(names)
    // legacy without origin counts as bundled
    fs.writeFileSync(
      path.join(dir, 'legacy-test-id.json'),
      JSON.stringify({ id: 'legacy-test-id', name: 'Legacy', fileName: 'x.bat', args: [], rawArgs: '', desyncMethods: [] }),
      'utf8'
    )
    expect(listStrategies().find((s) => s.id === 'legacy-test-id')?.origin).toBe('bundled')
  })
})

describe('ensureTgProxySecret', () => {
  it('generates once then stable', () => {
    const a = ensureTgProxySecret()
    expect(a.tgProxy.secret).toMatch(/^[0-9a-f]{32}$/)
    const b = ensureTgProxySecret()
    expect(b.tgProxy.secret).toBe(a.tgProxy.secret)
  })
})

describe('stopAllTesting', () => {
  it('is a safe no-op without running tests', () => {
    expect(() => stopAllTesting()).not.toThrow()
  })
})
