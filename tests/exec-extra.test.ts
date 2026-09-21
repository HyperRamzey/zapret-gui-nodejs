/** Extra coverage for process execution helpers (cross-platform). */
import { describe, it, expect } from 'vitest'
import { run, killPidTree, relaunchAppAsAdmin, ADMIN_RELAUNCH_TIMEOUT_MS } from '../src/main/exec'

describe('run()', () => {
  it('captures stdout of a known binary', async () => {
    // NOTE: 'node' via PATH (no spaces), not process.execPath: run() sets
    // windowsVerbatimArguments:true (needed for inner quotes in sc/tasklist),
    // which leaves spaced file paths unquoted — process.execPath under
    // "C:\Program Files\..." would split. Direct spaced-binary run() is a
    // known latent limitation (live callers use cmd/powershell/sh/spawnLong).
    const r = await run('node', ['--version'])
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/v\d+\./)
  })

  it('never rejects on missing binary', async () => {
    const r = await run('__definitely_missing_binary_xyz__', ['--version'], { timeoutMs: 5000 })
    expect(r.code).not.toBe(0)
  })

  it('timeout surfaces non-zero code', async () => {
    const r = await run('node', ['-e', 'setTimeout(()=>{}, 5000)'], { timeoutMs: 500 })
    expect(r.code).not.toBe(0)
  }, 10000)
})

describe('killPidTree()', () => {
  it('ignores invalid pids without throwing', async () => {
    await expect(killPidTree(0)).resolves.toBeUndefined()
    await expect(killPidTree(-5)).resolves.toBeUndefined()
    await expect(killPidTree(Number.NaN)).resolves.toBeUndefined()
    await expect(killPidTree(999999)).resolves.toBeUndefined()
  }, 15000)
})

describe('relaunchAppAsAdmin', () => {
  it('throws on linux (never runs Electron as root)', async () => {
    const prev = process.env.TEST_PLATFORM
    process.env.TEST_PLATFORM = 'linux'
    try {
      await expect(relaunchAppAsAdmin('C:\\app.exe', [])).rejects.toThrow(/Linux/)
    } finally {
      if (prev === undefined) delete process.env.TEST_PLATFORM
      else process.env.TEST_PLATFORM = prev
    }
  })

  it('timeout constant is sane (>= 2min)', () => {
    expect(ADMIN_RELAUNCH_TIMEOUT_MS).toBeGreaterThanOrEqual(120000)
  })
})
