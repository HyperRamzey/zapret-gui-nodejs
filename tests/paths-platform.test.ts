/** Paths + shared types + platform edge coverage. */
import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import {
  getDataDir,
  getBinDir,
  getListsDir,
  getUtilsDir,
  getStrategiesDir,
  getSettingsPath,
  getAppLogPath,
  getTgProxyLogPath,
  ensureDataDirSeeded
} from '../src/main/paths'
import { getPlatform, isLinux, isWindows, engineBinaryName } from '../src/main/platform'
import { logCategoryOf } from '../src/shared/types'
import { isAdminHandoverArgv, TG_PROXY_RESTART_ARG, ADMIN_RELAUNCH_ARG } from '../src/shared/constants'

describe('paths layout', () => {
  it('data children live under data dir', () => {
    expect(getBinDir()).toBe(path.join(getDataDir(), 'bin'))
    expect(getListsDir()).toBe(path.join(getDataDir(), 'lists'))
    expect(getUtilsDir()).toBe(path.join(getDataDir(), 'utils'))
    expect(getStrategiesDir()).toBe(path.join(getDataDir(), 'strategies'))
    expect(getSettingsPath()).toContain('settings.json')
    expect(getAppLogPath()).toContain('app.log')
    expect(getTgProxyLogPath()).toContain('tg-proxy.log')
  })

  it('never overwrites user-modified files on reseed', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zapret-seed-'))
    const getPath = vi.spyOn(app, 'getPath').mockImplementation(() => tmp)
    const getAppPath = vi.spyOn(app, 'getAppPath').mockImplementation(() => process.cwd())
    try {
      ensureDataDirSeeded()
      const marker = path.join(getListsDir(), 'ipset-exclude-user.txt')
      fs.writeFileSync(marker, 'custom\n', 'utf8')
      ensureDataDirSeeded()
      expect(fs.readFileSync(marker, 'utf8')).toBe('custom\n')
    } finally {
      getPath.mockRestore()
      getAppPath.mockRestore()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('platform overrides', () => {
  afterEach(() => {
    delete process.env.TEST_PLATFORM
  })

  it('TEST_PLATFORM wins (case-insensitive Windows alias)', () => {
    process.env.TEST_PLATFORM = 'Windows'
    expect(getPlatform()).toBe('win32')
    expect(isWindows()).toBe(true)
    process.env.TEST_PLATFORM = 'LINUX'
    expect(getPlatform()).toBe('linux')
    expect(isLinux()).toBe(true)
  })

  it('unknown override falls back to process.platform', () => {
    process.env.TEST_PLATFORM = 'other'
    expect(['win32', 'linux', 'other']).toContain(getPlatform())
  })

  it('engineBinaryName follows platform', () => {
    process.env.TEST_PLATFORM = 'linux'
    expect(engineBinaryName()).toBe('nfqws')
    process.env.TEST_PLATFORM = 'win32'
    expect(engineBinaryName()).toBe('winws.exe')
  })
})

describe('logCategoryOf', () => {
  it('maps sources to storage categories', () => {
    expect(logCategoryOf('app')).toBe('app')
    expect(logCategoryOf('winws')).toBe('zapret')
    expect(logCategoryOf('updater')).toBe('app')
    expect(logCategoryOf('diag')).toBe('app')
    expect(logCategoryOf('tg-proxy')).toBe('tg-proxy')
  })
})

describe('admin handover argv', () => {
  it('detects marker', () => {
    expect(isAdminHandoverArgv([ADMIN_RELAUNCH_ARG])).toBe(true)
    expect(isAdminHandoverArgv(['--foo', TG_PROXY_RESTART_ARG])).toBe(false)
    expect(isAdminHandoverArgv([])).toBe(false)
  })
})
