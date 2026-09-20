/**
 * Linux privilege model.
 *
 * The whole Electron process NEVER runs as root. Instead every privileged
 * operation (`nft`, `nfqws`, `kill`, hosts-file writes) goes through an
 * elevator, preferred in this order:
 *
 * - `sudo` — the ONLY elevator whose auth can truly be HELD: after one
 *   graphical (`sudo -A` + askpass) or terminal grant, a `sudo -v`
 *   keep-alive refreshes the timestamp every ~50s, so the whole app session
 *   stays authorized with zero further dialogs. All spawns use `sudo -n`
 *   and therefore can never pop a surprise prompt.
 * - `pkexec` — graphical polkit prompt, but its retention is polkit-side
 *   (minutes) and cannot be refreshed without prompting again.
 * - `doas` — terminal only, usually without timestamp persistence.
 *
 * Rules that keep the desktop usable:
 * - background polling (tray/status ticks) ALWAYS runs non-interactive
 *   (`sudo -n`, `doas -n`, `pkexec --disable-internal-agent`): it must fail
 *   silently instead of spawning an auth dialog every 15 seconds;
 * - only explicit user actions (banner/tray "grant root", Start/Stop/Apply)
 *   may show a prompt, via {@link ensureRootPrivilege}.
 *
 * Mirrors `elevate.sh` from zapret-discord-youtube-linux (sudo/doas
 * detection + `sudo -v` credential caching), but strictly per-command:
 * there is no `EUID == 0` Electron instance anywhere.
 * @module main/linux-privilege
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isLinux } from './platform'

export type LinuxElevator = 'pkexec' | 'sudo' | 'doas' | 'none'

export interface PrivExecResult {
  stdout: string
  stderr: string
  code: number | null
}

export interface RunPrivilegedOptions {
  /**
   * Allow showing an auth prompt when the auth lapsed. Default true.
   * Background polling MUST pass false — otherwise every status tick pops
   * a polkit dialog once retention expires.
   */
  allowPrompt?: boolean
}

const SUDO_KEEPALIVE_MS = 50_000
/**
 * How long a successful interactive grant (pkexec dialog / doas password)
 * is trusted without re-probing. Needed because neither polkit's cache nor
 * (usually) doas' timestamp can be queried non-interactively — without this
 * the UI would report "no root" right after a successful grant.
 */
const AUTH_HOLD_MS = 5 * 60_000

let elevatorCache: LinuxElevator | null = null
let lastAuthAt = 0
let keepAliveTimer: NodeJS.Timeout | null = null

function commandExists(cmd: string): boolean {
  try {
    fs.accessSync(`/usr/bin/${cmd}`, fs.constants.X_OK)
    return true
  } catch {
    /* fall through to PATH probe */
  }
  try {
    fs.accessSync(`/bin/${cmd}`, fs.constants.X_OK)
    return true
  } catch {
    /* not in fixed locations */
  }
  const path = (process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin').split(':')
  for (const dir of path) {
    try {
      fs.accessSync(`${dir}/${cmd}`, fs.constants.X_OK)
      return true
    } catch {
      /* next */
    }
  }
  return false
}

/** True when this (Electron) process itself runs as root. Must stay false. */
export function isRootProcess(): boolean {
  try {
    return typeof process.geteuid === 'function' && process.geteuid() === 0
  } catch {
    return false
  }
}

/**
 * Pick the elevator for this machine. `sudo` first — it is the only one
 * whose auth can be HELD for the whole session (keep-alive). `pkexec`
 * (graphical polkit prompt) is the fallback, then `doas`.
 * Pure except for filesystem probes — override with `TEST_ELEVATOR`.
 */
export function detectElevator(): LinuxElevator {
  const override = (process.env.TEST_ELEVATOR ?? '').trim().toLowerCase()
  if (override === 'pkexec' || override === 'sudo' || override === 'doas' || override === 'none') {
    return override
  }
  if (isRootProcess()) return 'none'
  if (commandExists('sudo')) return 'sudo'
  if (commandExists('pkexec')) return 'pkexec'
  if (commandExists('doas')) return 'doas'
  return 'none'
}

/** All usable elevators in preference order (for grant fallback). */
export function availableElevators(): LinuxElevator[] {
  const override = (process.env.TEST_ELEVATOR ?? '').trim().toLowerCase()
  if (override === 'pkexec' || override === 'sudo' || override === 'doas' || override === 'none') {
    return override === 'none' ? [] : [override]
  }
  if (isRootProcess()) return []
  const out: LinuxElevator[] = []
  if (commandExists('sudo')) out.push('sudo')
  if (commandExists('pkexec')) out.push('pkexec')
  if (commandExists('doas')) out.push('doas')
  return out
}

export function getElevator(): LinuxElevator {
  if (elevatorCache) return elevatorCache
  elevatorCache = detectElevator()
  return elevatorCache
}

/** Reset cached detection (tests). */
export function resetPrivilegeCache(): void {
  elevatorCache = null
  lastAuthAt = 0
  stopPrivilegeKeepAlive()
}

function runRaw(file: string, args: string[], timeoutMs = 15000): Promise<PrivExecResult> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      resolve({
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        code: error && 'code' in error ? ((error as { code?: number | null }).code ?? 1) : 0
      })
    })
  })
}

