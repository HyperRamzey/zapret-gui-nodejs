/** Settings save notifications (instant tray rebuild) + tray flag defaults. */
import { describe, it, expect, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { app } from 'electron'
import { loadSettings, saveSettings, onSettingsChanged, sanitizeSettingsPatch, isValidSettingsStrategyId } from '../src/main/settings'
import type { AppSettings } from '../src/shared/types'

// Isolate fs writes: point appData at a fresh tmp dir (setup.ts maps it to cwd).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zapret-settings-'))
vi.spyOn(app, 'getPath').mockImplementation((name: string) => {
  if (name === 'exe') return process.cwd()
  return tmp
})

describe('tray settings defaults', () => {
  it('fresh settings enable the icon and all tray menu sections', () => {
    const s = loadSettings()
    expect(s.showTrayIcon).toBe(true)
    expect(s.trayStrategyMenu).toBe(true)
    expect(s.trayServiceMenu).toBe(true)
    expect(s.trayNavigateMenu).toBe(true)
    expect(s.trayGameFilterMenu).toBe(true)
    expect(s.trayIPSetMenu).toBe(true)
    expect(s.trayToolsMenu).toBe(true)
    expect(s.trayQuickSettings).toBe(true)
  })
})

describe('onSettingsChanged', () => {
  it('fires synchronously on every saveSettings with the merged result', () => {
    const seen: AppSettings[] = []
    const off = onSettingsChanged((next) => {
      seen.push(next)
    })
    try {
      const next = saveSettings({ trayStrategyMenu: false })
      expect(next.trayStrategyMenu).toBe(false)
      expect(seen).toHaveLength(1)
      expect(seen[0].trayStrategyMenu).toBe(false)
      // Untouched flags survive the patch.
      expect(seen[0].trayGameFilterMenu).toBe(true)

      saveSettings({ trayStrategyMenu: true })
      expect(seen).toHaveLength(2)
      expect(seen[1].trayStrategyMenu).toBe(true)
    } finally {
      off()
    }
  })

  it('stops firing after unsubscribe', () => {
    const seen: AppSettings[] = []
    const off = onSettingsChanged((next) => {
      seen.push(next)
    })
    off()
    saveSettings({ trayGameFilterMenu: false })
    saveSettings({ trayGameFilterMenu: true })
    expect(seen).toHaveLength(0)
  })

  it('migrates legacy trayTuningMenu to game/ipset flags', () => {    const file = path.join(tmp, 'zapret-gui', 'settings.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ trayTuningMenu: false }), 'utf8')
    const s = loadSettings()
    expect(s.trayGameFilterMenu).toBe(false)
    expect(s.trayIPSetMenu).toBe(false)
    // Explicit new flags win over the legacy one.
    fs.writeFileSync(file, JSON.stringify({ trayTuningMenu: false, trayGameFilterMenu: true }), 'utf8')
    const s2 = loadSettings()
    expect(s2.trayGameFilterMenu).toBe(true)
    expect(s2.trayIPSetMenu).toBe(false)
  })
})

describe('sanitizeSettingsPatch (M2 whitelist)', () => {
  it('keeps whitelisted booleans, drops unknown keys and non-boolean values', () => {
    const clean = sanitizeSettingsPatch({
      showTrayIcon: false,
      autoLaunch: 'yes',
      trayStrategyMenu: 1,
      bogus: 1,
      __proto__: { admin: true }
    } as unknown as Partial<AppSettings>)
    expect(clean.showTrayIcon).toBe(false)
    expect(clean.autoLaunch).toBeUndefined()
    expect(clean.trayStrategyMenu).toBeUndefined()
    expect((clean as Record<string, unknown>).bogus).toBeUndefined()
  })

  it('validates strategy ids and fake names', () => {
    expect(isValidSettingsStrategyId('general (ALT)')).toBe(true)
    expect(isValidSettingsStrategyId('../evil')).toBe(false)
    expect(isValidSettingsStrategyId('a/b')).toBe(false)
    expect(isValidSettingsStrategyId('')).toBe(false)
    expect(isValidSettingsStrategyId('x'.repeat(129))).toBe(false)

    expect(sanitizeSettingsPatch({ activeStrategyId: 'general (ALT)' }).activeStrategyId).toBe('general (ALT)')
    expect(sanitizeSettingsPatch({ activeStrategyId: null }).activeStrategyId).toBe(null)
    expect(sanitizeSettingsPatch({ activeStrategyId: '../evil' }).activeStrategyId).toBeUndefined()

    expect(sanitizeSettingsPatch({ discordFake: 'tls_clienthello_1' }).discordFake).toBe('tls_clienthello_1')
    expect(sanitizeSettingsPatch({ gameFake: 'bad name!' }).gameFake).toBeUndefined()
    expect(sanitizeSettingsPatch({ gameFake: null }).gameFake).toBe(null)
  })

  it('saveSettings ignores hostile patches and keeps stored values', () => {
    const before = loadSettings()
    const next = saveSettings({
      autoLaunch: 'yes',
      activeStrategyId: '../../evil',
      discordFake: 'bad name!'
    } as unknown as Partial<AppSettings>)
    expect(next.autoLaunch).toBe(before.autoLaunch)
    expect(next.activeStrategyId).toBe(before.activeStrategyId)
    expect(next.discordFake).toBe(before.discordFake)
  })
})
