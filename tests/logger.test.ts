/** Unit tests for the file + ring-buffer logger. */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  setLogsEnabled,
  isLogsEnabled,
  initLogger,
  onLog,
  getBufferedLogs,
  getBufferedLogCounts,
  clearBufferedLogs,
  log,
  info,
  warn,
  err
} from '../src/main/logger'
import { LOG_BUFFER_LIMITS } from '../src/shared/constants'

let dir: string
let appLog: string
let tgLog: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zapret-logger-'))
  appLog = path.join(dir, 'app.log')
  tgLog = path.join(dir, 'tg-proxy.log')
  clearBufferedLogs('all')
  setLogsEnabled(true)
  initLogger(appLog, tgLog)
  vi.restoreAllMocks()
})

describe('master switch', () => {
  it('drops everything when disabled', () => {
    setLogsEnabled(false)
    expect(isLogsEnabled()).toBe(false)
    expect(log('app', 'info', 'hello')).toBeNull()
    expect(getBufferedLogs('all')).toEqual([])
    expect(fs.existsSync(appLog)).toBe(false)
    setLogsEnabled(true)
    expect(isLogsEnabled()).toBe(true)
  })

  it('only exact true enables', () => {
    setLogsEnabled(false)
    // @ts-expect-error runtime coercion check
    setLogsEnabled(1)
    expect(isLogsEnabled()).toBe(false)
    setLogsEnabled(true)
    expect(isLogsEnabled()).toBe(true)
  })
})

describe('ring buffers per category', () => {
  it('splits app/zapret/tg-proxy independently', () => {
    info('app', 'a1')
    info('winws', 'z1')
    info('tg-proxy', 't1')
    expect(getBufferedLogCounts()).toEqual({ app: 1, zapret: 1, 'tg-proxy': 1 })
    const all = getBufferedLogs('all')
    expect(all).toHaveLength(3)
    // category slices are copies
    const app = getBufferedLogs('app')
    app.push({ ts: 'x', source: 'app', level: 'info', text: 'fake' } as never)
    expect(getBufferedLogCounts().app).toBe(1)
  })

  it('caps each category independently (tg-proxy spam cannot evict app)', () => {
    const cap = LOG_BUFFER_LIMITS['tg-proxy']
    for (let i = 0; i < cap + 50; i++) info('tg-proxy', `t${i}`)
    info('app', 'keep-me')
    expect(getBufferedLogCounts()['tg-proxy']).toBe(cap)
    expect(getBufferedLogCounts().app).toBe(1)
    const tg = getBufferedLogs('tg-proxy')
    expect(tg[0].text).toBe('t50')
    expect(tg[tg.length - 1].text).toBe(`t${cap + 49}`)
  })

  it('clearBufferedLogs per category and all', () => {
    info('app', 'a')
    info('winws', 'z')
    info('tg-proxy', 't')
    clearBufferedLogs('app')
    expect(getBufferedLogCounts()).toEqual({ app: 0, zapret: 1, 'tg-proxy': 1 })
    clearBufferedLogs('all')
    expect(getBufferedLogCounts()).toEqual({ app: 0, zapret: 0, 'tg-proxy': 0 })
    clearBufferedLogs()
    expect(getBufferedLogs('all')).toEqual([])
  })
})

describe('file routing + rotation prep', () => {
  it('writes app/zapret to app.log and tg-proxy to tg-proxy.log', () => {
    info('app', 'hello-app')
    info('winws', 'hello-zapret')
    info('tg-proxy', 'hello-tg')
    const appContent = fs.readFileSync(appLog, 'utf8')
    const tgContent = fs.readFileSync(tgLog, 'utf8')
    expect(appContent).toContain('hello-app')
    expect(appContent).toContain('hello-zapret')
    expect(appContent).not.toContain('hello-tg')
    expect(tgContent).toContain('hello-tg')
    expect(tgContent).not.toContain('hello-app')
  })

  it('derives tg-proxy.log next to app.log when second arg omitted', () => {
    const derived = path.join(dir, 'app.log')
    initLogger(derived)
    info('tg-proxy', 'derived-route')
    const expected = path.join(dir, 'tg-proxy.log')
    expect(fs.readFileSync(expected, 'utf8')).toContain('derived-route')
  })

  it('appends double extension when appPath has no app.log suffix', () => {
    const custom = path.join(dir, 'custom.log')
    initLogger(custom)
    info('tg-proxy', 'double-ext')
    expect(fs.readFileSync(`${custom}.tg-proxy.log`, 'utf8')).toContain('double-ext')
  })

  it('tolerates unwritable paths without throwing', () => {
    initLogger(path.join(dir, 'no-such-dir', 'x', 'app.log'), path.join(dir, 'no-such-dir', 'x', 'tg.log'))
    // appendFileSync fails (missing dir) -> caught, still buffers + returns line
    const line = info('app', 'best-effort')
    expect(line).not.toBeNull()
    expect(getBufferedLogCounts().app).toBe(1)
  })
})

describe('listeners', () => {
  it('notifies and unsubscribes', () => {
    const seen: string[] = []
    const off = onLog((l) => seen.push(l.text))
    info('app', 'one')
    off()
    info('app', 'two')
    expect(seen).toEqual(['one'])
  })

  it('a throwing listener never breaks logging', () => {
    onLog(() => {
      throw new Error('listener boom')
    })
    const line = info('app', 'survives')
    expect(line?.text).toBe('survives')
    expect(getBufferedLogCounts().app).toBe(1)
  })

  it('error level goes to console.error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    err('app', 'oops')
    expect(spy).toHaveBeenCalledOnce()
    spy.mockRestore()
    const spy2 = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    warn('app', 'no-console')
    expect(spy2).not.toHaveBeenCalled()
    spy2.mockRestore()
  })
})
