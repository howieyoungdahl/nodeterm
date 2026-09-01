import { describe, it, expect } from 'vitest'
import type { ClaudeAccount, ObservedClaudeAccount } from '@shared/types'
import {
  accountChipFor,
  accountKey,
  configDirLabel,
  distinctAccountKeys,
  effectiveAccountId,
  hasMultipleAccountKeys,
  SYSTEM_ACCOUNT_KEY,
  configDirsMatch,
  resolveObserved,
  unlinkedConfigDirs
} from './accountChip'

const acct = (over: Partial<ClaudeAccount> = {}): ClaudeAccount => ({
  id: 'a1',
  label: 'work@example.com',
  email: 'work@example.com',
  createdAt: 0,
  ...over
})

const observed = (over: Partial<ObservedClaudeAccount> = {}): ObservedClaudeAccount => ({
  configDir: '/home/me/.claude',
  accountId: null,
  known: true,
  ...over
})

const system = observed()
const managed = observed({ configDir: '/data/claude-accounts/a1', accountId: 'a1' })
const unlinked = observed({ configDir: '/home/me/.claude-2', accountId: null, known: false })

describe('effectiveAccountId (D5)', () => {
  it('prefers the node\u2019s own account over the observed one', () => {
    // Launch identity is what the env actually injected; an observation cannot outrank it.
    expect(effectiveAccountId('a1', managed)).toBe('a1')
    expect(effectiveAccountId('a1', system)).toBe('a1')
  })

  it('falls back to a KNOWN observed account for a node created without one', () => {
    expect(effectiveAccountId(undefined, managed)).toBe('a1')
  })

  it('resolves to nothing for the system account and for an unknown dir', () => {
    // Both must read the system account's transcripts, not a stranger's.
    expect(effectiveAccountId(undefined, system)).toBeUndefined()
    expect(effectiveAccountId(undefined, unlinked)).toBeUndefined()
    expect(effectiveAccountId(undefined, undefined)).toBeUndefined()
  })
})

describe('accountKey (D6)', () => {
  it('keys the system account as "sys" only when it is actually observed', () => {
    expect(accountKey(undefined, system)).toBe(SYSTEM_ACCOUNT_KEY)
    // Unobserved is NOT the system account: a plain shell nobody ran claude in must not count as
    // a second identity, or one open terminal would chip every pane on the canvas.
    expect(accountKey(undefined, undefined)).toBeNull()
  })

  it('keys a managed/linked account by id, from either source', () => {
    expect(accountKey('a1', undefined)).toBe('a1')
    expect(accountKey(undefined, managed)).toBe('a1')
  })

  it('keys an unlinked dir by its path', () => {
    expect(accountKey(undefined, unlinked)).toBe('ext:/home/me/.claude-2')
    // Two different unlinked dirs are two identities.
    expect(accountKey(undefined, observed({ configDir: '/home/me/.claude-3', known: false })))
      .toBe('ext:/home/me/.claude-3')
  })

  it('refuses to key an unknown observation with no dir', () => {
    expect(accountKey(undefined, observed({ configDir: '', known: false }))).toBeNull()
  })
})

describe('distinctAccountKeys', () => {
  it('counts identities and ignores unknown nodes', () => {
    const keys = distinctAccountKeys([
      { observed: system },
      { observed: system },
      { observed: unlinked },
      { dataAccountId: 'a1' },
      {} // an unobserved plain terminal contributes nothing
    ])
    expect([...keys].sort()).toEqual(['a1', 'ext:/home/me/.claude-2', 'sys'])
  })
})

describe('hasMultipleAccountKeys (the selector form)', () => {
  it('is false while one identity is in play', () => {
    expect(hasMultipleAccountKeys({ n1: { account: system }, n2: { account: system } })).toBe(false)
    expect(hasMultipleAccountKeys({ n1: {}, n2: {} })).toBe(false)
  })

  it('is true once a second identity appears — the real two-logins case', () => {
    // ~/.claude in one pane, ~/.claude-2 in another: exactly what the feature exists for.
    expect(hasMultipleAccountKeys({ n1: { account: system }, n2: { account: unlinked } })).toBe(true)
  })

  it('counts THIS node\u2019s creation-time account too', () => {
    // The store only holds observed accounts, so a managed node that has posted no hook yet is
    // only visible through its own `data.accountId`.
    expect(hasMultipleAccountKeys({ n1: { account: system } }, 'a1')).toBe(true)
    expect(hasMultipleAccountKeys({ n1: { account: managed } }, 'a1')).toBe(false)
  })
})

