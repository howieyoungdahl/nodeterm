import { useEffect, useState } from 'react'
import { useSettings } from '../../../state/settings'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { Switch } from '@renderer/ui/Switch'
import { Button } from '@renderer/ui/Button'
import { SegmentedPill } from '@renderer/ui/SegmentedPill'
import { USAGE_PROVIDER_IDS, providerLabel } from '@shared/usage-limits'
import { AGENT_CONFIG } from '@shared/agents/config'
import {
  defaultProfileLabel,
  isPlausibleProfileDir,
  type ExternalProfileProvider,
  type ExternalUsageProfile
} from '@shared/external-profile'

const ROWS = {
  percentMode: {
    title: 'Usage percentages',
    keywords: ['usage', 'percent', 'used', 'remaining', 'left', 'display']
  },
  visibility: {
    title: 'Providers',
    keywords: [
      'usage',
      'provider',
      'show',
      'hide',
      'toggle',
      'claude',
      'remote',
      'ssh',
      'host',
      'codex',
      'deepseek',
      'gemini',
      'grok',
      'kimi',
      'minimax',
      'opencode',
      'pill',
      'indicator'
    ]
  },
  cookies: {
    title: 'Web-console sign-in',
    keywords: ['minimax', 'opencode', 'cookie', 'session', 'sign in', 'credential', 'paste']
  },
  profiles: {
    title: 'Other profiles',
    keywords: [
      'profile',
      'account',
      'second account',
      'claude-2',
      'codex-2',
      'directory',
      'external',
      'usage'
    ]
  }
}
const ENTRIES = Object.values(ROWS)

/** AGENT_CONFIG is keyed by builtin ids; billing-only providers fall through to the label table. */
function labelFor(provider: string): string {
  const agentLabel = (AGENT_CONFIG as Record<string, { label?: string } | undefined>)[provider]?.label
  return providerLabel(provider, agentLabel)
}

const PROVIDER_BLURBS: Record<string, string> = {
  claude: 'Session, weekly and per-model limits from your Claude subscription.',
  'claude-remote':
    "Limits for the Claude accounts on your connected SSH projects' hosts. Each read runs on the host itself over the existing connection — the credential never leaves it.",
  codex: 'Session and weekly limits from your ChatGPT (Codex) subscription.',
  deepseek:
    'Prepaid balance from the DeepSeek API key in your opencode credential store. DeepSeek publishes no quota windows, so this row shows an amount rather than a percentage.',
  gemini: 'Per-model hourly quota from the Gemini CLI sign-in.',
  grok: 'Weekly credits and monthly budget from the Grok CLI sign-in.',
  kimi: 'Session and weekly quota from the Kimi Code sign-in.',
  minimax: 'Per-model session quota — needs the cookie below.',
  opencode: 'Session, weekly and monthly usage — needs the cookie below.'
}

/**
 * Providers that publish no CLI credential — their quota lives behind a web console session, so
 * the user pastes a cookie. Each row is write-only: it can store or clear a value and can see
 * WHETHER one is stored, but the secret is never read back into the UI.
 */
const COOKIE_PROVIDER_ROWS = [
  {
    id: 'minimax',
    label: 'MiniMax',
    description:
      "MiniMax exposes no CLI credential, so its quota is read with your console session. Open platform.minimax.io/console/usage, copy the request's Cookie header from DevTools, and paste it here.",
    placeholder: 'Cookie: _token=…'
  },
  {
    id: 'opencode',
    label: 'opencode',
    description:
      'opencode publishes no usage API, so the numbers are read from your dashboard page. Open opencode.ai, copy the Cookie header from DevTools, and paste it here. Because this reads a page rather than an API, it can stop working when opencode changes their site — it will report an error rather than silently showing nothing.',
    placeholder: 'auth=…'
  }
] as const

