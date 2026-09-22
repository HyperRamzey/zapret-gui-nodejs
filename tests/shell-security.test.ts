/** Unit tests for shell/navigation URL allowlists (offline-safe, pure). */
import { describe, it, expect } from 'vitest'
import { isAllowedExternalUrl, isAllowedTgProxyLink, isAllowedNavigationTarget } from '../src/main/shell-security'

describe('isAllowedExternalUrl', () => {
  it('allows http/https links used by the app', () => {
    expect(isAllowedExternalUrl('https://github.com/AvenCores/zapret-gui-nodejs/releases')).toBe(true)
    expect(isAllowedExternalUrl('http://127.0.0.1:5174/')).toBe(true)
    expect(isAllowedExternalUrl('https://www.youtube.com/')).toBe(true)
  })

  it('blocks dangerous and non-web schemes', () => {
    expect(isAllowedExternalUrl('file:///C:/Windows/System32/drivers/etc/hosts')).toBe(false)
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isAllowedExternalUrl('data:text/html,<h1>x</h1>')).toBe(false)
    expect(isAllowedExternalUrl('vbscript:msgbox(1)')).toBe(false)
    expect(isAllowedExternalUrl('tg://proxy?server=x&port=1&secret=dd00')).toBe(false)
    expect(isAllowedExternalUrl('shell:AppsFolder')).toBe(false)
  })

  it('rejects garbage and non-strings', () => {
    expect(isAllowedExternalUrl('')).toBe(false)
    expect(isAllowedExternalUrl('not a url')).toBe(false)
    expect(isAllowedExternalUrl('http:')).toBe(false)
    expect(isAllowedExternalUrl(undefined)).toBe(false)
    expect(isAllowedExternalUrl(null)).toBe(false)
    expect(isAllowedExternalUrl(42)).toBe(false)
    expect(isAllowedExternalUrl('x'.repeat(5000))).toBe(false)
  })
})

describe('isAllowedTgProxyLink', () => {
  it('accepts an app-built tg://proxy link', () => {
    expect(
      isAllowedTgProxyLink('tg://proxy?server=127.0.0.1&port=1443&secret=dd00000000000000000000000000000000')
    ).toBe(true)
  })

  it('rejects anything that is not our tg://proxy link', () => {
    expect(isAllowedTgProxyLink('https://example.com/')).toBe(false)
    expect(isAllowedTgProxyLink('tg://other?server=x&port=1&secret=dd00')).toBe(false)
    expect(isAllowedTgProxyLink('tg://proxy?server=x&port=1')).toBe(false) // no secret
    expect(isAllowedTgProxyLink('tg://proxy')).toBe(false)
    expect(isAllowedTgProxyLink('')).toBe(false)
    expect(isAllowedTgProxyLink(undefined)).toBe(false)
  })
})

describe('isAllowedNavigationTarget', () => {
  it('allows the packaged file:// bundle', () => {
    expect(isAllowedNavigationTarget('file:///C:/app/out/renderer/index.html', '')).toBe(true)
  })

  it('allows the local Vite dev server origin in dev', () => {
    const dev = 'http://127.0.0.1:5174/'
    expect(isAllowedNavigationTarget('http://127.0.0.1:5174/', dev)).toBe(true)
    expect(isAllowedNavigationTarget('http://127.0.0.1:5174/src/main.tsx', dev)).toBe(true)
  })

  it('blocks remote pages inside the privileged window', () => {
    const dev = 'http://127.0.0.1:5174/'
    expect(isAllowedNavigationTarget('https://example.com/', '')).toBe(false)
    expect(isAllowedNavigationTarget('https://example.com/', dev)).toBe(false)
    expect(isAllowedNavigationTarget('http://127.0.0.1:9999/evil', dev)).toBe(false) // wrong port
    expect(isAllowedNavigationTarget('javascript:alert(1)', dev)).toBe(false)
    expect(isAllowedNavigationTarget('data:text/html,x', '')).toBe(false)
    expect(isAllowedNavigationTarget('', '')).toBe(false)
    expect(isAllowedNavigationTarget(undefined, '')).toBe(false)
  })
})