describe('configDirLabel', () => {
  it('names a POSIX dir by its last segment, trailing slash or not', () => {
    expect(configDirLabel('/home/me/.claude-2')).toBe('.claude-2')
    expect(configDirLabel('/home/me/.claude-2/')).toBe('.claude-2')
  })

  it('names a Windows-shaped dir by its last segment', () => {
    // Windows is a delivery target and an SSH node can report a remote path either way.
    expect(configDirLabel('C:\\Users\\me\\.claude-2')).toBe('.claude-2')
    expect(configDirLabel('\\\\server\\share\\.claude-2')).toBe('.claude-2')
  })

  it('keeps a POSIX backslash as filename text, not as a separator', () => {
    // A backslash is legal in a POSIX filename; splitting on it would mislabel the dir.
    expect(configDirLabel('/home/me/weird\\name')).toBe('weird\\name')
  })

  it('falls back to the whole string when there is no segment', () => {
    expect(configDirLabel('/')).toBe('/')
  })
})

describe('accountChipFor (D6 visibility, D7 unlinked naming)', () => {
  const accounts = [acct(), acct({ id: 'a2', label: 'personal', email: undefined, configDir: '/home/me/.claude-2' })]

  it('shows no chip for a system node while one identity is in play', () => {
    expect(accountChipFor({ observed: system, accounts, multiple: false })).toBeNull()
  })

  it('shows the system chip once a second identity is in play', () => {
    const chip = accountChipFor({
      observed: system,
      accounts,
      systemLabel: '',
      systemEmail: 'me@example.com',
      multiple: true
    })
    expect(chip).toEqual({
      short: 'me',
      tooltip: 'me@example.com — system Claude account (~/.claude)',
      kind: 'system'
    })
  })

  it('prefers the user\u2019s own system label over the detected email', () => {
    expect(
      accountChipFor({ observed: system, accounts, systemLabel: 'Personal', systemEmail: 'me@x.com', multiple: true })
        ?.short
    ).toBe('Personal')
  })

  it('chips a managed account whatever the count — the exception is what must be seen', () => {
    expect(accountChipFor({ dataAccountId: 'a1', accounts, multiple: false })).toEqual({
      short: 'work',
      tooltip: 'work@example.com (work@example.com)',
      kind: 'managed'
    })
  })

  it('marks an account that carries a linked config dir as linked', () => {
    expect(accountChipFor({ dataAccountId: 'a2', accounts, multiple: false })).toEqual({
      short: 'personal',
      tooltip: 'personal',
      kind: 'linked'
    })
  })

  it('names an unlinked dir by its last segment and says how to link it', () => {
    // A dir NO account claims. (`unlinked` above is `.claude-2`, which `accounts` here has since
    // linked as `a2` — that case is the "linking flows through every reader" block below.)
    const stranger = observed({ configDir: '/home/me/.claude-7', known: false })
    expect(accountChipFor({ observed: stranger, accounts, multiple: false })).toEqual({
      short: '.claude-7',
      tooltip: 'Unlinked Claude config dir /home/me/.claude-7 — link it in Settings → Accounts',
      kind: 'unlinked'
    })
  })

  it('follows a dir that has since been LINKED to its account, with no new event', () => {
    // The smoke-test regression: the store still holds `{known:false}` from before the link.
    expect(accountChipFor({ observed: unlinked, accounts, multiple: false })).toEqual({
      short: 'personal',
      tooltip: 'personal',
      kind: 'linked'
    })
  })

  it('shows nothing for a node whose account is unknown', () => {
    expect(accountChipFor({ accounts, multiple: true })).toBeNull()
  })

  it('follows the observed account when the node was created without one', () => {
    // The plain-terminal case: nodeterm never launched this claude, so the chip is the only place
    // the identity shows up at all.
    expect(accountChipFor({ observed: managed, accounts, multiple: false })?.short).toBe('work')
  })
})

describe('unlinkedConfigDirs (Settings → Accounts “Detected config dirs”)', () => {
  it('lists each unknown dir once, sorted, and never a known one', () => {
    expect(
      unlinkedConfigDirs({
        n1: { account: unlinked },
        n2: { account: unlinked }, // same dir, two panes
        n3: { account: observed({ configDir: '/home/me/.claude-3', known: false }) },
        n4: { account: system }, // known: not a candidate
        n5: { account: managed },
        n6: {}
      })
    ).toEqual(['/home/me/.claude-2', '/home/me/.claude-3'])
  })

  it('drops a dir that is already linked', () => {
    expect(unlinkedConfigDirs({ n1: { account: unlinked } }, ['/home/me/.claude-2'])).toEqual([])
    // …and tolerates the undefined `configDir` every managed account has.
    expect(unlinkedConfigDirs({ n1: { account: unlinked } }, [undefined])).toEqual([
      '/home/me/.claude-2'
    ])
  })
})

