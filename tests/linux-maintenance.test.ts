/** Unit tests for Linux Discord cache maintenance (tmp HOME, no real pkill). */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { clearDiscordCacheLinux } from '../src/main/linux-maintenance'

let home: string
let prevHome: string | undefined
let prevHomedir: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'zapret-home-'))
  prevHome = process.env.HOME
  process.env.HOME = home
  prevHomedir = os.homedir()
  vi.restoreAllMocks()
})

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  fs.rmSync(home, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('clearDiscordCacheLinux', () => {
  it('reports missing home when HOME empty and homedir mocked empty', async () => {
    delete process.env.HOME
    vi.spyOn(os, 'homedir').mockReturnValue('')
    const lines = await clearDiscordCacheLinux(undefined, 'en')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/APPDATA|unavailable/i)
  })

  it('reports not-found when no discord dirs', async () => {
    const onLog = vi.fn()
    const lines = await clearDiscordCacheLinux(onLog, 'en')
    expect(lines).toEqual(['Discord installations were not found'])
    expect(onLog).toHaveBeenCalledOnce()
  })

  it('clears known cache subdirs but keeps other files', async () => {
    const discord = path.join(home, '.config', 'discord')
    const keep = path.join(discord, 'Local Storage', 'keep.txt')
    fs.mkdirSync(path.join(discord, 'Cache', 'nested'), { recursive: true })
    fs.mkdirSync(path.join(discord, 'GPUCache'), { recursive: true })
    fs.writeFileSync(path.join(discord, 'Cache', 'nested', 'f.bin'), 'x')
    fs.mkdirSync(path.dirname(keep), { recursive: true })
    fs.writeFileSync(keep, 'keep')

    // pgrep/pkill do not exist on CI Windows or find nothing on Linux CI:
    // either way no process kill lines are required for the FS assertions.
    const lines = await clearDiscordCacheLinux(undefined, 'en')
    expect(fs.existsSync(path.join(discord, 'Cache'))).toBe(false)
    expect(fs.existsSync(path.join(discord, 'GPUCache'))).toBe(false)
    expect(fs.existsSync(keep)).toBe(true)
    expect(lines.some((l) => l.includes('Cache: cleared'))).toBe(true)
  })

  it('clears snap layout too', async () => {
    const snap = path.join(home, 'snap', 'discord', 'common', '.config', 'discord', 'Code Cache')
    fs.mkdirSync(snap, { recursive: true })
    const lines = await clearDiscordCacheLinux(undefined, 'en')
    expect(fs.existsSync(snap)).toBe(false)
    expect(lines.length).toBeGreaterThan(0)
  })

  it('forwards every line to onLog', async () => {
    fs.mkdirSync(path.join(home, '.config', 'discord', 'Cache'), { recursive: true })
    const seen: string[] = []
    const lines = await clearDiscordCacheLinux((t) => seen.push(t), 'en')
    expect(seen).toEqual(lines)
  })
})
