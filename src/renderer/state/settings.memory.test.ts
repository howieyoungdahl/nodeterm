// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'
import { useSettings } from './settings'

describe('renderer-memory settings migration at hydration', () => {
  const load = vi.fn<() => Promise<Settings>>()
  const save = vi.fn<(settings: Settings) => Promise<void>>()

  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window, 'nodeTerminal', {
      configurable: true,
      value: { settings: { load, save } }
    })
    useSettings.setState({ settings: DEFAULT_SETTINGS, hydrated: false })
    save.mockResolvedValue()
  })

  it('applies and persists the safer default even while an old server still returns 10 minutes', async () => {
    load.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      offscreenTerminalMinutes: 10,
      rendererMemoryPolicyMigrated: undefined
    } as unknown as Settings)

    await useSettings.getState().hydrate()

    expect(useSettings.getState()).toMatchObject({
      hydrated: true,
      settings: { offscreenTerminalMinutes: 1, rendererMemoryPolicyMigrated: true }
    })
    expect(save).toHaveBeenCalledOnce()
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ offscreenTerminalMinutes: 1, rendererMemoryPolicyMigrated: true })
    )
  })

  it('does not rewrite a stamped choice', async () => {
    load.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      offscreenTerminalMinutes: 10,
      rendererMemoryPolicyMigrated: true
    })

    await useSettings.getState().hydrate()

    expect(useSettings.getState().settings.offscreenTerminalMinutes).toBe(10)
    expect(save).not.toHaveBeenCalled()
  })
})
