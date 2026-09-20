/** Linux XDG autostart entry + hidden-start detection. */
import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import {
  LINUX_AUTOSTART_FILE,
  applyLinuxAutoLaunch,
  buildLinuxAutostartContent,
  getLinuxAutostartFilePath,
  isLinuxAutoLaunchEnabled,
  quoteDesktopExec,
  shouldStartMinimized
} from '../src/main/linux-autostart'

afterEach(() => {
  delete process.env.TEST_PLATFORM
  vi.unstubAllEnvs?.()
})

describe('quoteDesktopExec', () => {
  it('leaves plain paths untouched', () => {
    expect(quoteDesktopExec('/opt/zapret-gui/zapret-gui')).toBe('/opt/zapret-gui/zapret-gui')
  })

  it('quotes paths with spaces (deb default /opt/Zapret GUI/...)', () => {
    expect(quoteDesktopExec('/opt/Zapret GUI/zapret-gui')).toBe('"/opt/Zapret GUI/zapret-gui"')
  })

  it('keeps an already-quoted path as is', () => {
    expect(quoteDesktopExec('"/opt/Zapret GUI/zapret-gui"')).toBe('"/opt/Zapret GUI/zapret-gui"')
  })
})

describe('buildLinuxAutostartContent', () => {
  it('emits a valid desktop entry without --hidden by default', () => {
    const content = buildLinuxAutostartContent('/opt/Zapret GUI/zapret-gui', false)
    expect(content).toContain('[Desktop Entry]')
    expect(content).toContain('Type=Application')
    expect(content).toContain('X-GNOME-Autostart-enabled=true')
    expect(content).toContain('Exec="/opt/Zapret GUI/zapret-gui" %U')
    expect(content).not.toContain('--hidden')
  })

  it('passes the app path along in dev (bare Electron exe)', () => {
    const content = buildLinuxAutostartContent('/tmp/electron', true, ['/home/user/zapret-gui-nodejs'])
    expect(content).toContain('Exec=/tmp/electron /home/user/zapret-gui-nodejs --hidden %U')
  })

  it('appends --hidden when start-minimized is on', () => {
    const content = buildLinuxAutostartContent('/opt/Zapret GUI/zapret-gui', true)
    expect(content).toContain('Exec="/opt/Zapret GUI/zapret-gui" --hidden %U')
  })
})

describe('shouldStartMinimized', () => {
  it('is false for a normal launch without the setting', () => {
    expect(shouldStartMinimized(['/opt/zapret-gui/zapret-gui'], false)).toBe(false)
  })

  it('is true when the persisted setting is on (any argv)', () => {
    expect(shouldStartMinimized([], true)).toBe(true)
    expect(shouldStartMinimized(['--hidden'], true)).toBe(true)
  })

  it('detects the autostart --hidden flag', () => {
    expect(shouldStartMinimized(['app', '--hidden'], false)).toBe(true)
  })

  it('is case-insensitive and knows aliases', () => {
    expect(shouldStartMinimized(['--HIDDEN'], false)).toBe(true)
    expect(shouldStartMinimized(['--minimized'], false)).toBe(true)
    expect(shouldStartMinimized(['--start-minimized'], false)).toBe(true)
  })

  it('ignores unrelated args (incl. %U from the DE)', () => {
    expect(shouldStartMinimized(['%U', '--other'], false)).toBe(false)
  })
})

describe('applyLinuxAutoLaunch (isolated home)', () => {
  it('writes, rewrites --hidden, and removes the entry', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zapret-autostart-'))
    const file = path.join(home, '.config', 'autostart', LINUX_AUTOSTART_FILE)
    expect(getLinuxAutostartFilePath(home)).toBe(file)

    expect(isLinuxAutoLaunchEnabled({ homeDir: home })).toBe(false)

    const created = applyLinuxAutoLaunch(true, false, {
      homeDir: home,
      exePath: '/opt/Zapret GUI/zapret-gui',
      packaged: true
    })
    expect(created.ok).toBe(true)
    expect(fs.existsSync(file)).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toContain('Exec="/opt/Zapret GUI/zapret-gui" %U')
    expect(isLinuxAutoLaunchEnabled({ homeDir: home })).toBe(true)

    // Toggling only "start minimized" must refresh the Exec line.
    applyLinuxAutoLaunch(true, true, { homeDir: home, exePath: '/opt/Zapret GUI/zapret-gui', packaged: true })
    expect(fs.readFileSync(file, 'utf8')).toContain('--hidden')

    const removed = applyLinuxAutoLaunch(false, false, { homeDir: home })
    expect(removed.ok).toBe(true)
    expect(fs.existsSync(file)).toBe(false)
    expect(isLinuxAutoLaunchEnabled({ homeDir: home })).toBe(false)

    // Removing a missing entry is still OK.
    expect(applyLinuxAutoLaunch(false, false, { homeDir: home }).ok).toBe(true)
  })
})

describe('settings → Linux autostart wiring', () => {
  it('saveSettings creates/removes the XDG entry on linux, setLoginItemSettings elsewhere', async () => {
    // Import late so TEST_PLATFORM/HOME are already set for module reads.
    const settingsHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zapret-settings-linux-'))
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zapret-home-linux-'))
    const prevHome = process.env.HOME
    process.env.HOME = fakeHome
    process.env.TEST_PLATFORM = 'linux'
    vi.spyOn(app, 'getPath').mockImplementation((name: string) => {
      if (name === 'exe') return '/opt/Zapret GUI/zapret-gui'
      return settingsHome
    })
    const setLoginSpy = vi.spyOn(app, 'setLoginItemSettings').mockImplementation(() => undefined)
    try {
      const { saveSettings } = await import('../src/main/settings')
      const entry = getLinuxAutostartFilePath()

      saveSettings({ autoLaunch: true, startMinimizedToTray: false })
      expect(fs.existsSync(entry)).toBe(true)
      expect(fs.readFileSync(entry, 'utf8')).not.toContain('--hidden')
      // Electron's API is a no-op on Linux — must not be used there.
      expect(setLoginSpy).not.toHaveBeenCalled()

      saveSettings({ startMinimizedToTray: true })
      expect(fs.readFileSync(entry, 'utf8')).toContain('--hidden')

      saveSettings({ autoLaunch: false })
      expect(fs.existsSync(entry)).toBe(false)

      // Windows still goes through Electron login-item settings.
      process.env.TEST_PLATFORM = 'win32'
      saveSettings({ autoLaunch: true })
      expect(setLoginSpy).toHaveBeenCalledWith({ openAtLogin: true, name: 'Zapret GUI' })
      saveSettings({ autoLaunch: false })
    } finally {
      delete process.env.TEST_PLATFORM
      if (prevHome === undefined) delete process.env.HOME
      else process.env.HOME = prevHome
      vi.restoreAllMocks()
    }
  })
})