function CookieProviderRow({
  id,
  label,
  description,
  placeholder,
  stored,
  onChange
}: {
  id: string
  label: string
  description: string
  placeholder: string
  stored: boolean
  onChange: (stored: boolean) => void
}): React.JSX.Element {
  const [value, setValue] = useState('')
  const save = async (next: string): Promise<void> => {
    onChange(await window.nodeTerminal.usage.setProviderCookie(id, next))
    // Never keep the secret in component state once it has been handed over.
    setValue('')
  }
  return (
    <FieldRow
      label={label}
      description={description}
      note={
        stored
          ? 'Stored in a file only your user can read, never in settings.json. It is not shown again — paste a fresh one when your session expires.'
          : 'This is a live session credential. It is stored in a 0600 file, not in settings.json, and is never read back into the UI.'
      }
      control={
        <div className="flex items-center gap-2">
          <input
            type="password"
            className="input w-64"
            placeholder={stored ? '•••••••• stored' : placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <Button onClick={() => void save(value)} disabled={!value.trim()}>
            Save
          </Button>
          {stored && <Button onClick={() => void save('')}>Clear</Button>}
        </div>
      }
    />
  )
}

/**
 * Add one existing profile directory to the usage panel.
 *
 * The field is a path the user types rather than a directory picker: this is a read-only row, and
 * a picker would imply selecting something nodeterm takes ownership of. It does not — nothing is
 * written to the directory, launched from it, or deleted, which is exactly what makes pointing one
 * at a profile the user already has safe.
 *
 * Validation is deliberately two-tier. This row only checks what it can see (an absolute path);
 * the authoritative check — inside `$HOME`, normalized, a real directory — runs in core at READ
 * time, because `settings.json` is hand-editable and a write-time check would guard the wrong event.
 */
function AddExternalProfile({
  onAdd
}: {
  onAdd: (profile: ExternalUsageProfile) => void
}): React.JSX.Element {
  const [provider, setProvider] = useState<ExternalProfileProvider>('claude')
  const [dir, setDir] = useState('')
  const [label, setLabel] = useState('')
  const trimmed = dir.trim()
  const plausible = isPlausibleProfileDir(trimmed)
  const submit = (): void => {
    if (!plausible) return
    onAdd({
      provider,
      dir: trimmed,
      label: label.trim() || defaultProfileLabel(trimmed)
    })
    setDir('')
    setLabel('')
  }
  return (
    <FieldRow
      label="Add a profile directory"
      description="An existing Claude or Codex profile you already use — ~/.claude-2, ~/.codex-2. Its usage appears in the panel. Display only: nodeterm never writes to it, launches from it, or deletes it."
      note={
        plausible
          ? 'Saved profiles show up in the pill at the bottom-left of the canvas.'
          : 'Enter an absolute path inside your home directory.'
      }
      control={
        <div className="flex items-center gap-2">
          <SegmentedPill
            value={provider}
            options={[
              { value: 'claude', label: 'Claude' },
              { value: 'codex', label: 'Codex' }
            ]}
            onChange={(v) => setProvider(v as ExternalProfileProvider)}
            ariaLabel="Profile provider"
          />
          <input
            className="input w-56"
            placeholder="~/.claude-2"
            value={dir}
            onChange={(e) => setDir(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
            }}
            spellCheck={false}
          />
          <input
            className="input w-32"
            placeholder="Label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            spellCheck={false}
          />
          <Button onClick={submit} disabled={!plausible}>
            Add
          </Button>
        </div>
      }
    />
  )
}

export function UsageSection({ isActive }: { isActive: boolean }): React.JSX.Element | null {
  const settings = useSettings((s) => s.settings)
  const update = useSettings((s) => s.update)

  const externalProfiles = settings.externalUsageProfiles ?? []
  const hidden = new Set(settings.hiddenUsageProviders)
  const setShown = (provider: string, shown: boolean): void => {
    const next = settings.hiddenUsageProviders.filter((p) => p !== provider)
    if (!shown) next.push(provider)
    update({ hiddenUsageProviders: next })
  }

  // Which cookie providers have one stored — state only; the values never reach the renderer.
  const [cookieStored, setCookieStored] = useState<Record<string, boolean>>({})
  useEffect(() => {
    if (!isActive) return
    let cancelled = false
    void window.nodeTerminal.usage.cookieProviders().then((v) => {
      if (!cancelled) setCookieStored(v)
    })
    return () => {
      cancelled = true
    }
  }, [isActive])

  return (
    <SettingsSection
      id="usage"
      title="Usage"
      description="Subscription limits shown in the pill at the bottom-left of the canvas. Hiding a provider is a display choice — credentials are untouched, so re-enabling is instant."
      isActive={isActive}
      searchEntries={ENTRIES}
    >
      <SearchableRow {...ROWS.percentMode}>
        <FieldRow
          label="Usage percentages"
          description="Whether provider limits and context meters show percentage used, percentage remaining, or (context meters only) raw token counts. Provider limits have no token count and fall back to Used."
          control={
            <SegmentedPill
              value={settings.usagePercentMode}
              options={[
                { value: 'used', label: 'Used' },
                { value: 'remaining', label: 'Remaining' },
                { value: 'tokens', label: 'Tokens' }
              ]}
              onChange={(v) => update({ usagePercentMode: v })}
              ariaLabel="Usage percentage display"
            />
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.visibility}>
        <div className="space-y-5">
          {USAGE_PROVIDER_IDS.map((id) => (
            <FieldRow
              key={id}
              label={`${labelFor(id)} usage`}
              description={PROVIDER_BLURBS[id] ?? ''}
              control={
                <Switch
                  checked={!hidden.has(id)}
                  onChange={(v) => setShown(id, v)}
                  ariaLabel={`Show ${labelFor(id)} usage`}
                />
              }
            />
          ))}
        </div>
      </SearchableRow>
      <SearchableRow {...ROWS.cookies}>
        <div className="space-y-5">
          {COOKIE_PROVIDER_ROWS.map((p) => (
            <CookieProviderRow
              key={p.id}
              {...p}
              stored={!!cookieStored[p.id]}
              onChange={(stored) => setCookieStored((m) => ({ ...m, [p.id]: stored }))}
            />
          ))}
        </div>
      </SearchableRow>
      <SearchableRow {...ROWS.profiles}>
        <div className="space-y-5">
          {externalProfiles.map((p) => (
            <FieldRow
              key={`${p.provider}:${p.dir}`}
              label={p.label}
              description={`${p.provider === 'claude' ? 'Claude' : 'Codex'} profile — ${p.dir}`}
              note="Read-only: usage is displayed from this directory. Nothing is written to it, launched from it, or deleted."
              control={
                <Button
                  onClick={() =>
                    update({
                      externalUsageProfiles: externalProfiles.filter((e) => e !== p)
                    })
                  }
                >
                  Remove
                </Button>
              }
            />
          ))}
          <AddExternalProfile
            onAdd={(profile) => update({ externalUsageProfiles: [...externalProfiles, profile] })}
          />
        </div>
      </SearchableRow>
    </SettingsSection>
  )
}
