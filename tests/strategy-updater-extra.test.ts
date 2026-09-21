/** Extra coverage for strategy-updater pure paths + fakes + hosts removal. */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zapret-upd-extra-'))
vi.spyOn(app, 'getPath').mockImplementation((name: string) => {
  if (name === 'exe') return process.execPath
  return tmp
})
vi.spyOn(app, 'getAppPath').mockImplementation(() => process.cwd())

import {
  compareVersions,
  compareEngineVersions,
  isValidEngineTag,
  engineAssetUrl,
  parseEngineReleases,
  upstreamSourceArchiveUrl,
  getBundledZapretVersion,
  getSystemHostsPath,
  removeHosts,
  listAvailableFakes,
  replaceActiveFake,
  isForeignEngineBinary
} from '../src/main/strategy-updater'
import { getBinDir } from '../src/main/paths'

beforeEach(() => {
  vi.restoreAllMocks()
  fs.mkdirSync(getBinDir(), { recursive: true })
  for (const f of fs.readdirSync(getBinDir())) {
    fs.rmSync(path.join(getBinDir(), f), { force: true })
  }
})

describe('compareVersions garbage safety', () => {
  it('garbage equals any version (NaN-safe 0)', () => {
    expect(compareVersions('html', '1.0')).toBe(0)
    expect(compareVersions('', '')).toBe(0)
  })

  it('strips v/V and compares numerically', () => {
    expect(compareVersions('v1.10.2', '1.9.9')).toBe(1)
    expect(compareVersions('V2.0', 'v2.0.0')).toBe(0)
    expect(compareVersions('1.0', '1.0.1')).toBe(-1)
  })
})

describe('engine tags', () => {
  it('validates format', () => {
    expect(isValidEngineTag('v72.13')).toBe(true)
    expect(isValidEngineTag('v1')).toBe(true)
    expect(isValidEngineTag('72.13')).toBe(false)
    expect(isValidEngineTag('v<script>')).toBe(false)
    expect(isValidEngineTag('')).toBe(false)
  })

  it('engineAssetUrl throws on invalid', () => {
    expect(engineAssetUrl('v72.13')).toContain('zapret-v72.13.zip')
    expect(() => engineAssetUrl('nope')).toThrow(/Invalid engine tag/)
  })

  it('compareEngineVersions numeric (72.13 > 72.9)', () => {
    expect(compareEngineVersions('v72.13', 'v72.9')).toBe(1)
    expect(compareEngineVersions('v72.9', 'v72.13')).toBe(-1)
    expect(compareEngineVersions('v1.0', 'v1.0.0')).toBe(0)
    expect(compareEngineVersions('v1.x', 'v1.0')).toBe(0)
  })
})

describe('parseEngineReleases', () => {
  it('skips invalid, keeps order, caps limit', () => {
    const json = [
      { tag_name: 'v2', name: 'R2', published_at: '2024-01-02', html_url: 'https://x/2', assets: [] },
      { tag_name: 'bad', name: 'Bad' },
      { tag_name: 'v1', assets: [{ name: 'zapret-v1.zip', browser_download_url: 'https://cdn/v1.zip' }] },
      null,
      'str'
    ]
    const out = parseEngineReleases(json, 10)
    expect(out.map((r) => r.tag)).toEqual(['v2', 'v1'])
    expect(out[1].zipUrl).toBe('https://cdn/v1.zip')
    expect(out[0].zipUrl).toContain('zapret-v2.zip')
    expect(parseEngineReleases(json, 1)).toHaveLength(1)
    expect(parseEngineReleases('nope')).toEqual([])
  })

  it('falls back htmlUrl when missing', () => {
    const [r] = parseEngineReleases([{ tag_name: 'v3' }])
    expect(r.htmlUrl).toContain('/releases/tag/v3')
  })
})

