/**
 * User-defined bypass targets: validation + normalization shared by
 * the main process (settings persistence, IPC) and the renderer
 * (add-form validation). Pure — no Electron, safe for unit tests.
 * @module shared/bypass-custom
 */
import { CUSTOM_BYPASS_ID_PREFIX, MAX_CUSTOM_BYPASS_TARGETS } from './constants'
import type { CustomBypassTarget } from './types'

export { MAX_CUSTOM_BYPASS_TARGETS, CUSTOM_BYPASS_ID_PREFIX }

export interface NormalizedCustomUrl {
  url: string
  host: string
  name: string
  openUrl: string
}

/**
 * Normalize free-form user input (`example.com`, `https://example.com/page`)
 * to a checkable https URL. Returns null when the input is not a valid
 * http(s) host. Pure.
 */
export function normalizeCustomUrlInput(input: string): NormalizedCustomUrl | null {
  const raw = String(input ?? '').trim()
  if (raw === '' || raw.length > 2048) return null
  // Reject obvious multi-token garbage ("foo bar", newlines).
  if (/[\s<>]/.test(raw)) return null
  const withScheme = raw.includes('://') ? raw : `https://${raw}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const hostname = url.hostname.trim()
  if (hostname === '' || hostname.length > 253) return null
  if (/[\s_]/.test(hostname) && !hostname.includes('.')) {
    // Underscores/spaces are never valid in a public host; keep the check
    // permissive for intranet (`my-router`, `localhost`) by only rejecting
    // whitespace here — URL already validated the rest.
    return null
  }
  if (/\s/.test(hostname)) return null
  const host = url.host
  if (host === '') return null
  const href = url.href
  if (href.length > 2048) return null
  return { url: href, host, name: host, openUrl: href }
}

/** True for user-defined target ids (`custom-…`). Pure. */
export function isCustomBypassId(id: string): boolean {
  return typeof id === 'string' && id.startsWith(CUSTOM_BYPASS_ID_PREFIX)
}

/** Random stable id for a new custom target. */
export function makeCustomBypassId(): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${CUSTOM_BYPASS_ID_PREFIX}${Date.now().toString(36)}${rand}`
}

/**
 * Build a full custom target from free-form input (null when invalid).
 * Pure.
 */
export function buildCustomBypassTarget(input: string, id?: string): CustomBypassTarget | null {
  const norm = normalizeCustomUrlInput(input)
  if (!norm) return null
  const cleanId =
    typeof id === 'string' && /^[A-Za-z0-9-_]{1,64}$/.test(id) && id.startsWith(CUSTOM_BYPASS_ID_PREFIX)
      ? id
      : makeCustomBypassId()
  return { id: cleanId, name: norm.name, url: norm.url, host: norm.host, openUrl: norm.openUrl }
}

/**
 * Coerce an unknown persisted value to a clean custom-target list:
 * drops broken entries, re-normalizes URLs, dedupes by URL, caps at
 * MAX_CUSTOM_BYPASS_TARGETS. Pure.
 */
export function normalizeCustomBypassTargets(value: unknown): CustomBypassTarget[] {
  if (!Array.isArray(value)) return []
  const out: CustomBypassTarget[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (entry == null || typeof entry !== 'object') continue
    const rec = entry as Record<string, unknown>
    const urlRaw = typeof rec.url === 'string' ? rec.url : ''
    const norm = normalizeCustomUrlInput(urlRaw)
    if (!norm) continue
    const key = norm.url.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const idRaw = typeof rec.id === 'string' ? rec.id : ''
    const id =
      /^[A-Za-z0-9-_]{1,64}$/.test(idRaw) && idRaw.startsWith(CUSTOM_BYPASS_ID_PREFIX) ? idRaw : makeCustomBypassId()
    // Name/host/openUrl are re-derived so old/corrupted values self-heal;
    // a custom display name is kept when it is a short sane string.
    const nameRaw = typeof rec.name === 'string' ? rec.name.trim().slice(0, 80) : ''
    const hostRaw = typeof rec.host === 'string' ? rec.host.trim().slice(0, 253) : ''
    const openRaw = typeof rec.openUrl === 'string' ? rec.openUrl : ''
    const openNorm = normalizeCustomUrlInput(openRaw)
    out.push({
      id,
      name: nameRaw !== '' && !/[\r\n<>]/.test(nameRaw) ? nameRaw : norm.name,
      url: norm.url,
      host: hostRaw !== '' && !/[\s<>]/.test(hostRaw) ? hostRaw : norm.host,
      openUrl: openNorm ? openNorm.url : norm.openUrl
    })
    if (out.length >= MAX_CUSTOM_BYPASS_TARGETS) break
  }
  return out
}
