/**
 * Linux backend: `nfqws` + `nftables` (only).
 *
 * Port of the relevant parts of zapret-discord-youtube-linux
 * (`src/lib/common.sh` + `src/firewall-backends/00-nftables.sh`):
 * - `--wf-tcp/--wf-udp` values from the (shared, Windows-origin) strategy
 *   become nft `dport` sets;
 * - everything else (`--filter-*` + desync options) is passed to `nfqws`;
 * - rules live in table `inet zapret` (chains `post`/`pre`), queue 220,
 *   fwmark 0x40000000 — same names as the reference project so a manual
 *   `service.sh` install is taken over cleanly instead of duplicated.
 *
 * All privileged operations go through `linux-privilege` (pkexec/sudo):
 * Electron itself never runs as root.
 * @module main/linux-service
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { materializeArgs } from './strategy-parser'
import { resolveGameFilterPorts, ensureListFilesExist } from './service-manager'
import { runPrivileged, ensureRootPrivilege } from './linux-privilege'
import type { ServiceOwnership, ServiceState, StatusSnapshot, Strategy } from '../shared/types'

/** nftables identity — identical to the reference project. */
export const NFT_FAMILY = 'inet'
export const NFT_TABLE = 'zapret'
export const NFT_CHAIN = 'post'
export const NFT_CHAIN_PRE = 'pre'
export const NFT_QUEUE_NUM = 220
export const NFT_MARK = '0x40000000'
export const NFT_RULE_COMMENT = 'Added by zapret-gui'
export const NFQWS_BIN = 'nfqws'

export const LINUX_ACTIVE_STRATEGY_FILE = 'linux-active-strategy.txt'
export const LINUX_SERVICE_STATE_FILE = 'linux-service.json'
export const LINUX_INTERFACE_FILE = 'linux-interface.txt'

/**
 * Strict `pgrep -f` / `pkill -f` pattern for the engine: the binary name as
 * a path segment (`/usr/.../bin/nfqws` or bare `nfqws`), followed by a space
 * or end of line. A bare `nfqws` substring also matches `vim nfqws-notes`,
 * `man nfqws`, `grep nfqws` etc. — random user processes that must never
 * light up the dashboard or get killed.
 */
export const NFQWS_MATCH_PATTERN = '(^|/)nfqws( |$)'

export interface LinuxServiceState {
  strategyId: string
  strategyName: string
  interface: string
  tcpPorts: string
  udpPorts: string
  nfqwsArgs: string[]
  updatedAt: string
}

/**
 * Build `--user=<desktop user>` so the nfqws daemon drops root to the
 * invoking user instead of upstream-default `nobody`.
 *
 * Why: after opening NFQUEUE as root, nfqws drops privileges and RE-OPENS
 * every list/fake file (`file_open_test`). Our lists live under
 * `~/.config/zapret-gui/...`, and a typical Fedora `$HOME` is `drwx------`
 * — `nobody` cannot even traverse into it, so startup dies with
 * `Permission denied / cannot access hostlist file` even though root had
 * just loaded the very same files. The app itself always runs as this
 * user (it refuses to start as root), so dropping to it guarantees access
 * with normal permissions — no world-readable staging, no `$HOME` chmod.
 *
 * Returns [] when the username is unavailable/invalid (caller proceeds
 * without the flag = upstream `nobody` behavior).
 * The override param exists for unit tests.
 */
export function linuxDropUserArgs(overrideUsername?: string): string[] {
  let name = overrideUsername ?? ''
  if (!name) {
    try {
      name = os.userInfo().username ?? ''
    } catch {
      return []
    }
  }
  const clean = String(name).trim().slice(0, 32)
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(clean) || clean.toLowerCase() === 'root') return []
  return [`--user=${clean}`]
}

/**
 * Build foreground-tester argv for Linux from materialized strategy args:
 * parse the `--wf-*` port sets (the caller builds nftables rules from them),
 * strip them (Windows-only), and prepend the queue/user plumbing.
 * Returns ports + final args, or an error when no ports are found.
 * Pure except the username lookup — covered by unit tests.
 */