describe('misc pure', () => {
  it('upstreamSourceArchiveUrl uses branch', () => {
    expect(upstreamSourceArchiveUrl()).toContain('/zip/refs/heads/')
  })

  it('getBundledZapretVersion falls back', () => {
    expect(getBundledZapretVersion().length).toBeGreaterThan(0)
  })

  it('getSystemHostsPath per platform', () => {
    expect(getSystemHostsPath().length).toBeGreaterThan(0)
  })

  it('isForeignEngineBinary detects foreign names per OS', () => {
    // Only known cross-OS engine files count as foreign; unknown names are not.
    expect(isForeignEngineBinary('evil.exe')).toBe(false)
    expect(isForeignEngineBinary('random.bin')).toBe(false)
    // Platform-relative: on Windows nfqws is foreign, on Linux winws is.
    if (process.env.TEST_PLATFORM === 'linux' || (process.platform === 'linux' && !process.env.TEST_PLATFORM)) {
      expect(isForeignEngineBinary('winws.exe')).toBe(true)
      expect(isForeignEngineBinary('WinDivert.dll')).toBe(true)
      expect(isForeignEngineBinary('nfqws')).toBe(false)
    } else {
      expect(isForeignEngineBinary('nfqws')).toBe(true)
      expect(isForeignEngineBinary('winws.exe')).toBe(false)
    }
  })
})

describe('listAvailableFakes / replaceActiveFake', () => {
  it('lists and matches active by content', () => {
    const bin = getBinDir()
    fs.writeFileSync(path.join(bin, 'aaa.bin'), Buffer.from([1, 2, 3]))
    fs.writeFileSync(path.join(bin, 'bbb.bin'), Buffer.from([4, 5, 6]))
    fs.writeFileSync(path.join(bin, 'ACTIVE_DISCORD_UDP.bin'), Buffer.from([1, 2, 3]))
    const r = listAvailableFakes()
    expect(r.all.sort()).toEqual(['aaa', 'bbb'])
    expect(r.discordActive).toBe('aaa')
    expect(r.gameActive).toBeNull()
  })

  it('replace copies and validates', () => {
    const bin = getBinDir()
    fs.writeFileSync(path.join(bin, 'good-fake_1.bin'), Buffer.from([9]))
    replaceActiveFake('game', 'good-fake_1')
    expect(fs.readFileSync(path.join(bin, 'ACTIVE_GAME_UDP.bin'))).toEqual(Buffer.from([9]))
    expect(() => replaceActiveFake('discord', '../../evil')).toThrow(/Invalid fake name/)
    // @ts-expect-error runtime
    expect(() => replaceActiveFake('bad', 'good-fake_1')).toThrow()
    expect(() => replaceActiveFake('discord', 'missing')).toThrow(/not found/i)
  })
})

describe('removeHosts single-marker fallback', () => {
  it('removes a lone first marker via includes fallback', async () => {
    const p = path.join(tmp, 'hosts-single')
    fs.writeFileSync(p, '127.0.0.1 localhost\nFIRST-MARKER-XYZ\n10.0.0.1 other\n', 'utf8')
    const removed = await removeHosts({ hostsPath: p, firstLine: 'FIRST-MARKER-XYZ', lastLine: 'LAST-MISSING', remoteContent: '' })
    expect(removed).toBe(true)
    expect(fs.readFileSync(p, 'utf8')).not.toContain('FIRST-MARKER-XYZ')
  })

  it('returns false when nothing matches', async () => {
    const p = path.join(tmp, 'hosts-clean')
    fs.writeFileSync(p, '127.0.0.1 localhost\n', 'utf8')
    const removed = await removeHosts({ hostsPath: p, firstLine: 'NOPE-1', lastLine: 'NOPE-2', remoteContent: 'NOPE-1\nNOPE-2' })
    expect(removed).toBe(false)
  })

  it('throws readable error when hosts unreadable', async () => {
    await expect(removeHosts({ hostsPath: path.join(tmp, 'no-such-dir', 'hosts') })).rejects.toThrow()
  })
})
