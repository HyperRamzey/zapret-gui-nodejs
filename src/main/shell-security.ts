/**
 * Shell/navigation allowlists for the main window and `shell.openExternal`.
 *
 * Renderer content must never decide which scheme leaves the app: every URL
 * handed to the OS (or loaded into the window) goes through these pure
 * predicates first. Covered by unit tests.
 *
 * @module main/shell-security
 */

/**
 * True for URLs the app may open in the user's browser: `http(s)` only.
 * Blocks `file:`, `javascript:`, `data:`, `vbscript:`, custom schemes, etc.
 * — a compromised renderer must not be able to turn `setWindowOpenHandler`
 * into an arbitrary-scheme launcher. Pure.
 */
export function isAllowedExternalUrl(raw: unknown): boolean {
  if (typeof raw !== 'string') return false
  const s = raw.trim()
  if (s.length === 0 || s.length > 4096) return false
  let parsed: URL
  try {
    parsed = new URL(s)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  // `new URL` accepts `http:example.com` (no slashes) — require a host.
  if (!parsed.hostname) return false
  return true
}

const TG_PROXY_LINK_PREFIX = 'tg://proxy?'

/**
 * True for the app-built `tg://proxy?server=…&port=…&secret=…` connect link.
 * The link is constructed in main from validated settings (the renderer never
 * passes a URL), but the scheme is asserted here anyway so a future refactor
 * cannot silently turn this call site into an arbitrary-scheme opener. Pure.
 */
export function isAllowedTgProxyLink(raw: unknown): boolean {
  if (typeof raw !== 'string') return false
  if (!raw.startsWith(TG_PROXY_LINK_PREFIX)) return false
  if (raw.length > 1024) return false
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'tg:') return false
    if (parsed.hostname !== 'proxy') return false
    const q = parsed.searchParams
    if (!q.get('server') || !q.get('port') || !q.get('secret')) return false
    return true
  } catch {
    return false
  }
}

/**
 * True when the main window itself may navigate to `raw`.
 * The app is a local SPA (`file://` bundle in prod, Vite dev server in dev):
 * top-level navigation to `http(s)` must never happen inside the window —
 * external pages open in the browser via `setWindowOpenHandler` instead.
 * `devServerUrl` is `process.env.ELECTRON_RENDERER_URL` (empty in prod).
 * Pure.
 */
export function isAllowedNavigationTarget(raw: unknown, devServerUrl: unknown): boolean {
  if (typeof raw !== 'string') return false
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return false
  }
  if (parsed.protocol === 'file:') return true
  if (typeof devServerUrl === 'string' && devServerUrl !== '') {
    try {
      const dev = new URL(devServerUrl)
      // Same-origin with the local Vite server (host + port, e.g.
      // `http://127.0.0.1:5174`); HMR/project files only.
      if (parsed.protocol === dev.protocol && parsed.host === dev.host) return true
    } catch {
      /* malformed dev URL — fall through to deny */
    }
  }
  return false
}
