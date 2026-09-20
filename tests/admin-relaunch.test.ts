/** Unit tests for the "relaunch as admin" elevation flow (platform-independent). */
import { describe, it, expect } from 'vitest'
import { ADMIN_RELAUNCH_ARG, TG_PROXY_RESTART_ARG, isAdminHandoverArgv } from '../src/shared/constants'
import { ADMIN_RELAUNCH_TIMEOUT_MS, buildAdminRelaunchPs } from '../src/main/exec'

// Realistic install locations: per-user (NSIS `perMachine: false` default)
// vs a system folder chosen via "change installation directory".
const PER_USER_EXE = 'C:\\Users\\Test User\\AppData\\Local\\Programs\\Zapret GUI\\Zapret GUI.exe'
const SYSTEM_EXE = 'C:\\Program Files\\Zapret GUI\\Zapret GUI.exe'

describe('buildAdminRelaunchPs', () => {
  it('quotes a per-user path with spaces and pins the working directory', () => {
    const ps = buildAdminRelaunchPs(PER_USER_EXE, [ADMIN_RELAUNCH_ARG])
    expect(ps).toContain(`-FilePath '${PER_USER_EXE}'`)
    expect(ps).toContain(`-WorkingDirectory 'C:\\Users\\Test User\\AppData\\Local\\Programs\\Zapret GUI'`)
    expect(ps).toContain(`-ArgumentList '${ADMIN_RELAUNCH_ARG}'`)
    expect(ps).toContain('-Verb RunAs')
  })

  it('works the same for a system-folder install', () => {
    const ps = buildAdminRelaunchPs(SYSTEM_EXE, [ADMIN_RELAUNCH_ARG])
    expect(ps).toContain(`-FilePath '${SYSTEM_EXE}'`)
    expect(ps).toContain(`-WorkingDirectory 'C:\\Program Files\\Zapret GUI'`)
    expect(ps).toContain(`-ArgumentList '${ADMIN_RELAUNCH_ARG}'`)
    expect(ps).toContain('-Verb RunAs')
  })

  it('omits -ArgumentList when there are no args', () => {
    const ps = buildAdminRelaunchPs(SYSTEM_EXE, [])
    expect(ps).not.toContain('-ArgumentList')
    expect(ps).toContain(`-FilePath '${SYSTEM_EXE}'`)
  })

  it('joins multiple args with commas (tg-proxy handover + marker)', () => {
    const ps = buildAdminRelaunchPs(PER_USER_EXE, [TG_PROXY_RESTART_ARG, ADMIN_RELAUNCH_ARG])
    expect(ps).toContain(`-ArgumentList '${TG_PROXY_RESTART_ARG}','${ADMIN_RELAUNCH_ARG}'`)
  })

  it('filters out a mistakenly forwarded exe path (argv[0])', () => {
    const ps = buildAdminRelaunchPs(PER_USER_EXE, [PER_USER_EXE, ADMIN_RELAUNCH_ARG])
    // The exe must appear exactly once (in -FilePath), never as an argument:
    // passing it as an argument breaks the elevated launch.
    expect(ps.split(PER_USER_EXE).length - 1).toBe(1)
    expect(ps).toContain(`-ArgumentList '${ADMIN_RELAUNCH_ARG}'`)
  })

  it('escapes single quotes by doubling them', () => {
    const exe = "C:\\Users\\O'Brien\\Zapret GUI\\Zapret GUI.exe"
    const ps = buildAdminRelaunchPs(exe, ["it's"])
    expect(ps).toContain("O''Brien")
    expect(ps).toContain("-ArgumentList 'it''s'")
  })

  it('preserves non-ASCII (Cyrillic) paths verbatim', () => {
    const exe = 'C:\\Users\\Иван\\AppData\\Local\\Programs\\Zapret GUI\\Zapret GUI.exe'
    const ps = buildAdminRelaunchPs(exe, [ADMIN_RELAUNCH_ARG])
    expect(ps).toContain(`-FilePath '${exe}'`)
  })

  it('forces a non-zero exit when Start-Process throws (UAC denial)', () => {
    const ps = buildAdminRelaunchPs(SYSTEM_EXE, [ADMIN_RELAUNCH_ARG])
    expect(ps).toContain('$ErrorActionPreference=')
    expect(ps).toContain('try {')
    expect(ps).toContain('exit 0')
    expect(ps).toContain('} catch {')
    expect(ps).toContain('exit 1')
  })
})

describe('ADMIN_RELAUNCH_TIMEOUT_MS', () => {
  it('gives a human enough time to answer UAC (no early orphan)', () => {
    // Killing PowerShell while consent.exe is still open orphans the prompt:
    // a late "Yes" then hits a re-acquired lock and quits instantly.
    expect(ADMIN_RELAUNCH_TIMEOUT_MS).toBeGreaterThanOrEqual(120000)
  })
})

describe('isAdminHandoverArgv', () => {
  it('detects the elevated-copy marker', () => {
    expect(isAdminHandoverArgv([SYSTEM_EXE, ADMIN_RELAUNCH_ARG])).toBe(true)
    expect(isAdminHandoverArgv([TG_PROXY_RESTART_ARG, ADMIN_RELAUNCH_ARG])).toBe(true)
  })

  it('ignores ordinary launches', () => {
    expect(isAdminHandoverArgv([])).toBe(false)
    expect(isAdminHandoverArgv([SYSTEM_EXE])).toBe(false)
    expect(isAdminHandoverArgv([TG_PROXY_RESTART_ARG])).toBe(false)
  })
})
