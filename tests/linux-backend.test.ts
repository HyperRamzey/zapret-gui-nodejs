/**
 * Linux backend unit tests: nftables command builder (mirrors
 * zapret-discord-youtube-linux `00-nftables.sh`), strategy port parsing,
 * privilege argv builder and platform overrides.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { app } from 'electron'
import {
  parseWfPorts,
  stripWfArgs,
  nftPortSet,
  buildNftSetupCommands,
  buildNftClearCommands,
  detectLinuxOwnership,
  sanitizeInterface,
  NFT_FAMILY,
  NFT_TABLE,
  NFT_CHAIN,
  NFT_CHAIN_PRE
} from '../src/main/linux-service'
import { buildElevatedArgv, detectElevator } from '../src/main/linux-privilege'
import { getPlatform } from '../src/main/platform'

afterEach(() => {
  delete process.env.TEST_PLATFORM
  delete process.env.TEST_ELEVATOR
})

describe('platform overrides', () => {
  it('respects TEST_PLATFORM', () => {
    process.env.TEST_PLATFORM = 'linux'
    expect(getPlatform()).toBe('linux')
    process.env.TEST_PLATFORM = 'win32'
    expect(getPlatform()).toBe('win32')
  })
})

describe('parseWfPorts', () => {
  it('extracts tcp/udp port sets', () => {
    const { tcp, udp } = parseWfPorts(['--wf-tcp=80,443,1024-65535', '--wf-udp=443', '--filter-tcp=80'])
    expect(tcp).toBe('80,443,1024-65535')
    expect(udp).toBe('443')
  })

  it('returns empty strings when missing', () => {
    expect(parseWfPorts(['--filter-tcp=80'])).toEqual({ tcp: '', udp: '' })
  })
})

describe('stripWfArgs', () => {
  it('drops Windows-only --wf-* tokens', () => {
    const out = stripWfArgs(['--wf-tcp=80,443', '--wf-udp=443', '--filter-tcp=80', '--dpi-desync=fake'])
    expect(out).toEqual(['--filter-tcp=80', '--dpi-desync=fake'])
  })
})

describe('sanitizeInterface', () => {
  it('accepts any and plain names', () => {
    expect(sanitizeInterface('any')).toBe('any')
    expect(sanitizeInterface('ANY')).toBe('any')
    expect(sanitizeInterface('eth0')).toBe('eth0')
    expect(sanitizeInterface('enp0s3')).toBe('enp0s3')
  })

  it('rejects shell metachars', () => {
    expect(() => sanitizeInterface('eth0; rm -rf /')).toThrow()
    expect(() => sanitizeInterface('$(id)')).toThrow()
  })
})

describe('nftPortSet', () => {
  it('wraps ports in braces', () => {
    expect(nftPortSet('80,443')).toBe('{80,443}')
    expect(nftPortSet('1024-65535')).toBe('{1024-65535}')
  })

  it('returns null for empty', () => {
    expect(nftPortSet('')).toBeNull()
  })

  it('rejects injection', () => {
    expect(() => nftPortSet('80; nft flush ruleset')).toThrow()
  })
})

describe('buildNftSetupCommands', () => {
  it('creates table + both chains + tcp/udp + reply rules', () => {
    const cmds = buildNftSetupCommands('80,443', '443', 'any')
    // table, post chain, pre chain, tcp rule, udp rule, tcp reply rule
    expect(cmds).toHaveLength(6)
    expect(cmds[0]).toEqual(['nft', 'add', 'table', NFT_FAMILY, NFT_TABLE])
    expect(cmds[1]).toContain(NFT_CHAIN)
    expect(cmds[2]).toContain(NFT_CHAIN_PRE)
    const tcpRule = cmds[3].join(' ')
    expect(tcpRule).toContain('tcp dport {80,443}')
    expect(tcpRule).toContain('queue num 220')
    const udpRule = cmds[4].join(' ')
    expect(udpRule).toContain('udp dport {443}')
    const reply = cmds[5].join(' ')
    expect(reply).toContain('tcp sport {80,443}')
  })

  it('adds interface match when not any', () => {
    const cmds = buildNftSetupCommands('80', '443', 'eth0')
    expect(cmds[3]).toContain('eth0')
    expect(cmds[3]).toContain('oifname')
    expect(cmds[5]).toContain('iifname')
  })

  it('skips udp rules when udp set is empty', () => {
    const cmds = buildNftSetupCommands('80', '', 'any')
    // table + 2 chains + tcp + tcp-reply
    expect(cmds).toHaveLength(5)
    expect(cmds.every((c) => !c.includes('udp dport'))).toBe(true)
  })
})

describe('buildNftClearCommands', () => {
  it('removes chains then the table', () => {
    const cmds = buildNftClearCommands()
    expect(cmds[cmds.length - 1]).toEqual(['nft', 'delete', 'table', NFT_FAMILY, NFT_TABLE])
  })
})

describe('detectLinuxOwnership', () => {
  it('maps running state + paths', () => {
    expect(detectLinuxOwnership(false, '', '/data/bin')).toBe('none')
    expect(detectLinuxOwnership(true, '', '/data/bin')).toBe('unknown')
    expect(detectLinuxOwnership(true, '/data/bin/nfqws --daemon', '/data/bin')).toBe('ours')
    expect(detectLinuxOwnership(true, '/opt/other/nfqws --daemon', '/data/bin')).toBe('foreign')
  })
})

describe('trimEngineOutput', () => {
  it('keeps the fatal tail instead of a head-only slice', async () => {
    const { trimEngineOutput } = await import('../src/main/linux-service')
    const out = `github version v72.13\n${'x'.repeat(2000)}\nfailed to register ipset '/d/ipset-exclude-user.txt'`
    const trimmed = trimEngineOutput(out)
    expect(trimmed).toContain('failed to register ipset')
    expect(trimmed.length).toBeLessThan(out.length)
    expect(trimEngineOutput('short output')).toBe('short output')
  })
})

describe('linuxDropUserArgs', () => {  it('passes a validated --user flag, rejects root and injections', async () => {
    const { linuxDropUserArgs } = await import('../src/main/linux-service')
    expect(linuxDropUserArgs('avencores')).toEqual(['--user=avencores'])
    expect(linuxDropUserArgs('root')).toEqual([])
    expect(linuxDropUserArgs('ROOT')).toEqual([])
    expect(linuxDropUserArgs('a; rm -rf /')).toEqual([])
    expect(linuxDropUserArgs('--qnum=1')).toEqual([])
    // Empty override falls back to the current desktop user (valid flag or []).
    const fb = linuxDropUserArgs('')
    expect(fb.length).toBeLessThanOrEqual(1)
    if (fb.length === 1) expect(fb[0]).toMatch(/^--user=[A-Za-z_][A-Za-z0-9_.-]*$/)
  })

  it('falls back to the current desktop user without throwing', async () => {
    const { linuxDropUserArgs } = await import('../src/main/linux-service')
    const r = linuxDropUserArgs()
    expect(r.length).toBeLessThanOrEqual(1)
    if (r.length === 1) expect(r[0]).toMatch(/^--user=[A-Za-z_][A-Za-z0-9_.-]*$/)
  })
})

describe('decideLinuxZapretState', () => {
  it('never claims RUNNING without root (phantom-services fix)', async () => {
    const { decideLinuxZapretState } = await import('../src/main/linux-service')
    // Fresh machine: nothing known.
    expect(
      decideLinuxZapretState({ hasRoot: false, nfqwsRunning: false, nftActive: false, hasStoredState: false })
    ).toEqual({ zapret: 'NOT_INSTALLED', nft: 'UNKNOWN' })
    // pgrep hit without root (stale/foreign daemon, unverifiable nft half).
    expect(
      decideLinuxZapretState({ hasRoot: false, nfqwsRunning: true, nftActive: false, hasStoredState: true })
    ).toEqual({ zapret: 'UNKNOWN', nft: 'UNKNOWN' })
    // Stored files alone (last install remembered, state unverifiable).
    expect(
      decideLinuxZapretState({ hasRoot: false, nfqwsRunning: false, nftActive: false, hasStoredState: true })
    ).toEqual({ zapret: 'UNKNOWN', nft: 'UNKNOWN' })
  })

  it('maps the privileged states', async () => {
    const { decideLinuxZapretState } = await import('../src/main/linux-service')
    expect(
      decideLinuxZapretState({ hasRoot: true, nfqwsRunning: true, nftActive: true, hasStoredState: true })
    ).toEqual({ zapret: 'RUNNING', nft: 'RUNNING' })
    // Daemon without rules bypasses nothing — STOPPED (Start repairs it).
    expect(
      decideLinuxZapretState({ hasRoot: true, nfqwsRunning: true, nftActive: false, hasStoredState: true })
    ).toEqual({ zapret: 'STOPPED', nft: 'NOT_INSTALLED' })
    expect(
      decideLinuxZapretState({ hasRoot: true, nfqwsRunning: false, nftActive: false, hasStoredState: true })
    ).toEqual({ zapret: 'STOPPED', nft: 'NOT_INSTALLED' })
    expect(
      decideLinuxZapretState({ hasRoot: true, nfqwsRunning: false, nftActive: false, hasStoredState: false })
    ).toEqual({ zapret: 'NOT_INSTALLED', nft: 'NOT_INSTALLED' })
  })
})

describe('buildElevatedArgv', () => {
  it('uses non-interactive forms', () => {
    expect(buildElevatedArgv('sudo', 'nft', ['list', 'tables'])).toEqual(['sudo', '-n', 'nft', 'list', 'tables'])
    expect(buildElevatedArgv('doas', 'nft', ['flush', 'ruleset'])).toEqual(['doas', '-n', 'nft', 'flush', 'ruleset'])
    expect(buildElevatedArgv('pkexec', 'nft', ['list', 'tables'])).toEqual(['pkexec', 'nft', 'list', 'tables'])
    expect(buildElevatedArgv('none', 'nft', ['list'])).toEqual(['nft', 'list'])
  })

  it('pkexec never prompts in background-polling mode', () => {
    // Background status ticks must fail fast instead of spawning a polkit
    // dialog every 15 seconds once retention expires.
    expect(buildElevatedArgv('pkexec', 'nft', ['list', 'tables'], { allowPrompt: false })).toEqual([
      'pkexec',
      '--disable-internal-agent',
      'nft',
      'list',
      'tables'
    ])
    // sudo/doas are already non-interactive (-n) in both modes.
    expect(buildElevatedArgv('sudo', 'nft', ['list'], { allowPrompt: false })[1]).toBe('-n')
    expect(buildElevatedArgv('doas', 'nft', ['list'], { allowPrompt: false })[1]).toBe('-n')
  })

  it('detectElevator respects override', () => {
    process.env.TEST_ELEVATOR = 'sudo'
    expect(detectElevator()).toBe('sudo')
  })

  it('availableElevators respects override as a single-item chain', async () => {
    process.env.TEST_ELEVATOR = 'pkexec'
    const { availableElevators, resetPrivilegeCache } = await import('../src/main/linux-privilege')
    resetPrivilegeCache()
    expect(availableElevators()).toEqual(['pkexec'])
  })
})

describe('askpass handling', () => {
  it('classifies helper launch failures as environmental (fall through to pkexec)', async () => {
    const { isAskpassEnvFailure } = await import('../src/main/linux-privilege')
    // Exact stderr from the bug report (ru sudo): zenity unresolvable.
    expect(
      isAskpassEnvFailure('sudo: не удаётся запустить zenity: Нет такого файла или каталога\nsudo: пароль не предоставлен\nsudo: требуется указать пароль')
    ).toBe(true)
    expect(isAskpassEnvFailure('sudo: unable to run /tmp/x.sh: No such file or directory')).toBe(true)
    expect(isAskpassEnvFailure('sudo: cannot open display: \nGtk-WARNING: cannot open display')).toBe(true)
    // Genuine auth failures must stop the chain, not cascade dialogs.
    expect(isAskpassEnvFailure('Sorry, try again.\nsudo: 3 incorrect password attempts')).toBe(false)
    expect(isAskpassEnvFailure('user is not in the sudoers file.')).toBe(false)
    expect(isAskpassEnvFailure('')).toBe(false)
  })

  it('findAskPass only returns absolute paths (sudo secure_path safety)', async () => {
    const { findAskPass } = await import('../src/main/linux-privilege')
    const found = findAskPass()
    if (found !== null) {
      expect(found.startsWith('/')).toBe(true)
    }
  })
})

describe('hasRootPrivilege hold semantics', () => {
  it('reports false before any grant (pkexec/doas never probe interactively)', async () => {
    process.env.TEST_PLATFORM = 'linux'
    const { hasRootPrivilege, resetPrivilegeCache } = await import('../src/main/linux-privilege')
    try {
      process.env.TEST_ELEVATOR = 'pkexec'
      resetPrivilegeCache()
      await expect(hasRootPrivilege()).resolves.toBe(false)
      process.env.TEST_ELEVATOR = 'doas'
      resetPrivilegeCache()
      // doas -n true fails without nopass config; must never prompt here.
      await expect(hasRootPrivilege()).resolves.toBe(false)
    } finally {
      delete process.env.TEST_ELEVATOR
      delete process.env.TEST_PLATFORM
    }
  })
})

describe('bundled linux engine', () => {
  const bundledBin = path.join(process.cwd(), 'bundled-assets', 'bin')

  it('ships nfqws next to the windows binaries', () => {
    expect(fs.existsSync(path.join(bundledBin, 'nfqws'))).toBe(true)
    expect(fs.existsSync(path.join(bundledBin, 'winws.exe'))).toBe(true)
  })

  it('bundled engine-version.txt looks like a release tag', () => {
    const v = fs.readFileSync(path.join(bundledBin, 'engine-version.txt'), 'utf8').trim()
    expect(v).toMatch(/^v\d+/)
  })

  it('bundled nfqws reports the bundled version (linux only)', async () => {
    if (process.platform !== 'linux') return
    const v = fs.readFileSync(path.join(bundledBin, 'engine-version.txt'), 'utf8').trim()
    const out = await new Promise<string>((resolve, reject) => {
      execFile(path.join(bundledBin, 'nfqws'), ['--version'], { timeout: 10000 }, (error, stdout, stderr) => {
        if (error) reject(error)
        else resolve(`${stdout}\n${stderr}`)
      })
    })
    expect(out).toContain(v)
  })
})

describe('ensureDataDirSeeded engine binaries per platform', () => {
  it('seeds nfqws (+x) without windows binaries on linux', async () => {
    process.env.TEST_PLATFORM = 'linux'
    const { ensureDataDirSeeded } = await import('../src/main/paths')
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zapret-seed-linux-'))
    try {
      const appData = path.join(tmp, 'appdata')
      const getAppPath = vi.spyOn(app, 'getAppPath').mockImplementation(() => process.cwd())
      const getPath = vi.spyOn(app, 'getPath').mockImplementation(((name: string) => {
        if (name === 'appData') return appData
        return tmp
      }) as typeof app.getPath)
      // @ts-expect-error electron stub has no isPackaged in tests
      app.isPackaged = false
      try {
        ensureDataDirSeeded()
        const bin = path.join(appData, 'zapret-gui', 'data', 'bin')
        expect(fs.existsSync(path.join(bin, 'nfqws'))).toBe(true)
        expect(fs.existsSync(path.join(bin, 'winws.exe'))).toBe(false)
        expect(fs.existsSync(path.join(bin, 'WinDivert64.sys'))).toBe(false)
        // Shared fakes still seed.
        expect(fs.existsSync(path.join(bin, 'tls_clienthello_www_google_com.bin'))).toBe(true)
        try {
          fs.accessSync(path.join(bin, 'nfqws'), fs.constants.X_OK)
        } catch {
          expect.unreachable('seeded nfqws must be executable')
        }
      } finally {
        getAppPath.mockRestore()
        getPath.mockRestore()
      }
    } finally {
      delete process.env.TEST_PLATFORM
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('seeds winws.exe without nfqws on windows', async () => {
    process.env.TEST_PLATFORM = 'win32'
    const { ensureDataDirSeeded } = await import('../src/main/paths')
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zapret-seed-win-'))
    try {
      const appData = path.join(tmp, 'appdata')
      const getAppPath = vi.spyOn(app, 'getAppPath').mockImplementation(() => process.cwd())
      const getPath = vi.spyOn(app, 'getPath').mockImplementation(((name: string) => {
        if (name === 'appData') return appData
        return tmp
      }) as typeof app.getPath)
      // @ts-expect-error electron stub has no isPackaged in tests
      app.isPackaged = false
      try {
        ensureDataDirSeeded()
        const bin = path.join(appData, 'zapret-gui', 'data', 'bin')
        expect(fs.existsSync(path.join(bin, 'winws.exe'))).toBe(true)
        expect(fs.existsSync(path.join(bin, 'nfqws'))).toBe(false)
      } finally {
        getAppPath.mockRestore()
        getPath.mockRestore()
      }
    } finally {
      delete process.env.TEST_PLATFORM
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('NFQWS_MATCH_PATTERN', () => {
  it('matches real daemon cmdlines, not random mentions', async () => {
    const { NFQWS_MATCH_PATTERN } = await import('../src/main/linux-service')
    // pgrep -f uses ERE; JS RegExp mirrors it for these cases.
    const re = new RegExp(NFQWS_MATCH_PATTERN)
    expect(re.test('/home/u/.config/zapret-gui/data/bin/nfqws --daemon --qnum=220')).toBe(true)
    expect(re.test('nfqws --daemon')).toBe(true)
    expect(re.test('sudo -n /opt/x/bin/nfqws --daemon')).toBe(true)
    expect(re.test('vim nfqws-notes.txt')).toBe(false)
    expect(re.test('man nfqws')).toBe(false)
    expect(re.test('/opt/nfqws-backup/run.sh')).toBe(false)
  })
})

describe('buildLinuxTesterArgs', () => {
  it('extracts nft ports and builds queue-first argv without --wf-*', async () => {
    const { buildLinuxTesterArgs } = await import('../src/main/linux-service')
    const r = buildLinuxTesterArgs([
      '--wf-tcp=80,443',
      '--wf-udp=443',
      '--filter-tcp=80',
      '--dpi-desync=fake',
      '--new'
    ])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.tcp).toBe('80,443')
    expect(r.udp).toBe('443')
    expect(r.args[0]).toBe('--dpi-desync-fwmark=0x40000000')
    expect(r.args[1]).toBe('--qnum=220')
    expect(r.args.some((a) => a.startsWith('--wf-'))).toBe(false)
    expect(r.args).toContain('--filter-tcp=80')
  })

  it('fails clearly when no wf ports exist', async () => {
    const { buildLinuxTesterArgs } = await import('../src/main/linux-service')
    const r = buildLinuxTesterArgs(['--filter-tcp=80', '--new'])
    expect(r.ok).toBe(false)
  })
})
