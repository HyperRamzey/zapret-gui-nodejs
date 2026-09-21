/**
 * Pure renderer helpers extracted from pages/store for unit testing.
 * No React, no DOM, no zustand side effects — safe to import in vitest node env.
 * @module renderer/lib/ui-logic
 */
import type { AppPlatform, BypassCheckResult, DiagnosticCheck, ServiceState, StatusSnapshot } from '../../shared/types'

/* ---------- Lists.tsx ---------- */

export function countListEntries(content: string): number {
  let n = 0
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim()
    if (t === '' || t.startsWith('#') || t.startsWith(';')) continue
    n++
  }
  return n
}

export function dedupListContent(content: string): string {
  if (content === '') return ''
  const seen = new Set<string>()
  const out: string[] = []
  const rows = content.replace(/\r\n?/g, '\n').split('\n')
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i]
    const t = raw.trim()
    // The split of a trailing-newline file yields one artificial '' tail —
    // the final '\n' below already covers it, don't push it twice.
    if (t === '' && i === rows.length - 1) continue
    if (t === '' || t.startsWith('#') || t.startsWith(';')) {
      out.push(raw)
      continue
    }
    const key = t.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(t)
  }
  return out.join('\n') + (out.length > 0 ? '\n' : '')
}

export function sortListContent(content: string): string {
  const comments: string[] = []
  const entries: string[] = []
  for (const raw of content.replace(/\r\n?/g, '\n').split('\n')) {
    const t = raw.trim()
    if (t === '') continue
    if (t.startsWith('#') || t.startsWith(';')) comments.push(raw)
    else entries.push(t)
  }
  const uniq = [...new Set(entries.map((e) => e.toLowerCase())).keys()].map(
    (lower) => entries.find((e) => e.toLowerCase() === lower) as string
  )
  uniq.sort((a, b) => a.localeCompare(b))
  const parts = [...comments, ...uniq]
  return parts.length > 0 ? parts.join('\n') + '\n' : ''
}

/** Split the "add entries" input on whitespace/commas/semicolons. */
export function splitAddParts(raw: string): string[] {
  return raw
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** Pure merge for Lists.addEntries: content + addValue -> new content (or null when nothing new). */
export function mergeAddEntries(content: string, addValue: string): string | null {
  const parts = splitAddParts(addValue)
  if (parts.length === 0) return null
  const existing = new Set(
    content
      .split(/\r?\n/)
      .map((l) => l.trim().toLowerCase())
      .filter((l) => l !== '')
  )
  const fresh = parts.filter((p) => !existing.has(p.toLowerCase()))
  if (fresh.length === 0) return null
  const base = content.endsWith('\n') || content === '' ? content : content + '\n'
  return base + fresh.join('\n') + '\n'
}

/* ---------- Settings.tsx ---------- */

/** Split free-form list input (commas/semicolons/spaces/newlines) into entries. */
export function splitEntries(raw: string): string[] {
  return raw
    .replace(/[,;\n\r\t]+/g, ' ')
    .split(' ')
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

/** Port draft -> port to commit, or null when invalid/unchanged. */
export function parsePortDraft(portDraft: string | null, currentPort: number): number | null {
  if (portDraft === null) return null
  const n = Number.parseInt(portDraft, 10)
  if (!Number.isFinite(n) || n < 1 || n > 65535 || n === currentPort) return null
  return n
}

/** Draft commit guard: undefined (untouched) or equal -> do not commit. */
export function shouldCommitDraft(raw: string | undefined, current: string): boolean {
  if (raw === undefined) return false
  return raw !== current
}

/**
 * Reset-button gate (mirrors Settings.onReset logic): a running zapret locks
 * data files, so reset stays disabled until stopped. Exception: unprivileged
 * Linux pgrep hits are unverifiable — blocking on them would deadlock the UI.
 */
export function isZapretActiveForReset(status: StatusSnapshot | null, platform: AppPlatform): boolean {
  if (!status) return false
  return (
    status.zapret === 'RUNNING' ||
    status.zapret === 'START_PENDING' ||
    status.zapret === 'STOP_PENDING' ||
    (status.winwsRunning === true && (platform !== 'linux' || status.isAdmin === true))
  )
}

/* ---------- Dashboard.tsx ---------- */

export function stateTone(s: ServiceState): 'green' | 'red' | 'gray' | 'yellow' {
  if (s === 'RUNNING') return 'green'
  if (s === 'STOPPED' || s === 'NOT_INSTALLED') return 'red'
  if (s === 'START_PENDING' || s === 'STOP_PENDING') return 'yellow'
  return 'gray'
}

export function stateKey(s: ServiceState): 'running' | 'stopped' | 'not-installed' | 'unknown' {
  if (s === 'RUNNING') return 'running'
  if (s === 'STOPPED') return 'stopped'
  if (s === 'NOT_INSTALLED') return 'not-installed'
  return 'unknown'
}

/** First token of a service ImagePath (`"C:\...\winws.exe" --args` → `"C:\...\winws.exe"`). */
export function shortExePath(full: string): string {
  const s = full.trim()
  if (s === '' || s === '—') return s
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1)
    if (end > 1) return s.slice(0, end + 1)
  }
  return s.split(/\s+/)[0] ?? s
}

export type BypassUi =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'ok'; latencyMs: number; httpStatus: number | null }
  | { status: 'fail'; latencyMs?: number; httpStatus?: number | null; error?: string | null }

/** Map a cached check result to UI state (null = never checked). */
export function toBypassUi(r: BypassCheckResult | null): BypassUi {
  if (!r) return { status: 'idle' }
  return r.ok
    ? { status: 'ok', latencyMs: r.latencyMs, httpStatus: r.httpStatus }
    : { status: 'fail', latencyMs: r.latencyMs, httpStatus: r.httpStatus, error: r.error }
}

/* ---------- Diagnostics.tsx / Strategies.tsx ---------- */

export function diagTone(level: DiagnosticCheck['level']): 'green' | 'yellow' | 'red' {
  return level === 'ok' ? 'green' : level === 'warn' ? 'yellow' : 'red'
}

export function diagIcon(level: DiagnosticCheck['level']): string {
  return level === 'ok' ? '✅' : level === 'warn' ? '⚠️' : '❌'
}

/** `Name (TAG)` -> { base, tag }; shared by Strategies + Diagnostics. */
export function splitStrategyName(name: string): { base: string; tag: string | null } {
  const m = name.match(/^(.*?)\s*\(([^)]+)\)\s*$/)
  if (!m) return { base: name, tag: null }
  const base = m[1].trim()
  if (!base) return { base: name, tag: null }
  return { base, tag: m[2].trim() }
}

/* ---------- Lists.tsx ---------- */

export type UserListGuideKey =
  | 'lists.guideGeneral'
  | 'lists.guideExclude'
  | 'lists.guideIpset'
  | 'lists.guideIpsetExclude'

/**
 * Map a list file name to its guide i18n key (null for unknown files).
 * Case-insensitive, ignores surrounding whitespace. Pure.
 */
export function userListGuideKey(name: string): UserListGuideKey | null {
  const n = String(name ?? '').trim().toLowerCase()
  if (n === 'list-general-user.txt') return 'lists.guideGeneral'
  if (n === 'list-exclude-user.txt') return 'lists.guideExclude'
  if (n === 'ipset-all.txt') return 'lists.guideIpset'
  if (n === 'ipset-exclude-user.txt') return 'lists.guideIpsetExclude'
  return null
}
