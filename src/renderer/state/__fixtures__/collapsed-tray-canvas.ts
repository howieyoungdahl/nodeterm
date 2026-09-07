// A REAL captured canvas (2026-09-07): a spawn tray frame persisted with `collapsed: true` and
// the eight worker cards parented to it. Copied verbatim from the operator's `project.json` at the
// moment the overlap was reported — the members' saved relative positions are a clean grid, so
// every overlap the regression test finds is manufactured at render time by the frame's height.
//
// Two members are saved at y = -400. That is not authored geometry: it is `COLLAPSED_HEIGHT - 440`,
// the clamped position React Flow computed against the 40px frame, written back to disk by an
// ordinary autosave. Keep them — a fix that only stops NEW damage while leaving those two pinned
// to the bar has not fixed the canvas the user is looking at.

import type { CanvasNodeState } from '@shared/types'

/** The frame every member below is parented to. */
export const COLLAPSED_TRAY_ID = 'group-mtre8usv-e3b9399e'

export const COLLAPSED_TRAY_CANVAS: CanvasNodeState[] = [
  {
    "id": "group-mtr3cunh-0ae7e76a",
    "kind": "group",
    "position": {
      "x": 18218.80221172453,
      "y": -1731.5313695289458
    },
    "size": {
      "width": 1816,
      "height": 762
    },
    "title": "Intelligence smoothness",
    "color": "#0a84ff",
    "group": null,
    "collapsed": false
  },
  {
    "id": "group-mtre8usv-e3b9399e",
    "kind": "group",
    "position": {
      "x": 19235.284785343083,
      "y": -3284.2370421591363
    },
    "size": {
      "width": 3568,
      "height": 2278.753623188406
    },
    "title": "Alpha · recovered fleet workers",
    "color": "#32d74b",
    "group": null,
    "collapsed": true,
    "taskFrame": true
  },
  {
    "id": "sticky-mtr3avmx-1c55cea4",
    "kind": "sticky",
    "parentId": "group-mtr3cunh-0ae7e76a",
    "position": {
      "x": 28,
      "y": 534
    },
    "size": {
      "width": 240,
      "height": 200
    },
    "title": "Intelligence smoothness",
    "color": "#ffd60a",
    "group": null,
    "collapsed": false
  },
  {
    "id": "term-mtrdjcns-d91b2306",
    "kind": "terminal",
    "position": {
      "x": 17823.284785343083,
      "y": -2418.2370421591363
    },
    "size": {
      "width": 640,
      "height": 440
    },
    "title": "Terminal 22",
    "color": "#0a84ff",
    "group": null,
    "collapsed": false,
    "agentId": "claude"
  },
  {
    "id": "term-mtre6hss-f7286887",
    "kind": "terminal",
    "position": {
      "x": 18530.96594476337,
      "y": -2425.4834189707303
    },
    "size": {
      "width": 640,
      "height": 440
    },
    "title": "Alpha · recovered fleet",
    "color": "#32d74b",
    "group": null,
    "collapsed": false,
    "role": "worker",
    "agentId": "codex",
    "controlSize": "normal"
  },
  {
    "id": "term-mtre8n7e-42a14f8a",
    "kind": "terminal",
    "parentId": "group-mtre8usv-e3b9399e",
    "position": {
      "x": 28,
      "y": 866
    },
    "size": {
      "width": 640,
      "height": 440
    },
    "title": "Intelligence · recovered refinement",
    "color": "#ffd60a",
    "group": null,
    "collapsed": false,
    "role": "worker",
    "agentId": "codex",
    "controlSize": "normal"
  },
  {
    "id": "term-mtre8usv-d6d114c2",
    "kind": "terminal",
    "parentId": "group-mtre8usv-e3b9399e",
    "position": {
      "x": 748,
      "y": 866
    },
    "size": {
      "width": 640,
      "height": 440
    },
    "title": "Backlog · PR and issue closeout",
    "color": "#ff453a",
    "group": null,
    "collapsed": false,
    "role": "worker",
    "agentId": "codex",
    "controlSize": "normal"
  },
  {
    "id": "term-mtre91y7-4cc3e45e",
    "kind": "terminal",
    "parentId": "group-mtre8usv-e3b9399e",
    "position": {
      "x": 1468,
      "y": 866
    },
    "size": {
      "width": 640,
      "height": 440
    },
    "title": "PostHog · continue setup",
    "color": "#6ac4dc",
    "group": null,
    "collapsed": false,
    "role": "worker",
    "agentId": "codex",
    "controlSize": "normal"
  },
  {
    "id": "term-mtre98wy-39a5c2e7",
    "kind": "terminal",
    "parentId": "group-mtre8usv-e3b9399e",
    "position": {
      "x": 1934.6666666666679,
      "y": -400
    },
    "size": {
      "width": 640,
      "height": 440
    },
    "title": "Alerts · continue setup",
    "color": "#ff9f0a",
    "group": null,
    "collapsed": false,
    "role": "worker",
    "agentId": "codex",
    "controlSize": "normal"
  },
  {
    "id": "term-mtrea5yz-1a182f09",
    "kind": "terminal",
    "parentId": "group-mtre8usv-e3b9399e",
    "position": {
      "x": 916.0367919830023,
      "y": 524
    },
    "size": {
      "width": 440,
      "height": 320
    },
    "title": "Alpha · read-only observer (90s, 12h)",
    "color": "#0a84ff",
    "group": null,
    "collapsed": false,
    "role": "worker",
    "controlSize": "compact"
  },
  {
    "id": "term-mtrei2br-989b2d8a",
    "kind": "terminal",
    "parentId": "group-mtre8usv-e3b9399e",
    "position": {
      "x": 2188,
      "y": 866
    },
    "size": {
      "width": 640,
      "height": 440
    },
    "title": "Intelligence · Fable recovery review · R7",
    "color": "#d97757",
    "group": null,
    "collapsed": false,
    "role": "worker",
    "agentId": "claude",
    "controlSize": "normal"
  },
  {
    "id": "term-mtrf4okv-4135c840",
    "kind": "terminal",
    "position": {
      "x": 21421.36801447397,
      "y": -1948.7790818779852
    },
    "size": {
      "width": 640,
      "height": 440
    },
    "title": "Terminal 31",
    "color": "#ffd60a",
    "group": null,
    "collapsed": false,
    "agentId": "claude"
  },
  {
    "id": "term-mtrffiav-ada70f66",
    "kind": "terminal",
    "parentId": "group-mtre8usv-e3b9399e",
    "position": {
      "x": 2900.028985507244,
      "y": 62
    },
    "size": {
      "width": 640,
      "height": 440
    },
    "title": "PostHog · Claude setup",
    "color": "#d97757",
    "group": null,
    "collapsed": false,
    "role": "worker",
    "agentId": "claude",
    "controlSize": "normal"
  },
  {
    "id": "term-mtriwuv1-5efa4974",
    "kind": "terminal",
    "parentId": "group-mtre8usv-e3b9399e",
    "position": {
      "x": 1016.5507246376765,
      "y": -400
    },
    "size": {
      "width": 640,
      "height": 440
    },
    "title": "PostHog · Astra dashboard implementation",
    "color": "#ff9f0a",
    "group": null,
    "collapsed": false,
    "role": "worker",
    "agentId": "codex",
    "controlSize": "normal"
  }
] as CanvasNodeState[]
