/**
 * Linux login autostart + minimized-start handling.
 *
 * Electron's `app.setLoginItemSettings()` is macOS/Windows-only — on Linux
 * it is a silent no-op, so the "Автозапуск при входе в систему" toggle did
 * nothing there. The freedesktop way is an XDG Autostart `.desktop` file in
 * `~/.config/autostart/`, which every major DE (GNOME, KDE, Xfce, Cinnamon,
 * MATE) honors at login.
 *
 * The autostart entry mirrors the installed desktop file
 * (`/usr/share/applications/com.zapret.gui.desktop` from the .deb/.rpm)
 * and appends `--hidden` when "Запускаться свёрнутым в трей" is on, so the
 * app starts hidden even if `settings.json` was reset in between. The main
 * process treats `--hidden` (plus `--minimized` / `--start-minimized`
 * aliases) as "start in tray", exactly like the persisted setting.
 * @module main/linux-autostart
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'

/** Autostart file name — same desktop id as the installed package file. */
export const LINUX_AUTOSTART_FILE = 'com.zapret.gui.desktop'

/** CLI flags meaning "start hidden in tray" (pure — unit-tested). */
export const HIDDEN_LAUNCH_ARGS = ['--hidden', '--minimized', '--start-minimized'] as const

/**
 * Directory holding XDG Autostart entries. `homeDir` override exists for
 * unit tests (`os.homedir()` reads `$HOME` on POSIX, which tests redirect).
 */
export function getLinuxAutostartDir(homeDir?: string): string {
  return path.join(homeDir ?? os.homedir(), '.config', 'autostart')
}

/** Full path of our XDG Autostart entry. */
export function getLinuxAutostartFilePath(homeDir?: string): string {
  return path.join(getLinuxAutostartDir(homeDir), LINUX_AUTOSTART_FILE)
}

/** Quote an executable path for an `Exec=` line (handles `/opt/Zapret GUI/...`). Pure. */
export function quoteDesktopExec(exePath: string): string {
  const clean = exePath.trim()
  if (clean.startsWith('"') && clean.endsWith('"')) return clean
  if (/[\s\\$"`]/.test(clean)) return `"${clean.replace(/"/g, '\\"')}"`
  return clean
}

/**
 * Build the `.desktop` file content for the autostart entry. Pure.
 * `%U` is kept so a file/URL argument from the DE does not break parsing;
 * the app simply ignores extra args.
 */
export function buildLinuxAutostartContent(
  exePath: string,
  startMinimized: boolean,
  extraArgs: readonly string[] = []
): string {
  const parts = [quoteDesktopExec(exePath), ...extraArgs.map(quoteDesktopExec)]
  if (startMinimized) parts.push('--hidden')
  parts.push('%U')
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Zapret GUI',
    'Comment=Desktop GUI for zapret DPI bypass (nfqws + nftables)',
    `Exec=${parts.join(' ')}`,
    'Icon=zapret-gui',
    'Terminal=false',
    'Categories=Network;',
    'StartupWMClass=com.zapret.gui',
    'X-GNOME-Autostart-enabled=true',
    'Hidden=false',
    ''
  ].join('\n')
}

/**
 * Whether the app should start hidden in tray: explicit hidden CLI flag
 * (used by the autostart entry) OR the persisted setting. Pure.
 */
export function shouldStartMinimized(argv: readonly string[], startMinimizedSetting: boolean): boolean {
  if (startMinimizedSetting) return true
  const lower = new Set(argv.map((a) => a.trim().toLowerCase()))
  return (HIDDEN_LAUNCH_ARGS as readonly string[]).some((flag) => lower.has(flag))
}

export interface LinuxAutoLaunchOptions {
  /** Override for tests (defaults to `os.homedir()`). */
  homeDir?: string
  /** Override for tests (defaults to the running executable). */
  exePath?: string
  /**
   * Extra argv for the `Exec=` line (defaults to `[appPath]` in dev, where
   * the exe is the bare Electron binary and cannot find the app by itself).
   */
  extraArgs?: string[]
  /** Override for tests (defaults to `app.isPackaged`). */
  packaged?: boolean
}

/** `true` when our XDG Autostart entry exists. Never throws. */
export function isLinuxAutoLaunchEnabled(opts: LinuxAutoLaunchOptions = {}): boolean {
  try {
    return fs.existsSync(getLinuxAutostartFilePath(opts.homeDir))
  } catch {
    return false
  }
}

export interface LinuxAutoLaunchResult {
  ok: boolean
  /** Absolute path of the entry that was written/removed. */
  file: string
  error?: string
}

/**
 * Create or remove the XDG Autostart entry. Never throws (returns `ok`).
 * Rewriting the file on every toggle also keeps the `--hidden` flag in
 * sync when only "start minimized" changed.
 */
export function applyLinuxAutoLaunch(
  enabled: boolean,
  startMinimized: boolean,
  opts: LinuxAutoLaunchOptions = {}
): LinuxAutoLaunchResult {
  const file = getLinuxAutostartFilePath(opts.homeDir)
  if (!enabled) {
    try {
      fs.rmSync(file, { force: true })
    } catch (e) {
      return { ok: false, file, error: e instanceof Error ? e.message : String(e) }
    }
    return { ok: true, file }
  }
  let exe = opts.exePath
  if (!exe) {
    try {
      const exePath = app.getPath('exe')
      if (typeof exePath === 'string' && exePath.length > 0) exe = exePath
    } catch {
      /* fall back to process.execPath */
    }
    exe ??= process.execPath
  }
  let extraArgs = opts.extraArgs
  if (!extraArgs) {
    let packaged = opts.packaged
    if (packaged === undefined) {
      try {
        packaged = app.isPackaged
      } catch {
        packaged = false
      }
    }
    if (!packaged) {
      try {
        const appPath = app.getAppPath()
        if (typeof appPath === 'string' && appPath.length > 0) extraArgs = [appPath]
        else extraArgs = []
      } catch {
        extraArgs = []
      }
    } else {
      extraArgs = []
    }
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, buildLinuxAutostartContent(exe, startMinimized, extraArgs), 'utf8')
  } catch (e) {
    return { ok: false, file, error: e instanceof Error ? e.message : String(e) }
  }
  return { ok: true, file }
}
