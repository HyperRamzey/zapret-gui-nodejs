/**
 * Linux-only maintenance helpers (no admin rights needed).
 * Discord on Linux keeps caches under XDG config dirs — clear them the same
 * way the Windows variant clears %APPDATA% caches.
 * @module main/linux-maintenance
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { translate, type Locale } from '../shared/i18n'

function homeDir(): string {
  return process.env.HOME ?? os.homedir() ?? ''
}

function candidateDirs(home: string): string[] {
  return [
    path.join(home, '.config', 'discord'),
    path.join(home, '.config', 'discordptb'),
    path.join(home, '.config', 'discordcanary'),
    path.join(home, '.config', 'discorddevelopment'),
    path.join(home, 'snap', 'discord', 'common', '.config', 'discord')
  ]
}

async function isProcRunning(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('pgrep', ['-f', name], { timeout: 8000 }, (error, stdout) => {
      if (error) {
        resolve(false)
        return
      }
      resolve(String(stdout ?? '').trim() !== '')
    })
  })
}

async function killProc(name: string): Promise<void> {
  await new Promise<void>((resolve) => {
    execFile('pkill', ['-f', name], { timeout: 8000 }, () => resolve())
  })
}

/** Clear Discord caches on Linux. Returns human log lines. */
export async function clearDiscordCacheLinux(onLog?: (text: string) => void, locale: Locale = 'en'): Promise<string[]> {
  const lines: string[] = []
  const home = homeDir()
  if (!home) {
    const msg = translate(locale, 'tool.cacheNoAppData')
    onLog?.(msg)
    return [msg]
  }
  let found = false
  for (const dir of candidateDirs(home)) {
    if (!fs.existsSync(dir)) continue
    found = true
    const base = path.basename(dir)
    const procs = base === 'discord' ? ['Discord', 'discord'] : [base, 'Discord']
    for (const p of procs) {
      if (await isProcRunning(p)) {
        await killProc(p)
        lines.push(translate(locale, 'tool.cacheClosed').replace('{dir}', base))
        break
      }
    }
    for (const sub of ['Cache', 'Code Cache', 'GPUCache', 'CacheStorage', 'Service Worker']) {
      const p = path.join(dir, sub)
      if (fs.existsSync(p)) {
        try {
          fs.rmSync(p, { recursive: true, force: true })
          lines.push(translate(locale, 'tool.cacheCleared').replace('{dir}', base).replace('{sub}', sub))
        } catch (e) {
          lines.push(
            translate(locale, 'tool.cacheFailed')
              .replace('{dir}', base)
              .replace('{sub}', sub)
              .replace('{error}', String(e).slice(0, 120))
          )
        }
      }
    }
  }
  if (!found) lines.push(translate(locale, 'tool.cacheNotFound'))
  for (const l of lines) onLog?.(l)
  return lines
}