// ── Follow-up 1: an observation classified BEFORE the user linked its dir ──────────────────────
// The hook server stamps `known:false` at POST time and a quiet pane may not post again for hours,
// so linking has to repaint from the renderer side or the chip lies until the next turn.
describe('resolveObserved (a dir linked since the observation)', () => {
  const linkedAcct = acct({ id: 'lnk', label: 'second', email: undefined, configDir: '/home/me/.claude-2' })

  it('upgrades an unknown dir to the account that now owns it', () => {
    expect(resolveObserved(unlinked, [linkedAcct])).toEqual({
      configDir: '/home/me/.claude-2',
      accountId: 'lnk',
      known: true
    })
  })

  it('leaves an unknown dir alone when nothing matches', () => {
    expect(resolveObserved(unlinked, [acct({ configDir: '/home/me/.claude-9' })])).toBe(unlinked)
    expect(resolveObserved(unlinked, [acct()])).toBe(unlinked) // a MANAGED account has no configDir
  })

  it('never downgrades a known observation', () => {
    // Core classified these against the managed layout; settings cannot outrank that.
    expect(resolveObserved(system, [linkedAcct])).toBe(system)
    expect(resolveObserved(managed, [linkedAcct])).toBe(managed)
  })
})

describe('configDirsMatch (one comparison, both sides normalized)', () => {
  it('ignores a trailing separator', () => {
    expect(configDirsMatch('/home/me/.claude-2/', '/home/me/.claude-2')).toBe(true)
  })

  it('is case- and separator-insensitive for Windows-shaped paths only', () => {
    expect(configDirsMatch('C:\\Users\\Me\\.claude-2', 'c:/users/me/.claude-2')).toBe(true)
    // POSIX: case and backslash are both significant filename text, so these are DIFFERENT dirs.
    expect(configDirsMatch('/home/me/.Claude-2', '/home/me/.claude-2')).toBe(false)
  })

  it('never matches on an absent dir (every managed account has none)', () => {
    expect(configDirsMatch(undefined, undefined)).toBe(false)
    expect(configDirsMatch('', '/home/me/.claude-2')).toBe(false)
  })
})

describe('linking flows through every reader of the observation', () => {
  const linkedAcct = acct({ id: 'lnk', label: 'second', email: undefined, configDir: '/home/me/.claude-2/' })

  it('gives the readers the account id (no new hook event needed)', () => {
    expect(effectiveAccountId(undefined, unlinked)).toBeUndefined()
    expect(effectiveAccountId(undefined, unlinked, [linkedAcct])).toBe('lnk')
  })

  it('keys the pane by account instead of by path', () => {
    expect(accountKey(undefined, unlinked)).toBe('ext:/home/me/.claude-2')
    expect(accountKey(undefined, unlinked, [linkedAcct])).toBe('lnk')
  })

  it('stops counting the linked pane as a second identity next to its own account', () => {
    // A node created under the account and a pane observed on its dir are ONE identity.
    expect(hasMultipleAccountKeys({ n1: { account: unlinked } }, 'lnk')).toBe(true)
    expect(hasMultipleAccountKeys({ n1: { account: unlinked } }, 'lnk', [linkedAcct])).toBe(false)
  })

  it('flips the chip to the account\u2019s own label and kind', () => {
    const chip = accountChipFor({ observed: unlinked, accounts: [linkedAcct], multiple: false })
    expect(chip).toEqual({ short: 'second', tooltip: 'second', kind: 'linked' })
  })

  it('leaves a dir nobody linked dashed and unlinked', () => {
    const chip = accountChipFor({
      observed: unlinked,
      accounts: [acct({ id: 'other', configDir: '/home/me/.claude-9' })],
      multiple: false
    })
    expect(chip?.kind).toBe('unlinked')
    expect(chip?.short).toBe('.claude-2')
  })

  it('drops the dir from the detected list the moment it is linked', () => {
    const byId = { n1: { account: unlinked } }
    expect(unlinkedConfigDirs(byId, ['/home/me/.claude-2/'])).toEqual([]) // trailing slash
    expect(unlinkedConfigDirs(byId, ['/home/me/.claude-9'])).toEqual(['/home/me/.claude-2'])
  })

  it('excludes a Windows-shaped linked dir whatever its case', () => {
    const byId = { n1: { account: observed({ configDir: 'C:\\Users\\Me\\.claude-2', known: false }) } }
    expect(unlinkedConfigDirs(byId, ['c:/users/me/.claude-2'])).toEqual([])
  })
})

describe('the system chip has nothing to truncate', () => {
  it('says "System" rather than the 10-char cut of the generic display', () => {
    // "System account" through the chip cap reads "System acc…", an ellipsis promising a longer
    // name that does not exist.
    const chip = accountChipFor({ observed: system, accounts: [], multiple: true })
    expect(chip?.short).toBe('System')
    expect(chip?.tooltip).toContain('System account')
  })
})