/**
 * Non-interactive privilege probe: true when privileged commands work
 * WITHOUT prompting (sudo timestamp / doas nopass / cached pkexec auth).
 */
export async function hasRootPrivilege(): Promise<boolean> {
  // Unit tests run on Windows CI: still exercise the logic via overrides
  // (TEST_PLATFORM=linux / TEST_ELEVATOR=...).
  if (!isLinux() && !process.env.TEST_ELEVATOR && !process.env.TEST_PLATFORM) return false
  if (isRootProcess()) return true
  const elevator = getElevator()
  if (elevator === 'sudo') {
    const r = await runRaw('sudo', ['-n', 'true'], 8000)
    return r.code === 0
  }
  if (elevator === 'doas') {
    // doas rarely persists timestamps (needs `persist` in doas.conf), so a
    // live probe alone would report "no root" between commands — trust a
    // recent interactive grant the same way as pkexec.
    if (Date.now() - lastAuthAt < AUTH_HOLD_MS) return true
    const r = await runRaw('doas', ['-n', 'true'], 8000)
    return r.code === 0
  }
  if (elevator === 'pkexec') {
    if (Date.now() - lastAuthAt < AUTH_HOLD_MS) return true
    return false
  }
  return false
}

/**
 * Build the argv for a privileged invocation (pure — unit-tested).
 * With `allowPrompt: false` every elevator is strictly non-interactive
 * (`sudo -n`, `doas -n`, `pkexec --disable-internal-agent`): a missing auth
 * fails fast instead of popping a dialog — required for background polling.
 */
export function buildElevatedArgv(
  elevator: LinuxElevator,
  file: string,
  args: string[],
  opts?: RunPrivilegedOptions
): string[] {
  const allowPrompt = opts?.allowPrompt !== false
  if (elevator === 'sudo') return ['sudo', '-n', file, ...args]
  if (elevator === 'doas') return ['doas', '-n', file, ...args]
  if (elevator === 'pkexec') return allowPrompt ? ['pkexec', file, ...args] : ['pkexec', '--disable-internal-agent', file, ...args]
  return [file, ...args]
}

/**
 * Run a binary with root rights, capturing output. Background polling must
 * pass `{ allowPrompt: false }`; explicit user actions may keep the default
 * (a lapsed auth re-prompts once, right where the user clicked).
 */
export async function runPrivileged(
  file: string,
  args: string[],
  timeoutMs = 30000,
  opts?: RunPrivilegedOptions
): Promise<PrivExecResult> {
  const elevator = getElevator()
  if (elevator === 'none' || isRootProcess()) {
    return runRaw(file, args, timeoutMs)
  }
  const argv = buildElevatedArgv(elevator, file, args, opts)
  const bin = argv[0] as string
  return runRaw(bin, argv.slice(1), timeoutMs)
}

/**
 * Spawn a long-lived privileged child (foreground `nfqws` test).
 * The elevator wrapper PID is returned — kill it with {@link killPrivileged}.
 */
export function spawnPrivileged(file: string, args: string[], cwd?: string): ChildProcess {
  const elevator = getElevator()
  if (elevator === 'none' || isRootProcess()) {
    return spawn(file, args, { cwd })
  }
  const argv = buildElevatedArgv(elevator, file, args)
  const bin = argv[0] as string
  return spawn(bin, argv.slice(1), { cwd })
}

/** Best-effort privileged kill by PID (`kill -TERM`, then `-KILL`). */
export async function killPrivileged(pid: number, signal = 'TERM'): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return
  const safeSignal = signal === 'KILL' ? 'KILL' : 'TERM'
  await runPrivileged('kill', [`-${safeSignal}`, String(pid)], 8000)
}

