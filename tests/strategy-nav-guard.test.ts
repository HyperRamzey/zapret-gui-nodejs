/** Navigation guard: leaving Strategies with an unconfirmed preview is blocked. */
import { describe, it, expect, beforeEach } from 'vitest'
import { useUi } from '../src/renderer/store'

beforeEach(() => {
  useUi.getState().setNavGuard(null)
  useUi.getState().setError(null)
  useUi.setState({ page: 'dashboard', selectAttention: 0 })
})

describe('strategy navigation guard', () => {
  it('blocks leaving the tab while the guard is set, error explains why', () => {
    const s = useUi.getState()
    s.setPage('strategies')
    s.setNavGuard('Confirm the strategy first')
    useUi.getState().setPage('dashboard')
    expect(useUi.getState().page).toBe('strategies')
    expect(useUi.getState().error).toBe('Confirm the strategy first')
    // The blocked attempt also pings the "Select" button (scroll + flash).
    expect(useUi.getState().selectAttention).toBe(1)
    useUi.getState().setPage('updates')
    expect(useUi.getState().selectAttention).toBe(2)
  })

  it('allows same-tab clicks while the guard is set', () => {
    const s = useUi.getState()
    s.setPage('strategies')
    s.setNavGuard('Confirm the strategy first')
    useUi.getState().setPage('strategies')
    expect(useUi.getState().page).toBe('strategies')
  })

  it('allows free navigation without a guard', () => {
    const s = useUi.getState()
    s.setPage('strategies')
    useUi.getState().setPage('dashboard')
    expect(useUi.getState().page).toBe('dashboard')
  })

  it('unlocks once the guard is cleared (strategy confirmed)', () => {
    const s = useUi.getState()
    s.setPage('strategies')
    s.setNavGuard('Confirm the strategy first')
    useUi.getState().setNavGuard(null)
    useUi.getState().setPage('dashboard')
    expect(useUi.getState().page).toBe('dashboard')
  })
})
