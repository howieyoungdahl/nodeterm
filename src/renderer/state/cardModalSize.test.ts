// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import {
  parseCardModalSize,
  resolveModalSize,
  defaultModalSize,
  maxModalSize,
  clampAxis,
  CARD_MODAL_MIN_W,
  CARD_MODAL_MIN_H,
  CARD_MODAL_PREF_W,
  CARD_MODAL_PREF_H,
  CARD_MODAL_MARGIN_X,
  CARD_MODAL_MARGIN_Y,
  useCardModalSize,
  CARD_MODAL_SIZE_KEY
} from './cardModalSize'

describe('clampAxis', () => {
  it('clamps into range', () => {
    expect(clampAxis(500, 480, 900)).toBe(500)
    expect(clampAxis(100, 480, 900)).toBe(480)
    expect(clampAxis(2000, 480, 900)).toBe(900)
  })
  it('lets the max (fit-the-viewport) win when the viewport is smaller than the minimum', () => {
    expect(clampAxis(700, 480, 300)).toBe(300)
  })
})

describe('defaultModalSize', () => {
  it('uses the preferred size on a large viewport', () => {
    expect(defaultModalSize(2560, 1440)).toEqual({ width: CARD_MODAL_PREF_W, height: CARD_MODAL_PREF_H })
  })
  it('scales down to fit a small viewport (the core of the bug — no fixed box)', () => {
    const vw = 1000, vh = 700
    expect(defaultModalSize(vw, vh)).toEqual({ width: vw - CARD_MODAL_MARGIN_X, height: vh - CARD_MODAL_MARGIN_Y })
  })
})

describe('resolveModalSize', () => {
  const big = { vw: 2560, vh: 1440 }

  it('returns the scaling default when nothing is remembered', () => {
    expect(resolveModalSize({ width: null, height: null, maximized: false }, big.vw, big.vh))
      .toEqual(defaultModalSize(big.vw, big.vh))
  })

  it('honours an explicit remembered size', () => {
    expect(resolveModalSize({ width: 900, height: 620, maximized: false }, big.vw, big.vh))
      .toEqual({ width: 900, height: 620 })
  })

  it('clamps a remembered size that no longer fits the viewport', () => {
    // Saved on a big screen, reopened on a small one.
    const r = resolveModalSize({ width: 2000, height: 1200, maximized: false }, 1200, 800)
    expect(r).toEqual(maxModalSize(1200, 800))
  })

  it('never shrinks below the minimum', () => {
    expect(resolveModalSize({ width: 50, height: 50, maximized: false }, big.vw, big.vh))
      .toEqual({ width: CARD_MODAL_MIN_W, height: CARD_MODAL_MIN_H })
  })

  it('maximized fills the viewport regardless of the remembered size', () => {
    expect(resolveModalSize({ width: 700, height: 500, maximized: true }, big.vw, big.vh))
      .toEqual({ width: big.vw, height: big.vh })
  })
})

describe('parseCardModalSize', () => {
  it('treats missing / garbage as no memory', () => {
    expect(parseCardModalSize(null)).toEqual({ width: null, height: null, maximized: null })
    expect(parseCardModalSize('not json')).toEqual({ width: null, height: null, maximized: null })
  })
  it('rejects non-positive dimensions but keeps the flag', () => {
    expect(parseCardModalSize(JSON.stringify({ width: 0, height: -5, maximized: true })))
      .toEqual({ width: null, height: null, maximized: true })
  })
  it('round-trips a real size', () => {
    expect(parseCardModalSize(JSON.stringify({ width: 900, height: 620, maximized: false })))
      .toEqual({ width: 900, height: 620, maximized: false })
  })
})

describe('useCardModalSize store', () => {
  beforeEach(() => {
    localStorage.clear()
    useCardModalSize.setState({ width: null, height: null, maximized: false })
  })
  it('remember() persists the size and clears maximized', () => {
    useCardModalSize.setState({ maximized: true })
    useCardModalSize.getState().remember(910, 640)
    expect(useCardModalSize.getState()).toMatchObject({ width: 910, height: 640, maximized: false })
    expect(parseCardModalSize(localStorage.getItem(CARD_MODAL_SIZE_KEY))).toEqual({ width: 910, height: 640, maximized: false })
  })
  it('setMaximized() persists the flag and keeps the last size', () => {
    useCardModalSize.getState().remember(910, 640)
    useCardModalSize.getState().setMaximized(true)
    expect(parseCardModalSize(localStorage.getItem(CARD_MODAL_SIZE_KEY))).toEqual({ width: 910, height: 640, maximized: true })
  })
})