export function buildLinuxTesterArgs(
  rawArgs: string[]
):
  | { ok: true; tcp: string; udp: string; args: string[] }
  | { ok: false; error: string } {
  const { tcp, udp } = parseWfPorts(rawArgs)
  if (!tcp && !udp) {
    return { ok: false, error: 'no --wf-tcp/--wf-udp ports — cannot build nftables rules' }
  }
  return {
    ok: true,
    tcp,
    udp,
    args: [
      `--dpi-desync-fwmark=${NFT_MARK}`,
      `--qnum=${NFT_QUEUE_NUM}`,
      ...linuxDropUserArgs(),
      ...stripWfArgs(rawArgs).map((a) => a.replace(/"/g, ''))
    ]
  }
}

/** Sanitize an interface name for use in nft/pkill argv. */
export function sanitizeInterface(iface: string): string {
  const s = String(iface ?? '').trim().slice(0, 32)
  if (s === '' || s.toLowerCase() === 'any') return 'any'
  if (!/^[A-Za-z0-9_.:-]+$/.test(s)) throw new Error(`Invalid network interface: ${s.slice(0, 32)}`)
  return s
}

/**
 * Extract `--wf-tcp=` / `--wf-udp=` port sets from materialized strategy args.
 * Pure — covered by unit tests.
 */
export function parseWfPorts(args: string[]): { tcp: string; udp: string } {
  let tcp = ''
  let udp = ''
  for (const raw of args) {
    const a = String(raw).trim().replace(/^"|"$/g, '')
    const mTcp = a.match(/^--wf-tcp=(.*)$/i)
    if (mTcp) tcp = (mTcp[1] ?? '').replace(/^"|"$/g, '').trim()
    const mUdp = a.match(/^--wf-udp=(.*)$/i)
    if (mUdp) udp = (mUdp[1] ?? '').replace(/^"|"$/g, '').trim()
  }
  return { tcp, udp }
}

/**
 * Strip Windows-only `--wf-*` tokens: Linux `nfqws` reads packets from
 * NFQUEUE (nft rules below) and rejects unknown `--wf-*` options.
 * Pure — covered by unit tests.
 */
export function stripWfArgs(args: string[]): string[] {
  return args.filter((a) => {
    const t = String(a).trim().replace(/^"|"$/g, '')
    return !/^--wf-(tcp|udp)=/i.test(t)
  })
}

/**
 * Build one nft `dport` set element: `80,443` → `{80,443}`.
 * Pure — covered by unit tests.
 */
export function nftPortSet(ports: string): string | null {
  const p = String(ports ?? '').trim().replace(/[{}\s]/g, '')
  if (p === '') return null
  if (!/^[0-9,\-:]+$/.test(p)) throw new Error(`Invalid port set: ${ports.slice(0, 120)}`)
  return `{${p}}`
}

/**
 * Build the full `nft` invocation list for setup (argv arrays, no shell).
 * Mirrors `backend_setup` in `00-nftables.sh`. Pure — covered by unit tests.
 */
export function buildNftSetupCommands(tcpPorts: string, udpPorts: string, iface: string): string[][] {
  const table = `${NFT_FAMILY} ${NFT_TABLE}`
  const cmds: string[][] = [
    ['nft', 'add', 'table', NFT_FAMILY, NFT_TABLE],
    ['nft', 'add', 'chain', NFT_FAMILY, NFT_TABLE, NFT_CHAIN, '{', 'type', 'filter', 'hook', 'postrouting', 'priority', 'mangle;', '}'],
    ['nft', 'add', 'chain', NFT_FAMILY, NFT_TABLE, NFT_CHAIN_PRE, '{', 'type', 'filter', 'hook', 'prerouting', 'priority', 'filter;', '}']
  ]
  const cleanIface = sanitizeInterface(iface)
  const useIface = cleanIface !== 'any'
  const tcpSet = nftPortSet(tcpPorts)
  const udpSet = nftPortSet(udpPorts)

  if (tcpSet) {
    const rule = ['nft', 'add', 'rule', NFT_FAMILY, NFT_TABLE, NFT_CHAIN]
    if (useIface) rule.push('oifname', cleanIface)
    rule.push('meta', 'mark', 'and', NFT_MARK, '==', '0', 'tcp', 'dport', tcpSet, 'ct', 'original', 'packets', '1-6', 'queue', 'num', String(NFT_QUEUE_NUM), 'bypass', 'comment', `"${NFT_RULE_COMMENT}"`)
    cmds.push(rule)
  }
  if (udpSet) {
    const rule = ['nft', 'add', 'rule', NFT_FAMILY, NFT_TABLE, NFT_CHAIN]
    if (useIface) rule.push('oifname', cleanIface)
    rule.push('meta', 'mark', 'and', NFT_MARK, '==', '0', 'udp', 'dport', udpSet, 'ct', 'original', 'packets', '1-6', 'queue', 'num', String(NFT_QUEUE_NUM), 'bypass', 'comment', `"${NFT_RULE_COMMENT}"`)
    cmds.push(rule)
  }
  // Upstream only installs the reply path for TCP (see 00-nftables.sh).
  if (tcpSet) {
    const rule = ['nft', 'add', 'rule', NFT_FAMILY, NFT_TABLE, NFT_CHAIN_PRE]
    if (useIface) rule.push('iifname', cleanIface)
    rule.push('tcp', 'sport', tcpSet, 'ct', 'reply', 'packets', '1-3', 'queue', 'num', String(NFT_QUEUE_NUM), 'bypass', 'comment', `"${NFT_RULE_COMMENT}"`)
    cmds.push(rule)
  }
  void table
  return cmds
}

/** Commands that fully remove our table (best-effort, order matters). */
export function buildNftClearCommands(): string[][] {
  return [
    ['nft', 'flush', 'chain', NFT_FAMILY, NFT_TABLE, NFT_CHAIN],
    ['nft', 'delete', 'chain', NFT_FAMILY, NFT_TABLE, NFT_CHAIN],
    ['nft', 'flush', 'chain', NFT_FAMILY, NFT_TABLE, NFT_CHAIN_PRE],
    ['nft', 'delete', 'chain', NFT_FAMILY, NFT_TABLE, NFT_CHAIN_PRE],
    ['nft', 'delete', 'table', NFT_FAMILY, NFT_TABLE]
  ]
}

/**
 * Decide Linux service ownership from the running nfqws command line:
 * contains our bin dir → ours, running but foreign path → foreign.
 * Pure — covered by unit tests.
 */
export function detectLinuxOwnership(nfqwsRunning: boolean, cmdline: string, ownBinDir: string): ServiceOwnership {
  if (!nfqwsRunning) {
    return cmdline.trim() === '' ? 'none' : 'unknown'
  }
  if (!cmdline || cmdline.trim() === '') return 'unknown'
  const own = ownBinDir.trim().toLowerCase()
  if (!own) return 'unknown'
  return cmdline.toLowerCase().includes(own) ? 'ours' : 'foreign'
}

function runRawCapture(file: string, args: string[], timeoutMs = 10000): Promise<{ stdout: string; stderr: string; code: number | null }> {
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

/** Resolve the nfqws binary: data/bin first, then system PATH. */
export function resolveNfqwsPath(dataDir: string): string {
  const local = path.join(dataDir, 'bin', NFQWS_BIN)
  try {
    fs.accessSync(local, fs.constants.X_OK)
    return local
  } catch {
    /* not yet downloaded — try PATH */
  }
  return NFQWS_BIN
}

export function getLinuxInterface(dataDir: string): string {
  try {
    const raw = fs.readFileSync(path.join(dataDir, LINUX_INTERFACE_FILE), 'utf8').trim()
    if (raw) return sanitizeInterface(raw)
  } catch {
    /* default below */
  }
  return 'any'
}

export function setLinuxInterface(dataDir: string, iface: string): string {
  const clean = sanitizeInterface(iface)
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(path.join(dataDir, LINUX_INTERFACE_FILE), `${clean}\n`, 'utf8')
  return clean
}

/** All local interfaces plus the `any` pseudo-interface. */
export async function listNetworkInterfaces(): Promise<string[]> {
  try {
    const entries = fs.readdirSync('/sys/class/net')
    const list = entries.filter((n) => /^[A-Za-z0-9_.:-]+$/.test(n)).sort()
    return ['any', ...list.filter((n) => n !== 'any')]
  } catch {
    /* fallback to `ip` */
  }
  try {
    const r = await runRawCapture('ip', ['-o', 'link', 'show'], 8000)
    const names = new Set<string>()
    for (const m of r.stdout.matchAll(/^\d+:\s+([^:@\s]+)/gm)) {
      const name = (m[1] ?? '').trim()
      if (/^[A-Za-z0-9_.:-]+$/.test(name)) names.add(name)
    }
    return ['any', ...[...names].sort().filter((n) => n !== 'any')]
  } catch {
    return ['any']
  }
}

export async function isNfqwsRunning(): Promise<boolean> {
  const r = await runRawCapture('pgrep', ['-f', NFQWS_MATCH_PATTERN], 8000)
  return r.code === 0 && r.stdout.trim() !== ''
}

export async function getNfqwsCmdline(): Promise<string> {
  try {
    const r = await runRawCapture('pgrep', ['-af', NFQWS_MATCH_PATTERN], 8000)
    if (r.code !== 0) return ''
    return r.stdout.trim().split('\n')[0]?.trim() ?? ''
  } catch {
    return ''
  }
}

export async function isNftablesActive(): Promise<boolean> {
  // Status polling runs every 15s from the tray — it must NEVER pop an auth
  // dialog (that was the "asks for root again and again" bug): fail fast
  // and let the UI re-offer the grant instead.
  const r = await runPrivileged('nft', ['list', 'tables'], 10000, { allowPrompt: false })
  if (r.code !== 0) return false
  return r.stdout.split('\n').some((l) => l.trim() === `table ${NFT_FAMILY} ${NFT_TABLE}`)
}

export function readLinuxActiveStrategy(dataDir: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(dataDir, LINUX_ACTIVE_STRATEGY_FILE), 'utf8').trim()
    return raw === '' ? null : raw
  } catch {
    return null
  }
}

function writeLinuxActiveStrategy(dataDir: string, name: string | null): void {
  const p = path.join(dataDir, LINUX_ACTIVE_STRATEGY_FILE)
  if (name == null) {
    fs.rmSync(p, { force: true })
    return
  }
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(p, `${name}\n`, 'utf8')
}

export function readLinuxServiceState(dataDir: string): LinuxServiceState | null {
  try {
    const raw = fs.readFileSync(path.join(dataDir, LINUX_SERVICE_STATE_FILE), 'utf8')
    const parsed = JSON.parse(raw) as Partial<LinuxServiceState>
    if (!Array.isArray(parsed.nfqwsArgs) || typeof parsed.strategyName !== 'string') return null
    return {
      strategyId: String(parsed.strategyId ?? ''),
      strategyName: parsed.strategyName,
      interface: sanitizeInterface(String(parsed.interface ?? 'any')),
      tcpPorts: String(parsed.tcpPorts ?? ''),
      udpPorts: String(parsed.udpPorts ?? ''),
      nfqwsArgs: parsed.nfqwsArgs.map(String),
      updatedAt: String(parsed.updatedAt ?? '')
    }
  } catch {
    return null
  }
}

function writeLinuxServiceState(dataDir: string, state: LinuxServiceState): void {
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(path.join(dataDir, LINUX_SERVICE_STATE_FILE), JSON.stringify(state, null, 2), 'utf8')
}

/** Linux dashboard snapshot (same shape as the Windows one). */
export async function getLinuxStatus(hasRoot: boolean, dataDir: string, ownBinDir: string): Promise<StatusSnapshot> {
  const [nfqwsRunning, cmdline, nftActive, activeStrategy, storedState] = await Promise.all([
    isNfqwsRunning(),
    getNfqwsCmdline(),
    hasRoot ? isNftablesActive().catch(() => false) : Promise.resolve(false),
    Promise.resolve(readLinuxActiveStrategy(dataDir)),
    Promise.resolve(readLinuxServiceState(dataDir))
  ])
  const { zapret, nft } = decideLinuxZapretState({
    hasRoot,
    nfqwsRunning,
    nftActive,
    hasStoredState: activeStrategy != null || storedState != null
  })
  return {
    zapret,
    // Reuse the `windivert` slot for the nftables table state so the existing
    // Dashboard row stays meaningful without renderer forks.
    windivert: nft,
    winwsRunning: nfqwsRunning,
    activeStrategy,
    serviceBinPath: cmdline === '' ? null : cmdline,
    winwsPath: cmdline === '' ? null : cmdline.split(/\s+/)[0] ?? null,
    ownership: detectLinuxOwnership(nfqwsRunning, cmdline, ownBinDir),
    isAdmin: hasRoot
  }
}

/**
 * Decide the Linux dashboard states from raw probes.
 * The key rule: WITHOUT root we cannot verify the nftables half of the
 * pipeline (and a `pgrep` hit may be a foreign/stale process), so a pgrep
 * hit must NEVER surface as RUNNING — it surfaces as UNKNOWN ("grant root
 * to verify"). Claiming RUNNING there was the "phantom services" bug:
 * e.g. an nfqws daemon left over from an earlier session with flushed
 * (or simply uninspectable) nft rules looked like a working bypass.
 * Pure — covered by unit tests.
 */
export function decideLinuxZapretState(opts: {
  hasRoot: boolean
  nfqwsRunning: boolean
  nftActive: boolean
  hasStoredState: boolean
}): { zapret: ServiceState; nft: ServiceState } {
  const { hasRoot, nfqwsRunning, nftActive, hasStoredState } = opts
  const nft: ServiceState = !hasRoot ? 'UNKNOWN' : nftActive ? 'RUNNING' : 'NOT_INSTALLED'
  let zapret: ServiceState
  if (!hasRoot) {
    zapret = nfqwsRunning || hasStoredState ? 'UNKNOWN' : 'NOT_INSTALLED'
  } else if (nfqwsRunning && nftActive) {
    zapret = 'RUNNING'
  } else if (nfqwsRunning || hasStoredState) {
    // Half state: daemon without rules (or rules without daemon) does not
    // bypass anything — STOPPED tells the user to press Start (which
    // reinstalls the rules and restarts the daemon).
    zapret = 'STOPPED'
  } else {
    zapret = 'NOT_INSTALLED'
  }
  return { zapret, nft }
}

async function nftCmd(args: string[], onLog?: (t: string) => void): Promise<void> {
  const full = ['nft', ...args]
  onLog?.(`nft ${args.join(' ')}`)
  const r = await runPrivileged(full[0] as string, full.slice(1), 15000)
  const out = `${r.stdout}\n${r.stderr}`.trim()
  if (r.code !== 0) {
    throw new Error(`nft ${args.slice(0, 3).join(' ')} failed: ${out.slice(0, 300) || `exit ${r.code}`}`)
  }
}

/** (Re)create nftables rules. Clears our table first — idempotent. */
export async function setupNftables(tcpPorts: string, udpPorts: string, iface: string, onLog?: (t: string) => void): Promise<void> {
  await clearNftables(true)
  const cmds = buildNftSetupCommands(tcpPorts, udpPorts, iface)
  // First three create table + chains; the rest add rules (skip when the
  // port set is empty — e.g. a TCP-only strategy has no UDP rules).
  for (const argv of cmds) {
    await nftCmd(argv.slice(1), onLog)
  }
}

/** Remove our nftables table. Best-effort unless `strict`. */
export async function clearNftables(quiet = false): Promise<void> {
  for (const argv of buildNftClearCommands()) {
    const r = await runPrivileged(argv[0] as string, argv.slice(1), 15000)
    if (r.code !== 0 && !quiet) {
      const out = `${r.stdout}\n${r.stderr}`.trim().slice(0, 200)
      // Missing table/chain is the normal "nothing to clean" case.
      if (/no such file|does not exist|unknown/i.test(out)) continue
    }
  }
}

async function stopNfqwsProcesses(onLog?: (t: string) => void): Promise<void> {
  const r = await runPrivileged('pkill', ['-f', NFQWS_MATCH_PATTERN], 10000)
  if (!quietPkillOk(r.code)) {
    onLog?.('nfqws stop requested (none running or already stopped).')
    return
  }
  onLog?.('nfqws processes stopped.')
}

function quietPkillOk(code: number | null): boolean {
  // pkill exits 1 when nothing matched — not an error here.
  return code === 0 || code === 1
}

/**
 * Install a strategy on Linux: nftables rules + `nfqws --daemon`.
 * `binDir`/`listsDir` materialize the shared `<BIN>`/`<LISTS>` placeholders.
 */
export async function installLinuxStrategy(
  strategy: Strategy,
  opts: { dataDir: string; binDir: string; listsDir: string; interface?: string },
  onLog?: (text: string) => void
): Promise<void> {
  const say = (t: string): void => {
    onLog?.(t)
  }
  // Explicit user action: re-prompt here when the auth lapsed instead of
  // bouncing the user to the banner (the app itself never runs as root).
  await ensureRootPrivilege()
  const iface = sanitizeInterface(opts.interface ?? getLinuxInterface(opts.dataDir))
  const { tcp: gameTcp, udp: gameUdp } = resolveGameFilterPorts(opts.dataDir)
  const materialized = materializeArgs(strategy.args, { binDir: opts.binDir, listsDir: opts.listsDir, gameTcp, gameUdp })
  const { tcp, udp } = parseWfPorts(materialized)
  if (!tcp && !udp) {
    throw new Error(`Strategy "${strategy.name}" has no --wf-tcp/--wf-udp ports — cannot build nftables rules`)
  }
  const filterArgs = stripWfArgs(materialized).map((a) => a.replace(/"/g, ''))
  const nfqwsPath = resolveNfqwsPath(opts.dataDir)
  try {
    if (path.isAbsolute(nfqwsPath)) fs.accessSync(nfqwsPath, fs.constants.X_OK)
  } catch {
    throw new Error(
      `nfqws binary not found. Update the DPI engine first (Updates tab) or place nfqws into ${path.join(opts.dataDir, 'bin')}.`
    )
  }
  // Fail fast on missing list files BEFORE touching the firewall: the engine
  // exits nonzero on a missing ipset file, and a half-applied nftables
  // setup + dead daemon is worse than a clear pre-flight error.
  ensureListFilesExist(opts.listsDir, filterArgs, say)

  say(`Stopping previous nfqws (if any)...`)
  await stopNfqwsProcesses(say)
  await clearNftables(true)

  say(`Setting up nftables (tcp: ${tcp || '—'}, udp: ${udp || '—'}, iface: ${iface})...`)
  await setupNftables(tcp, udp, iface, say)

  const daemonArgs = ['--daemon', `--dpi-desync-fwmark=${NFT_MARK}`, `--qnum=${NFT_QUEUE_NUM}`, ...linuxDropUserArgs(), ...filterArgs]
  say(`Starting nfqws --daemon (${filterArgs.length} args)...`)
  const started = await runPrivileged(nfqwsPath, daemonArgs, 20000)
  if (started.code !== 0) {
    const out = trimEngineOutput(`${started.stdout}\n${started.stderr}`)
    say(`nfqws output: ${out}`)
    await clearNftables(true).catch(() => undefined)
    throw new Error(`nfqws failed to start: ${out || `exit ${started.code}`}`)
  }
  // Give the daemon a moment, then verify it is actually there.
  await new Promise((r) => setTimeout(r, 800))
  if (!(await isNfqwsRunning())) {
    const out = trimEngineOutput(`${started.stdout}\n${started.stderr}`)
    await clearNftables(true).catch(() => undefined)
    throw new Error(`nfqws exited immediately${out ? `: ${out}` : ''}`)
  }
  writeLinuxActiveStrategy(opts.dataDir, strategy.name)
  setLinuxInterface(opts.dataDir, iface)
  writeLinuxServiceState(opts.dataDir, {
    strategyId: strategy.id,
    strategyName: strategy.name,
    interface: iface,
    tcpPorts: tcp,
    udpPorts: udp,
    nfqwsArgs: filterArgs,
    updatedAt: new Date().toISOString()
  })
  say(`Strategy "${strategy.name}" installed and started (nftables + nfqws).`)
}

/** Start the last installed strategy (replay stored state). */
export async function startLinuxService(dataDir: string, onLog?: (text: string) => void): Promise<void> {
  const say = (t: string): void => {
    onLog?.(t)
  }
  await ensureRootPrivilege()
  const state = readLinuxServiceState(dataDir)
  if (!state) throw new Error('No Linux strategy installed — apply a strategy on the Strategies tab first')
  ensureListFilesExist(path.join(dataDir, 'lists'), state.nfqwsArgs, say)
  const nfqwsPath = resolveNfqwsPath(dataDir)
  await setupNftables(state.tcpPorts, state.udpPorts, state.interface, say)
  const started = await runPrivileged(nfqwsPath, ['--daemon', `--dpi-desync-fwmark=${NFT_MARK}`, `--qnum=${NFT_QUEUE_NUM}`, ...linuxDropUserArgs(), ...state.nfqwsArgs], 20000)
  if (started.code !== 0) {
    throw new Error(`nfqws failed to start: ${trimEngineOutput(`${started.stdout}\n${started.stderr}`) || `exit ${started.code}`}`)
  }
  writeLinuxActiveStrategy(dataDir, state.strategyName)
  say('zapret started (nftables + nfqws).')
}

/** Stop nfqws + remove nftables rules. */
export async function stopLinuxService(dataDir: string, onLog?: (text: string) => void): Promise<void> {
  await ensureRootPrivilege()
  await stopNfqwsProcesses(onLog)
  await clearNftables(true)
  writeLinuxActiveStrategy(dataDir, readLinuxServiceState(dataDir)?.strategyName ?? null)
  onLog?.('zapret stopped, nftables rules cleared.')
}

/** Full removal: stop everything, forget the installed strategy. */
export async function removeLinuxServices(dataDir: string, onLog?: (text: string) => void): Promise<void> {
  await ensureRootPrivilege()
  await stopNfqwsProcesses(onLog)
  await clearNftables(true)
  writeLinuxActiveStrategy(dataDir, null)
  try {
    fs.rmSync(path.join(dataDir, LINUX_SERVICE_STATE_FILE), { force: true })
  } catch {
    /* best-effort */
  }
  onLog?.('Linux zapret services removed.')
}

/** Human-readable error for service start/stop failures. Pure. */
export function friendlyLinuxError(action: 'start' | 'stop', output: string): string {
  if (/permission denied|operation not permitted|must be root|not granted/i.test(output)) {
    return 'Root privileges are required. Grant root access first — the app itself never runs as root.'
  }
  if (/nftables|nft.*not found|No such file/i.test(output) && /nft/i.test(output)) {
    return 'nftables is not available. Install it via your package manager (apt install nftables / dnf install nftables).'
  }
  return output.trim().slice(0, 500) || `Service ${action} failed`
}

/**
 * Trim engine output for error messages: the fatal line is always at the
 * TAIL (`failed to register ipset ...`), while a head-only slice shows just
 * the startup banner (the bug that hid the real cause). Keeps head + tail.
 * Pure — covered by unit tests.
 */
export function trimEngineOutput(out: string, head = 300, tail = 700): string {
  const t = String(out ?? '').trim()
  if (t.length <= head + tail + 32) return t
  return `${t.slice(0, head)}\n…[truncated ${t.length - head - tail} chars]…\n${t.slice(-tail)}`
}
