/** Unit tests for localized diagnostic details. */
import { describe, it, expect, afterEach } from 'vitest'
import { formatDetail } from '../src/shared/i18n'
import {
  checkCyrillic,
  checkOneDrive,
  checkLinuxProxy,
  checkLinuxDns,
  findProxyEnv,
  parseResolvedConf,
  parseResolvConf,
  runLinuxDiagnostics
} from '../src/main/diagnostics'
import { isForeignEngineBinary } from '../src/main/strategy-updater'

describe('formatDetail', () => {
  it('substitutes params into the localized template', () => {
    expect(
      formatDetail('ru', {
        detail: 'fallback',
        detailKey: 'diag.detail.proxyOn',
        detailParams: { server: 'proxy.example:8080' }
      })
    ).toBe('Включён (proxy.example:8080) — проверьте, что он корректен, или отключите')
  })

  it('falls back to detail when the key is missing', () => {
    expect(formatDetail('en', { detail: 'raw english', detailKey: 'diag.detail.nope' as never })).toBe('raw english')
  })

  it('keeps unknown placeholders intact', () => {
    expect(
      formatDetail('en', { detail: 'x', detailKey: 'diag.detail.proxyOn', detailParams: {} })
    ).toBe('Enabled ({server}) — make sure it is valid or disable it')
  })
})

describe('detail wiring', () => {
  it('checkCyrillic carries key + path param', () => {
    const c = checkCyrillic({ installDir: 'C:\\запрет-test', appData: '' })
    expect(c.level).toBe('warn')
    expect(c.detailKey).toBe('diag.detail.cyrillicWarn')
    expect(formatDetail('ru', c)).toContain('C:\\запрет-test')
  })

  it('checkCyrillic ok path', () => {
    const c = checkCyrillic({ installDir: 'C:\\zapret', appData: '' })
    expect(c.level).toBe('ok')
    expect(formatDetail('ru', c)).toBe('Путь в порядке')
  })

  const OLD = process.env.OneDrive
  afterEach(() => {
    if (OLD === undefined) delete process.env.OneDrive
    else process.env.OneDrive = OLD
  })

  it('checkOneDrive detects installs inside OneDrive', () => {
    process.env.OneDrive = 'C:\\Users\\x\\OneDrive'
    const c = checkOneDrive({ installDir: 'C:\\Users\\x\\OneDrive\\zapret', appData: '' })
    expect(c.level).toBe('fail')
    expect(formatDetail('en', c)).toContain('OneDrive')
  })

  it('checkOneDrive ok path', () => {
    delete process.env.OneDrive
    const c = checkOneDrive({ installDir: 'C:\\zapret', appData: '' })
    expect(c.level).toBe('ok')
    expect(c.detailKey).toBe('diag.detail.ok')
  })
})

describe('linux proxy check', () => {
  it('findProxyEnv picks the first non-empty var', () => {
    expect(findProxyEnv({})).toBeNull()
    expect(findProxyEnv({ HTTP_PROXY: '  ' })).toBeNull()
    expect(findProxyEnv({ http_proxy: 'http://127.0.0.1:8080' })).toEqual({
      name: 'http_proxy',
      value: 'http://127.0.0.1:8080'
    })
    // HTTPS_PROXY wins over HTTP_PROXY (ordered).
    expect(findProxyEnv({ HTTP_PROXY: 'http://a:1', HTTPS_PROXY: 'http://b:2' })?.name).toBe('HTTPS_PROXY')
  })

  it('warns on env proxy with server param', async () => {
    const c = await checkLinuxProxy({ https_proxy: 'http://proxy.example:8080' }, null)
    expect(c.level).toBe('warn')
    expect(c.detailKey).toBe('diag.detail.proxyOn')
    expect(formatDetail('ru', c)).toContain('proxy.example:8080')
  })

  it('warns on GNOME manual proxy', async () => {
    const c = await checkLinuxProxy({}, { mode: 'manual', server: 'corp-proxy:3128' })
    expect(c.level).toBe('warn')
    expect(formatDetail('en', c)).toContain('corp-proxy:3128')
  })

  it('is ok when nothing is configured', async () => {
    const c = await checkLinuxProxy({}, null)
    expect(c.level).toBe('ok')
    expect(c.detailKey).toBe('diag.detail.disabled')
  })
})

describe('linux dns check', () => {
  it('parseResolvedConf takes the last uncommented value', () => {
    expect(parseResolvedConf('[Resolve]\n#DNSOverTLS=yes\nDNSOverTLS=no\n')).toBe('no')
    expect(parseResolvedConf('; comment\nDNSOverTLS=strict\n')).toBe('strict')
    expect(parseResolvedConf('[Resolve]\nDNS=8.8.8.8\n')).toBeNull()
  })

  it('parseResolvConf extracts deduplicated nameservers', () => {
    expect(parseResolvConf('# comment\nnameserver 8.8.8.8\nnameserver 8.8.8.8\nnameserver 1.1.1.1\n')).toEqual([
      '8.8.8.8',
      '1.1.1.1'
    ])
    expect(parseResolvConf('')).toEqual([])
  })

  it('is ok with systemd-resolved DoT', () => {
    const c = checkLinuxDns({ resolvedDot: 'strict', resolvServers: ['127.0.0.53'] })
    expect(c.level).toBe('ok')
    expect(c.detailKey).toBe('diag.detail.dnsOk')
  })

  it('warns otherwise with resolvers listed (ru + en templates)', () => {
    const c = checkLinuxDns({ resolvedDot: null, resolvServers: ['192.168.1.1'] })
    expect(c.level).toBe('warn')
    expect(c.detailKey).toBe('diag.detail.dnsWarnLinux')
    expect(formatDetail('en', c)).toContain('192.168.1.1')
    const ru = formatDetail('ru', c)
    expect(ru).toContain('192.168.1.1')
    expect(ru).not.toContain('{servers}')
    // Opportunistic is not a guarantee — still warn.
    expect(checkLinuxDns({ resolvedDot: 'opportunistic', resolvServers: [] }).level).toBe('warn')
    expect(formatDetail('en', checkLinuxDns({ resolvedDot: null, resolvServers: [] }))).toContain('n/a')
  })
})

describe('foreign engine binaries', () => {
  afterEach(() => {
    delete process.env.TEST_PLATFORM
  })

  it('flags Windows binaries on linux, nfqws on win32', () => {
    process.env.TEST_PLATFORM = 'linux'
    expect(isForeignEngineBinary('winws.exe')).toBe(true)
    expect(isForeignEngineBinary('WinDivert64.sys')).toBe(true)
    expect(isForeignEngineBinary('cygwin1.dll')).toBe(true)
    expect(isForeignEngineBinary('nfqws')).toBe(false)
    expect(isForeignEngineBinary('quic_initial.bin')).toBe(false)
    process.env.TEST_PLATFORM = 'win32'
    expect(isForeignEngineBinary('nfqws')).toBe(true)
    expect(isForeignEngineBinary('winws.exe')).toBe(false)
  })
})

describe('runLinuxDiagnostics', () => {
  it('returns 8 uniquely-id checks including proxy and dns', async () => {
    const checks = await runLinuxDiagnostics('/tmp')
    expect(checks).toHaveLength(8)
    const ids = checks.map((c) => c.id)
    expect(new Set(ids).size).toBe(8)
    expect(ids).toContain('proxy')
    expect(ids).toContain('dns')
    for (const c of checks) {
      expect(['ok', 'warn', 'fail']).toContain(c.level)
    }
  })
})
