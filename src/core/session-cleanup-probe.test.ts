import { describe, expect, it } from 'vitest'
import { CleanupActivity, cleanupProcessWork, completedCodexScreen, type CleanupProcess } from './session-cleanup-probe'
const screen = 'Review finished\n  Worked for 47m 50s • 23:08\n\n\n› Ask Codex to do anything\n\n GPT-6.1-Sol xhigh\n ? for shortcuts'
const p = (pid: number, ppid: number, command: string): CleanupProcess => ({ pid, ppid, command, birth: '1234' })
describe('cleanup completion and live work evidence', () => {
  it('never treats missing or resumed child history as an empty inventory', async () => {
    const a=new CleanupActivity(async (_, claim) => ({generation:'g',process:claim}))
    expect(a.covered('n','s','g')).toBe(false)
    a.observe({nodeId:'n',agentId:'codex',kind:'state',state:'done',sessionId:'s',verified:true})
    expect(a.covered('n','s','g')).toBe(false)
    a.observe({nodeId:'n',agentId:'codex',kind:'state',sessionId:'s',sessionPhase:'start',freshSession:false,verified:true})
    expect(a.covered('n','s','g')).toBe(false)
    a.observe({nodeId:'n',agentId:'codex',kind:'state',sessionId:'s',sessionPhase:'start',freshSession:true,verified:false})
    expect(a.covered('n','s','g')).toBe(false)
    a.observe({nodeId:'n',agentId:'codex',kind:'state',sessionId:'s',sessionPhase:'start',freshSession:true,verified:true})
    expect(a.covered('n','s','g')).toBe(false) // Legacy hooks have no sender process stamp.
    await a.observe({nodeId:'n',agentId:'codex',kind:'state',sessionId:'s',sessionPhase:'start',freshSession:true,verified:true,cleanupProcess:'10:1234'})
    expect(a.covered('n','s','g')).toBe(false) // Unknown/resumed first observation cannot be repaired by a label.
    await a.observe({nodeId:'n',agentId:'codex',kind:'state',sessionId:'fresh',sessionPhase:'start',freshSession:true,verified:true,cleanupProcess:'10:1234'})
    expect(a.covered('n','fresh','g')).toBe(true);expect(a.covered('n','other','g')).toBe(false)
    expect(a.covered('n','fresh','replacement')).toBe(false)
    a.observe({nodeId:'n',agentId:'codex',kind:'subagent-start',toolUseId:'child'})
    a.observe({nodeId:'n',agentId:'codex',kind:'session',sessionId:'s',sessionPhase:'end'})
    expect(a.pending('n')).toBe(1);expect(a.covered('n','s','g')).toBe(false)
    expect(new CleanupActivity().covered('n','s','g')).toBe(false)
  })
  it('does not enroll a delayed old startup against a replacement sender', async () => {
    const a=new CleanupActivity(async () => ({generation:'new',process:'11:9999'}))
    await a.observe({nodeId:'n',agentId:'codex',kind:'state',sessionId:'old',sessionPhase:'start',freshSession:true,verified:true,cleanupProcess:'10:1234'})
    expect(a.covered('n','old','new')).toBe(false)
  })
  it('fences an asynchronous startup witness when another lifecycle arrives', async () => {
    let finish!: (value:{generation:string;process:string})=>void
    const a=new CleanupActivity(() => new Promise(resolve => {finish=resolve}))
    const pending=a.observe({nodeId:'n',agentId:'codex',kind:'state',sessionId:'s',sessionPhase:'start',freshSession:true,verified:true,cleanupProcess:'10:1234'})
    expect(a.covered('n','s','g')).toBe(false)
    await a.observe({nodeId:'n',agentId:'codex',kind:'session',sessionId:'s',sessionPhase:'end'})
    finish({generation:'g',process:'10:1234'});await pending
    expect(a.covered('n','s','g')).toBe(false)
  })
  it('never reuses a repeated old startup and retains outstanding child IDs', async () => {
    const a=new CleanupActivity(async (_,claim)=>({generation:'g',process:claim}))
    const start={nodeId:'n',agentId:'codex' as const,kind:'state' as const,sessionId:'s',sessionPhase:'start' as const,freshSession:true,verified:true,cleanupProcess:'10:1234'}
    await a.observe(start);expect(a.covered('n','s','g')).toBe(true)
    await a.observe({nodeId:'n',agentId:'codex',kind:'subagent-start',toolUseId:'child'})
    await a.observe(start)
    expect(a.covered('n','s','g')).toBe(false);expect(a.pending('n')).toBe(1)
  })
  it.each(['', '0:1234', '10:bad', '10:1234\n', '10:1234:5678'])('refuses malformed process stamp %j', async cleanupProcess => {
    const a=new CleanupActivity(async (_,claim)=>({generation:'g',process:claim}))
    await a.observe({nodeId:'n',agentId:'codex',kind:'state',sessionId:'s',sessionPhase:'start',freshSession:true,verified:true,cleanupProcess})
    expect(a.covered('n','s','g')).toBe(false)
  })
  it('an unreadable foreground witness stays unknown', async () => {
    const a=new CleanupActivity(async ()=>{throw new Error('unreadable')})
    await a.observe({nodeId:'n',agentId:'codex',kind:'state',sessionId:'s',sessionPhase:'start',freshSession:true,verified:true,cleanupProcess:'10:1234'})
    expect(a.covered('n','s','g')).toBe(false)
  })
  it('requires authenticated identity even with a valid first sender stamp', async () => {
    const a=new CleanupActivity(async (_,claim)=>({generation:'g',process:claim}))
    await a.observe({nodeId:'n',agentId:'codex',kind:'state',sessionId:'s',sessionPhase:'start',freshSession:true,verified:false,cleanupProcess:'10:1234'})
    expect(a.covered('n','s','g')).toBe(false)
  })
  it('recognizes the completed Codex review with a live idle shell and persistent helper', () => {
    expect(completedCodexScreen(screen)).toBe(true)
    expect(cleanupProcessWork(10, [p(10, 1, 'bash'), p(11, 10, 'codex'), p(12, 11, 'codex-code-mode')], true)).toBe(0)
  })
  it.each([
    screen.replace('› Ask Codex to do anything', '› unfinished human draft'),
    screen.replace('Worked for 47m 50s • 23:08', 'Thinking (esc to interrupt)'),
    `${screen}\n Permission required: allow once`,
    'COMPLETE\n› Ask Codex to do anything',
    `${screen}\n› newer input`,
    screen.replace('› Ask Codex to do anything', '› waiting for input')
  ])('does not infer completion from title, silence, waiting or a draft', value => {
    expect(completedCodexScreen(value)).toBe(false)
  })
  it('protects genuine long jobs and nested tool processes even without output', () => {
    const rows = [p(10, 1, 'bash'), p(11, 10, 'codex'), p(12, 11, 'codex-code-mode'), p(13, 12, 'sleep')]
    expect(cleanupProcessWork(10, rows, true)).toBe(1)
    expect(cleanupProcessWork(10, rows, false)).toBe(3)
    expect(cleanupProcessWork(99, rows, true)).toBeNull()
    expect(cleanupProcessWork(10, [p(10, 1, 'bash'), p(11, 10, 'bash')], false)).toBe(1)
    expect(cleanupProcessWork(10, [p(10, 1, 'bash'), p(11, 10, 'codex'), p(12, 11, 'bash')], true)).toBe(1)
  })
  it('a completed parent retains unfinished subagents and timers', () => {
    const a = new CleanupActivity()
    a.observe({ nodeId: 'n', agentId: 'codex', kind: 'subagent-start', toolUseId: 't' })
    a.observe({ nodeId: 'n', agentId: 'codex', kind: 'state', state: 'done' })
    expect(a.pending('n')).toBe(1)
    a.observe({ nodeId: 'n', agentId: 'codex', kind: 'subagent-end', toolUseId: 't' })
    expect(a.pending('n')).toBe(0)
    a.observe({ nodeId: 'n', agentId: 'codex', kind: 'recurring' })
    a.observe({ nodeId: 'n', agentId: 'codex', kind: 'recurring', recurringEnd: true })
    expect(a.pending('n')).toBe(1) // Removal of an unspecified timer cannot establish no timers.
    expect(a.version()).toBe(5)
  })
})

it('scopes reviewed activity fencing to exact selected IDs while keeping the automatic global fence',()=> {
  const a=new CleanupActivity(), before=a.version(['selected']), global=a.version()
  void a.observe({nodeId:'retained',agentId:'codex',kind:'state',state:'working'})
  expect(a.version(['selected'])).toBe(before);expect(a.version()).not.toBe(global)
  void a.observe({nodeId:'selected',agentId:'codex',kind:'state',state:'working'})
  expect(a.version(['selected'])).not.toBe(before)
})