/** Resolve a bare tool name to an absolute executable path via PATH. */
function toolPath(name: string): string | null {
  const pathEnv = (process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin').split(':')
  for (const dir of pathEnv) {
    if (!dir) continue
    const p = `${dir}/${name}`
    try {
      fs.accessSync(p, fs.constants.X_OK)
      if (fs.statSync(p).isFile()) return p
    } catch {
      /* next */
    }
  }
  return null
}

/**
 * Write a `SUDO_ASKPASS`-compatible wrapper for GUI prompters that need
 * CLI flags (`zenity`/`kdialog` alone don't speak the askpass protocol:
 * sudo runs the helper with no usable prompt, so bare `zenity` would never
 * ask for a password). Returns the script path or null.
 */
function ensureGuiAskpassWrapper(tool: 'zenity' | 'kdialog', toolAbs: string): string | null {
  const q = toolAbs.replace(/"/g, '')
  const body =
    tool === 'zenity'
      ? `#!/bin/sh\n# Auto-generated by Zapret GUI (sudo askpass wrapper).\nexec "${q}" --password --title "Zapret GUI" --text "Root access required"\n`
      : `#!/bin/sh\n# Auto-generated by Zapret GUI (sudo askpass wrapper).\nexec "${q}" --password "Root access required (Zapret GUI)" --title "Zapret GUI"\n`
  // XDG_RUNTIME_DIR is user-owned, exec-allowed and auto-cleaned; tmpdir is
  // the fallback (may be noexec — then sudo reports a launch failure and the
  // grant chain falls through to pkexec).
  const dirs = [process.env.XDG_RUNTIME_DIR, os.tmpdir()].filter(
    (d): d is string => typeof d === 'string' && d !== ''
  )
  for (const dir of dirs) {
    try {
      const p = path.join(dir, `zapret-gui-askpass-${tool}.sh`)
      fs.writeFileSync(p, body, { mode: 0o700 })
      fs.chmodSync(p, 0o700)
      return p
    } catch {
      /* next dir */
    }
  }
  return null
}

/**
 * Find a usable `SUDO_ASKPASS` helper. Returns an absolute script path:
 * protocol-native ssh-askpass variants directly, `zenity`/`kdialog` via a
 * generated wrapper. Bare program names are NEVER returned — sudo often
 * runs with a restricted `secure_path` and fails to launch them with
 * "No such file or directory" even when they resolve in our own PATH
 * (exactly the failure from the bug report).
 */
export function findAskPass(): string | null {
  for (const p of [
    '/usr/bin/ssh-askpass',
    '/usr/lib/ssh/ssh-askpass',
    '/usr/libexec/openssh/ssh-askpass',
    '/usr/bin/ksshaskpass',
    '/usr/bin/lxqt-openssh-askpass'
  ]) {
    try {
      fs.accessSync(p, fs.constants.X_OK)
      if (fs.statSync(p).isFile()) return p
    } catch {
      /* next */
    }
  }
  for (const name of ['ssh-askpass', 'ksshaskpass']) {
    const p = toolPath(name)
    if (p) return p
  }
  for (const name of ['zenity', 'kdialog'] as const) {
    const p = toolPath(name)
    if (!p) continue
    const wrapped = ensureGuiAskpassWrapper(name, p)
    if (wrapped) return wrapped
  }
  return null
}

function startKeepAlive(elevator: LinuxElevator): void {
  stopPrivilegeKeepAlive()
  if (elevator !== 'sudo') return
  keepAliveTimer = setInterval(() => {
    // Refresh the sudo timestamp so the auth is HELD for the whole session.
    // `-n` guarantees the keep-alive itself can never prompt (it just fails
    // silently when there is nothing to refresh); an expired auth then
    // surfaces as a single re-prompt on the next explicit user action.
    runRaw('sudo', ['-n', '-v'], 10000).catch(() => undefined)
  }, SUDO_KEEPALIVE_MS)
  keepAliveTimer.unref?.()
}

export function stopPrivilegeKeepAlive(): void {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer)
    keepAliveTimer = null
  }
}

/**
 * Explicit user denial (cancelled dialog / wrong password): unlike an
 * environmental failure ("no prompt available") this must NOT cascade into
 * the next elevator — the user said no.
 */
class GrantDenied extends Error {}

/**
 * Ask for root once (graphical prompt) and hold it.
 * Tries elevators in preference order (`sudo` → `pkexec` → `doas`):
 * an environmental failure falls through to the next one, an explicit
 * denial stops the chain immediately.
 * Returns true when privileged commands now work without prompting.
 * Never relaunches Electron — the app keeps running as the user.
 */
