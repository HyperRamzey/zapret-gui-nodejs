/**
 * Platform helpers: single place that knows which OS we run on.
 * Windows keeps the legacy `winws.exe + WinDivert + SCM service` stack,
 * Linux uses `nfqws + nftables` (see `linux-service.ts`).
 * @module main/platform
 */

export type AppPlatform = 'win32' | 'linux' | 'other'

/** Current OS identifier (overrideable in tests via `TEST_PLATFORM`). */
export function getPlatform(): AppPlatform {
  const override = (process.env.TEST_PLATFORM ?? '').trim().toLowerCase()
  if (override === 'win32' || override === 'windows') return 'win32'
  if (override === 'linux') return 'linux'
  if (process.platform === 'win32') return 'win32'
  if (process.platform === 'linux') return 'linux'
  return 'other'
}

export function isWindows(): boolean {
  return getPlatform() === 'win32'
}

export function isLinux(): boolean {
  return getPlatform() === 'linux'
}

/** Engine binary name for the current platform. */
export function engineBinaryName(): 'winws.exe' | 'nfqws' {
  return isLinux() ? 'nfqws' : 'winws.exe'
}
