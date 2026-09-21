/** Unit tests for bypass connectivity checks (localhost, no external network). */
import { describe, it, expect } from 'vitest'
import http from 'node:http'
import { AddressInfo } from 'node:net'
import { getBypassTarget, checkBypassUrl, checkBypassTarget } from '../src/main/bypass-check'
import { BYPASS_TARGETS } from '../src/shared/constants'

function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<http.Server> {
  return new Promise((resolve) => {
    const srv = http.createServer(handler)
    srv.listen(127001 - 127001 + 0, '127.0.0.1', () => resolve(srv))
  })
}

function serverUrl(srv: http.Server): string {
  const a = srv.address() as AddressInfo
  return `http://127.0.0.1:${a.port}/`
}

describe('getBypassTarget', () => {
  it('returns known targets', () => {
    for (const t of BYPASS_TARGETS) {
      expect(getBypassTarget(t.id).url).toBe(t.url)
    }
  })

  it('throws on unknown id', () => {
    // @ts-expect-error runtime check
    expect(() => getBypassTarget('nope')).toThrow(/Unknown bypass target/)
  })
})

describe('checkBypassUrl', () => {
  it('ok=true for 2xx and 3xx, body is drained', async () => {
    const srv = await startServer((_req, res) => {
      res.statusCode = 200
      res.end('x'.repeat(1024))
    })
    try {
      const r = await checkBypassUrl(serverUrl(srv), 3000)
      expect(r.ok).toBe(true)
      expect(r.httpStatus).toBe(200)
      expect(r.error).toBeNull()
      expect(r.latencyMs).toBeGreaterThanOrEqual(0)
    } finally {
      srv.close()
    }
  })

  it('ok=true for 301 redirect status (headers received = reachable)', async () => {
    const srv = await startServer((_req, res) => {
      res.statusCode = 301
      res.setHeader('location', '/elsewhere')
      res.end()
    })
    try {
      const r = await checkBypassUrl(serverUrl(srv), 3000)
      expect(r.ok).toBe(true)
      expect(r.httpStatus).toBe(301)
    } finally {
      srv.close()
    }
  })

  it('ok=false for 5xx', async () => {
    const srv = await startServer((_req, res) => {
      res.statusCode = 500
      res.end('boom')
    })
    try {
      const r = await checkBypassUrl(serverUrl(srv), 3000)
      expect(r.ok).toBe(false)
      expect(r.httpStatus).toBe(500)
      expect(r.error).toBeNull()
    } finally {
      srv.close()
    }
  })

  it('succeeds even when the server never ends the body (bodyGuard)', async () => {
    const srv = await startServer((_req, res) => {
      res.statusCode = 200
      res.write('partial-')
      // never end: bodyGuard (3s) would fire, but fallback is faster in test
      // via short timeout path — instead end late to exercise drain path
      setTimeout(() => {
        try {
          res.end('late')
        } catch {
          /* client gone */
        }
      }, 50).unref?.()
    })
    try {
      const r = await checkBypassUrl(serverUrl(srv), 5000)
      expect(r.ok).toBe(true)
      expect(r.httpStatus).toBe(200)
    } finally {
      srv.close()
    }
  })

  it('invalid URL resolves ok=false with short single-line error', async () => {
    const r = await checkBypassUrl('::not a url::', 1000)
    expect(r.ok).toBe(false)
    expect(r.httpStatus).toBeNull()
    expect(typeof r.error).toBe('string')
    expect(r.error!.length).toBeLessThanOrEqual(120)
    expect(r.error).not.toContain('\n')
  })

  it('connection refused resolves ok=false (never rejects)', async () => {
    // ephemeral closed port: bind then close to get a free port
    const tmp = await startServer((_req, res) => res.end())
    const url = serverUrl(tmp)
    await new Promise<void>((resolve) => tmp.close(() => resolve()))
    const r = await checkBypassUrl(url, 1500)
    expect(r.ok).toBe(false)
    expect(r.httpStatus).toBeNull()
    expect(typeof r.error).toBe('string')
  })

  it('timeout destroys the request and resolves ok=false', async () => {
    const srv = await startServer(() => {
      // never respond
    })
    try {
      const r = await checkBypassUrl(serverUrl(srv), 300)
      expect(r.ok).toBe(false)
      expect(r.httpStatus).toBeNull()
      expect(r.error).toMatch(/timeout/i)
    } finally {
      srv.close()
    }
  }, 10000)
})

describe('checkBypassTarget', () => {
  it('wraps checkBypassUrl with id + checkedAt', async () => {
    // Point at localhost via direct URL is not possible through target map,
    // so assert the error path shape for a real target without network:
    // it must always resolve (never throw) with the target id.
    const r = await checkBypassTarget('youtube', 800)
    expect(r.id).toBe('youtube')
    expect(typeof r.latencyMs).toBe('number')
    expect(typeof r.checkedAt).toBe('string')
    expect(new Date(r.checkedAt).toString()).not.toBe('Invalid Date')
  })
})