export async function ensureRootPrivilege(): Promise<boolean> {
  if (await hasRootPrivilege()) {
    if (getElevator() === 'sudo') startKeepAlive('sudo')
    return true
  }
  const order = availableElevators()
  if (order.length === 0) {
    throw new Error('No privilege helper found (pkexec / sudo / doas). Install polkit or sudo.')
  }
  const unavailable: string[] = []
  for (const elevator of order) {
    try {
      const res = await attemptGrant(elevator)
      if (res.status === 'granted') {
        elevatorCache = elevator
        lastAuthAt = Date.now()
        if (elevator === 'sudo') startKeepAlive(elevator)
        return true
      }
      unavailable.push(`${elevator}: ${res.reason}`)
    } catch (e) {
      if (e instanceof GrantDenied) throw e
      unavailable.push(`${elevator}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  throw new Error(`Root access was not granted (${unavailable.join('; ') || 'no helper available'})`)
}

type GrantAttempt = { status: 'granted' } | { status: 'unavailable'; reason: string }

function deniedErr(stderr: string): GrantDenied {
  const tail = stderr.trim().slice(0, 200)
  return new GrantDenied(`Root access was not granted${tail ? `: ${tail}` : ''}`)
}

/**
 * True when sudo failed to even RUN the askpass helper (missing binary,
 * secure_path lookup failure, noexec mount, no display) as opposed to the
 * user cancelling / mistyping the password. The former must fall through to
 * the next elevator (pkexec); the latter must stop the chain — popping a
 * second dialog right after a cancel is hostile.
 */
export function isAskpassEnvFailure(stderr: string): boolean {
  return /unable to run|cannot run|failed to run|failed to execute|не уда[её]тся запустить|no such file|нет такого файла|command not found|команда не найдена|permission denied|отказано в доступе|cannot open display|no display|не уда[её]тся открыть (?:дисплей|экран)|no askpass program|gtk[-\s]?warning.*display|wayland.*display/i.test(
    stderr
  )
}

async function attemptGrant(elevator: LinuxElevator): Promise<GrantAttempt> {
  if (elevator === 'sudo') {
    // Already authorized (NOPASSWD / live timestamp): no dialog at all.
    if ((await runRaw('sudo', ['-n', 'true'], 8000)).code === 0) return { status: 'granted' }
    const askpass = findAskPass()
    if (askpass) {
      const r = await new Promise<PrivExecResult>((resolve) => {
        execFile('sudo', ['-A', '-v'], { timeout: 120000, env: { ...process.env, SUDO_ASKPASS: askpass } }, (error, stdout, stderr) => {
          resolve({
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            code: error && 'code' in error ? ((error as { code?: number | null }).code ?? 1) : 0
          })
        })
      })
      if (r.code === 0) return { status: 'granted' }
      // Helper couldn't be launched (or no display): environmental — let
      // pkexec try its polkit dialog instead of failing outright.
      if (isAskpassEnvFailure(r.stderr)) {
        return { status: 'unavailable', reason: `sudo askpass failed (${r.stderr.trim().slice(0, 120) || `exit ${r.code}`})` }
      }
      // The dialog ran and auth failed (cancel / wrong password): explicit
      // denial, don't cascade into another prompt.
      throw deniedErr(r.stderr)
    }
    if (process.stdin.isTTY) {
      // Developer running from a terminal: let sudo ask there.
      const r = await runRaw('sudo', ['-v'], 120000)
      if (r.code === 0) return { status: 'granted' }
      throw deniedErr(r.stderr)
    }
    return { status: 'unavailable', reason: 'sudo needs a graphical prompt but no askpass helper was found' }
  }
  if (elevator === 'pkexec') {
    // Graphical polkit dialog. `--disable-internal-agent` is NOT set on
    // purpose: without an agent there is no prompt at all.
    const r = await runRaw('pkexec', ['true'], 120000)
    if (r.code === 0) return { status: 'granted' }
    // Cancel and missing-agent look alike here — report it and let the
    // chain try the rest (doas fails fast without a TTY).
    return { status: 'unavailable', reason: `pkexec auth failed${r.stderr.trim() ? `: ${r.stderr.trim().slice(0, 120)}` : ''}` }
  }
  if (elevator === 'doas') {
    if ((await runRaw('doas', ['-n', 'true'], 8000)).code === 0) return { status: 'granted' }
    if (!process.stdin.isTTY) {
      return { status: 'unavailable', reason: 'doas needs a terminal to ask for the password' }
    }
    const r = await runRaw('doas', ['true'], 60000)
    if (r.code === 0) return { status: 'granted' }
    throw deniedErr(r.stderr)
  }
  return { status: 'unavailable', reason: 'unknown elevator' }
}

/** Drop the held auth (best-effort): `sudo -k` + cache reset. */
export async function dropRootPrivilege(): Promise<void> {
  stopPrivilegeKeepAlive()
  lastAuthAt = 0
  try {
    if (commandExists('sudo')) await runRaw('sudo', ['-k'], 8000)
  } catch {
    /* best-effort */
  }
}
