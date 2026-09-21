/** Unit tests for user-defined bypass targets (pure helpers + custom check). */
import { describe, it, expect } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  normalizeCustomUrlInput,
  buildCustomBypassTarget,
  normalizeCustomBypassTargets,
  isCustomBypassId,
  makeCustomBypassId,
  MAX_CUSTOM_BYPASS_TARGETS
} from '../src/shared/bypass-custom'
import { checkCustomBypassTarget } from '../src/main/bypass-check'

describe('normalizeCustomUrlInput', () => {
  it('accepts a bare domain and upgrades to https', () => {
    const r = normalizeCustomUrlInput('example.com')
    expect(r).not.toBeNull()
    expect(r!.url).toBe('https://example.com/')
    expect(r!.host).toBe('example.com')
    expect(r!.openUrl).toBe('https://example.com/')
  })

  it('keeps full URLs with path, port and http scheme', () => {
    const r = normalizeCustomUrlInput('http://localhost:3000/page?q=1')
    expect(r).not.toBeNull()
    expect(r!.url).toContain('http://localhost:3000/page')
    expect(r!.host).toBe('localhost:3000')
  })

  it('trims whitespace and accepts explicit https URLs', () => {
    const r = normalizeCustomUrlInput('  https://example.com/a  ')
    expect(r?.url).toBe('https://example.com/a')
  })

  it('rejects empty, spaces, non-http schemes and garbage', () => {
    expect(normalizeCustomUrlInput('')).toBeNull()
    expect(normalizeCustomUrlInput('   ')).toBeNull()
    expect(normalizeCustomUrlInput('foo bar')).toBeNull()
    expect(normalizeCustomUrlInput('javascript:alert(1)')).toBeNull()
    expect(normalizeCustomUrlInput('ftp://example.com')).toBeNull()
    expect(normalizeCustomUrlInput('::not a url::')).toBeNull()
    expect(normalizeCustomUrlInput('a'.repeat(3000))).toBeNull()
  })
})

describe('custom ids and builders', () => {
  it('isCustomBypassId checks the prefix', () => {
    expect(isCustomBypassId('custom-abc')).toBe(true)
    expect(isCustomBypassId('youtube')).toBe(false)
    expect(isCustomBypassId('')).toBe(false)
  })

  it('makeCustomBypassId returns unique prefixed ids', () => {
    const a = makeCustomBypassId()
    const b = makeCustomBypassId()
    expect(a.startsWith('custom-')).toBe(true)
    expect(a).not.toBe(b)
  })

  it('buildCustomBypassTarget returns null for invalid input', () => {
    expect(buildCustomBypassTarget('not a url!!')).toBeNull()
    const ok = buildCustomBypassTarget('example.com')
    expect(ok).not.toBeNull()
    expect(ok!.id.startsWith('custom-')).toBe(true)
    expect(ok!.url).toBe('https://example.com/')
  })
})

describe('normalizeCustomBypassTargets', () => {
  it('returns [] for non-arrays', () => {
    expect(normalizeCustomBypassTargets(undefined)).toEqual([])
    expect(normalizeCustomBypassTargets({})).toEqual([])
  })

  it('drops broken entries, dedupes by URL and caps at MAX', () => {
    const dup = { id: 'custom-aaa', name: 'x', url: 'https://example.com/', host: 'example.com', openUrl: 'https://example.com/' }
    const list = [
      dup,
      { ...dup, id: 'custom-bbb' },
      { id: 'bad', url: '::bad::' },
      { id: 'custom-ccc', url: 'https://other.org/a' }
    ]
    const out = normalizeCustomBypassTargets(list)
    expect(out.length).toBe(2)
    expect(out[0].url).toBe('https://example.com/')
    expect(out[1].url).toBe('https://other.org/a')
  })

  it('caps at MAX_CUSTOM_BYPASS_TARGETS', () => {
    const many = Array.from({ length: MAX_CUSTOM_BYPASS_TARGETS + 5 }, (_, i) => ({
      id: `custom-${i}`,
      url: `https://site${i}.example/`
    }))
    expect(normalizeCustomBypassTargets(many).length).toBe(MAX_CUSTOM_BYPASS_TARGETS)
  })
})

describe('checkCustomBypassTarget', () => {
  it('throws on bad id or URL', async () => {
    await expect(checkCustomBypassTarget('youtube', 'https://example.com/')).rejects.toThrow(/Invalid custom target id/)
    await expect(checkCustomBypassTarget('custom-ok', '::bad::')).rejects.toThrow(/Invalid custom URL/)
  })

  it('checks a localhost server and keeps the custom id', async () => {
    const srv = await new Promise<http.Server>((resolve) => {
      const s = http.createServer((_req, res) => {
        res.statusCode = 200
        res.end('ok')
      })
      s.listen(0, '127.0.0.1', () => resolve(s))
    })
    try {
      const a = srv.address() as AddressInfo
      const r = await checkCustomBypassTarget('custom-test1', `http://127.0.0.1:${a.port}/ping`, 3000)
      expect(r.id).toBe('custom-test1')
      expect(r.ok).toBe(true)
      expect(r.httpStatus).toBe(200)
      expect(typeof r.checkedAt).toBe('string')
    } finally {
      srv.close()
    }
  })
})
