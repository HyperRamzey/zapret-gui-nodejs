/** Unit tests for shared main-window messaging. */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { getAllWindows } = vi.hoisted(() => ({ getAllWindows: vi.fn() }))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows }
}))

import { win, safeSend } from '../src/main/window'

beforeEach(() => {
  getAllWindows.mockReset()
})

describe('win()', () => {
  it('returns null when no windows', () => {
    getAllWindows.mockReturnValue([])
    expect(win()).toBeNull()
  })

  it('returns the first window', () => {
    const fake = { id: 1 }
    getAllWindows.mockReturnValue([fake, { id: 2 }])
    expect(win()).toBe(fake)
  })
})

describe('safeSend()', () => {
  it('sends to a live window', () => {
    const send = vi.fn()
    getAllWindows.mockReturnValue([{ webContents: { isDestroyed: () => false, send } }])
    safeSend('zapret:ping', { a: 1 })
    expect(send).toHaveBeenCalledWith('zapret:ping', { a: 1 })
  })

  it('drops when window is gone', () => {
    const send = vi.fn()
    getAllWindows.mockReturnValue([])
    expect(() => safeSend('x')).not.toThrow()
    expect(send).not.toHaveBeenCalled()
  })

  it('drops when webContents is destroyed', () => {
    const send = vi.fn()
    getAllWindows.mockReturnValue([{ webContents: { isDestroyed: () => true, send } }])
    safeSend('x')
    expect(send).not.toHaveBeenCalled()
  })

  it('never throws when send throws (renderer gone mid-flight)', () => {
    getAllWindows.mockReturnValue([
      {
        webContents: {
          isDestroyed: () => false,
          send: () => {
            throw new Error('gone')
          }
        }
      }
    ])
    expect(() => safeSend('x', 1, 2)).not.toThrow()
  })

  it('never throws when getAllWindows throws', () => {
    getAllWindows.mockImplementation(() => {
      throw new Error('electron gone')
    })
    expect(() => safeSend('x')).not.toThrow()
  })
})
