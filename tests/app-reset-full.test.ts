/** Full factory reset (files + services flag), isolated in tmp appData. */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zapret-reset-full-'))
vi.spyOn(app, 'getPath').mockImplementation((name: string) => {
  if (name === 'exe') return process.execPath
  if (name === 'appPath') return process.cwd()
  return tmp
})
vi.spyOn(app, 'getAppPath').mockImplementation(() => process.cwd())

vi.mock('../src/main/service-manager', async (importOriginal) => {
  const mod = (await importOriginal()) as Record<string, unknown>
  return { ...mod, removeServices: vi.fn() }
})

vi.mock('../src/main/linux-service', async (importOriginal) => {
  const mod = (await importOriginal()) as Record<string, unknown>
  return { ...mod, removeLinuxServices: vi.fn() }
})

import { removeServices } from '../src/main/service-manager'
import { removeLinuxServices } from '../src/main/linux-service'
import { resetAppData } from '../src/main/app-reset'
import { getDataDir, getAppLogPath, getTgProxyLogPath } from '../src/main/paths'
import { isLinux } from '../src/main/platform'

const mockRemove = vi.mocked(removeServices)
const mockRemoveLinux = vi.mocked(removeLinuxServices)

beforeEach(() => {
  mockRemove.mockReset()
  mockRemove.mockResolvedValue(undefined)
  mockRemoveLinux.mockReset()
  mockRemoveLinux.mockResolvedValue(undefined)
  // start each case from a seeded state with a sentinel file
  resetAppDataSilentCleanup()
})

function resetAppDataSilentCleanup(): void {
  try {
    fs.rmSync(path.join(tmp, 'zapret-gui'), { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

describe('resetAppData', () => {
  it('reseeds data dir, wipes logs, resets settings, reports servicesRemoved=true', async () => {
    const said: string[] = []
    const r = await resetAppData((t) => said.push(t))
    expect(r.servicesRemoved).toBe(true)
    expect(r.settings.activeStrategyId).toBeNull()
    expect(fs.existsSync(getDataDir())).toBe(true)
    expect(fs.existsSync(path.join(getDataDir(), 'lists', 'ipset-all.txt'))).toBe(true)
    expect(fs.existsSync(getAppLogPath())).toBe(false)
    expect(fs.existsSync(getTgProxyLogPath())).toBe(false)
    expect(said.some((s) => s.includes('reseeded') || s.includes('Settings reset'))).toBe(true)
    // Platform-specific removal path: Windows -> removeServices, Linux -> removeLinuxServices.
    if (isLinux()) expect(mockRemoveLinux).toHaveBeenCalledOnce()
    else expect(mockRemove).toHaveBeenCalledOnce()
  })

  it('servicesRemoved=false when service removal throws, files still reset', async () => {
    mockRemove.mockRejectedValueOnce(new Error('Access denied (SCM)'))
    mockRemoveLinux.mockRejectedValueOnce(new Error('pkexec denied'))
    // plant a custom file that must disappear after reset
    const { ensureDataDirSeeded } = await import('../src/main/paths')
    ensureDataDirSeeded()
    fs.writeFileSync(path.join(getDataDir(), 'custom-marker.txt'), 'x')
    const r = await resetAppData()
    expect(r.servicesRemoved).toBe(false)
    expect(fs.existsSync(path.join(getDataDir(), 'custom-marker.txt'))).toBe(false)
    expect(fs.existsSync(getDataDir())).toBe(true)
  })

  it('removes rotated .1 logs best-effort', async () => {
    const { ensureDataDirSeeded } = await import('../src/main/paths')
    ensureDataDirSeeded()
    fs.mkdirSync(path.dirname(getAppLogPath()), { recursive: true })
    fs.writeFileSync(getAppLogPath(), 'log')
    fs.writeFileSync(`${getAppLogPath()}.1`, 'old')
    fs.writeFileSync(getTgProxyLogPath(), 'tg')
    await resetAppData()
    expect(fs.existsSync(getAppLogPath())).toBe(false)
    expect(fs.existsSync(`${getAppLogPath()}.1`)).toBe(false)
    expect(fs.existsSync(getTgProxyLogPath())).toBe(false)
  })
})
