/**
 * Process execution helpers: plain exec, admin detection and UAC elevation.
 *
 * Windows strategy: the app asks to run elevated once (button "relaunch as admin").
 * Service/hosts operations then run directly.
 *
 * Linux strategy: Electron NEVER runs as root. Privileged work goes through
 * `linux-privilege` (pkexec/sudo per-command + `sudo -v` keep-alive), so the
 * userspace app merely *holds* root auth without ever being root itself.
 * @module main/exec
 */
import { spawn, execFile } from 'node:child_process'
import { isLinux } from './platform'

export interface ExecResult {
  stdout: string
  stderr: string
  code: number | null
}

/** Run a binary and capture output. Never rejects — always resolves. */
export function run(file: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    // windowsVerbatimArguments is REQUIRED: without it Node backslash-escapes
    // embedded double quotes (`"..."` -> `\"...\"`), which cmd.exe does not
    // understand. Every command with inner quotes (tasklist /FI "...",
    // reg query "HKLM\\...", sc create binPath= "...") silently broke —
    // e.g. tasklist failed with "invalid filter" and winws.exe was never seen.
    execFile(
      file,
      args,
      { windowsHide: true, windowsVerbatimArguments: true, cwd: opts.cwd, timeout: opts.timeoutMs ?? 30000 },
      (error, stdout, stderr) => {
        resolve({
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          code: error && 'code' in error ? ((error as { code?: number | null }).code ?? 1) : 0
        })
      }
    )
  })
}

/** `cmd.exe /c <command>` wrapper (needed for sc/net/tasklist pipelines). */
export function runCmd(command: string, timeoutMs = 30000): Promise<ExecResult> {
  // cmd.exe emits text in the OEM codepage (CP866 on Russian Windows) while
  // Node decodes it as UTF-8 → Cyrillic turns into mojibake in surfaced
  // errors. Switching this (per-process) session to UTF-8 fixes decoding;
  // parsing only relies on ASCII keywords/digits, so nothing else changes.
  return run('cmd.exe', ['/d', '/s', '/c', `chcp 65001 >nul & ${command}`], { timeoutMs })
}

/** PowerShell `-NoProfile -Command ...` wrapper. */
export function runPowershell(script: string, timeoutMs = 30000): Promise<ExecResult> {
  // Same OEM-decoding problem as cmd (e.g. Cyrillic paths from
  // Get-Process/registry): force UTF-8 console output for this session.
  // `new($false)` = no BOM preamble, and every caller trims anyway.
  const utf8 = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); '
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `${utf8}${script}`], { timeoutMs })
}

/** POSIX `sh -c <command>` wrapper (Linux pipelines, pgrep, ip, ...). */
export function runSh(command: string, timeoutMs = 30000): Promise<ExecResult> {
  return run('sh', ['-c', command], { timeoutMs })
}

/** True when the current process runs elevated (admin / root-held). */
export async function isAdmin(): Promise<boolean> {
  if (isLinux()) {
    // On Linux "admin" means "we currently hold usable root via the
    // privilege helper" — Electron itself is never root (see linux-privilege).
    try {
      const { hasRootPrivilege } = await import('./linux-privilege')
      return await hasRootPrivilege()
    } catch {
      return false
    }
  }
  // `net session` succeeds only for admins.
  const r = await runCmd('net session >nul 2>&1')
  return r.code === 0
}

/** Relaunch the whole Electron app elevated (used by the dashboard button). */
export async function relaunchAppAsAdmin(appPath: string, appArgs: string[]): Promise<boolean> {
  if (isLinux()) {
    // Linux never relaunches Electron as root: the userspace app holds root
    // through the privilege helper instead (see linux-privilege).
    throw new Error('Not supported on Linux: grant root access instead — the app never runs as root.')
  }
  const esc = (s: string): string => s.replace(/'/g, "''")
  // Filter out Electron's own argv[0] (exe path) if the caller passed
  // process.argv.slice(1) from a packaged app — passing the exe as an
  // argument breaks the elevated launch and leaves no running instance.
  const filtered = appArgs.filter((a) => a !== appPath)
  const argsPs =
    filtered.length > 0 ? ` -ArgumentList ${filtered.map((a) => `'${esc(a)}'`).join(',')}` : ''
  // NOTE: powershell.exe exits with code 0 even when Start-Process throws
  // (e.g. the user presses "No" on the UAC prompt). Without an explicit
  // try/catch + exit code every denial looked like success: the caller
  // quit the current instance while no elevated copy was starting —
  // the app "just closed". Force a non-zero exit on any failure.
  const ps =
    `$ErrorActionPreference='Stop'; ` +
    `try { Start-Process -FilePath '${esc(appPath)}'${argsPs} -Verb RunAs; exit 0 } ` +
    `catch { Write-Host $_.Exception.Message; exit 1 }`
  const r = await runPowershell(ps, 60000)
  return r.code === 0
}

/** Spawn a long-lived child (foreground winws test / test script). */
export function spawnLong(file: string, args: string[], cwd?: string) {
  return spawn(file, args, { windowsHide: false, cwd })
}

/**
 * Force-kill a process tree by PID (`taskkill /PID x /F /T` on Windows,
 * `kill -KILL` on POSIX).
 * `ChildProcess.kill()` is routinely ignored by winws.exe on Windows, so a
 * PID-targeted taskkill is the reliable fallback. Unlike `/IM <image>` it
 * never touches foreign processes with the same image name.
 * Best-effort: never throws.
 */
export async function killPidTree(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return
  if (isLinux()) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* already dead */
    }
    await new Promise((r) => setTimeout(r, 500))
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already dead */
    }
    return
  }
  try {
    await runCmd(`taskkill /PID ${pid} /F /T >nul 2>&1`, 8000)
  } catch {
    /* already dead */
  }
}
