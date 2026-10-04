/**
 * The Models-page card for the ChatGPT provider.
 *
 * It renders inside the provider card the Models page already draws for this
 * plugin's directory row: the page dispatches its `settings.models.provider-card`
 * extension area with the row's namespace as the key, and this component
 * answers for `chatgpt`.
 *
 * Deliberately self-contained. It imports no harness client package for values
 * (the bundle-purity rule forbids it) and describes the props it receives
 * structurally rather than from a package's type declarations, because the
 * running application ships compiled bundles with no declarations and its API
 * surface may be newer than any checkout on the machine. React is the only
 * runtime import, and the page already provides it.
 *
 * @module dsh-chatgpt-provider/client/card
 */

import { useCallback, useEffect, useRef, useState } from 'react'

/** One saved account, as `/chatgpt/api/status` reports it. */
interface Account {
  id: string
  subject: string
  email?: string
  clientId: string
  planEnabled: boolean
  expiresAt: number
  savedAt: string
}

/** The in-flight sign-in attempt, when there is one. */
interface Attempt {
  state: 'idle' | 'waiting' | 'exchanging' | 'completed' | 'failed' | 'cancelled'
  url?: string
  message?: string
  error?: string
  accountId?: string
}

/** The status document the card renders from. */
interface Status {
  signedIn: boolean
  accounts: Account[]
  activeAccountId?: string
  planEnabled: boolean
  attempt?: Attempt
  credentialsMissing: boolean
  /** Present on a sign-out reply when remote revocation was not confirmed. */
  revoked?: boolean
  revokeError?: string
  /** Present when a request was rejected before it reached a handler. */
  error?: string
}

/** Outcome of the probe request the Test button sends. */
interface SelfTest {
  ok: boolean
  model?: string
  text?: string
  usage?: { inputTokens: number; outputTokens: number }
  error?: string
}

/** The translation seat the slot registration synthesizes. */
export type Translate = (key: string, params?: Record<string, string | number>) => string

/** Props the Models page passes into this extension area. */
export interface ChatGptCardProps {
  t: Translate
  /** The card's directory row. */
  provider?: { provider: string; displayName: string; settingsNs: string }
  /** Whether any layer configures this provider. */
  configured?: boolean
  /** Whether the row's referenced api-key credential is configured. */
  keyConfigured?: boolean
}

/**
 * Call one API endpoint and parse its JSON reply.
 *
 * This never rejects. A transport failure is the most likely thing to happen in
 * practice (the host restarted, the port moved), and letting it escape would
 * leave the effect's promise unhandled with no way for the card to learn what
 * went wrong — so every failure becomes an `error` field the render path
 * already knows how to display.
 */
async function request<T extends { error?: string }>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/chatgpt/api/${path}`, {
      headers: { 'content-type': 'application/json' },
      ...init,
    })
  } catch (error) {
    return { error: `could not reach the host: ${error instanceof Error ? error.message : String(error)}` } as T
  }
  let text = ''
  try {
    text = await response.text()
  } catch {
    // A body that cannot be read is reported through the status line below.
  }
  try {
    return JSON.parse(text) as T
  } catch {
    return {
      error: `unexpected reply (HTTP ${String(response.status)}): ${text.slice(0, 200)}`,
    } as T
  }
}

/** Fetch the status document. */
function callApi(path: string, init?: RequestInit): Promise<Status> {
  return request<Status>(path, init)
}

/** How often an unsettled attempt is polled. */
const POLL_MS = 1500

/**
 * Render the ChatGPT sign-in card.
 * @param props - the slot's composed props, of which `t` is used.
 * @returns the card's element tree.
 */
export function ChatGptCard({ t }: ChatGptCardProps) {
  const [status, setStatus] = useState<Status | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [probe, setProbe] = useState<SelfTest | undefined>(undefined)
  const [probing, setProbing] = useState(false)
  // A URL is opened once per attempt: the attempt stays `waiting` for as long
  // as the human takes in the browser, so re-opening on every poll would spawn
  // a window per tick.
  const openedUrl = useRef<string | undefined>(undefined)

  const refresh = useCallback(async (): Promise<void> => {
    const next = await callApi('status')
    if (next.error !== undefined) setError(next.error)
    else setStatus(next)
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const attempt = status?.attempt
  const pending = attempt !== undefined && (attempt.state === 'waiting' || attempt.state === 'exchanging')

  // Poll only while an attempt is outstanding, and stop the moment it settles,
  // so an idle settings page issues no requests at all.
  useEffect(() => {
    if (!pending) return undefined
    const timer = setInterval(() => { void refresh() }, POLL_MS)
    return () => { clearInterval(timer) }
  }, [pending, refresh])

  // Open the authorization page as soon as an attempt produces one.
  useEffect(() => {
    const url = attempt?.url
    if (url === undefined || openedUrl.current === url) return
    openedUrl.current = url
    window.open(url, '_blank', 'noopener,noreferrer')
  }, [attempt?.url])

  const start = useCallback(async (accountId?: string): Promise<void> => {
    setBusy(true)
    setError(undefined)
    openedUrl.current = undefined
    try {
      const next = await callApi('signin', {
        method: 'POST',
        body: JSON.stringify(accountId === undefined ? {} : { accountId }),
      })
      if (next.error !== undefined) setError(next.error)
      await refresh()
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const cancel = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      await callApi('cancel', { method: 'POST', body: '{}' })
      await refresh()
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const signOut = useCallback(async (accountId: string): Promise<void> => {
    setBusy(true)
    try {
      const next = await callApi('signout', { method: 'POST', body: JSON.stringify({ accountId }) })
      if (next.revokeError !== undefined) setError(`${t('revokeWarning')}${next.revokeError}`)
      await refresh()
    } finally {
      setBusy(false)
    }
  }, [refresh, t])

  const select = useCallback(async (accountId: string): Promise<void> => {
    setBusy(true)
    try {
      const next = await callApi('select', { method: 'POST', body: JSON.stringify({ accountId }) })
      if (next.error !== undefined) setError(next.error)
      else setStatus(next)
    } finally {
      setBusy(false)
    }
  }, [])

  const runProbe = useCallback(async (): Promise<void> => {
    setProbing(true)
    setProbe(undefined)
    const result = await request<SelfTest & { error?: string }>('selftest', { method: 'POST', body: '{}' })
    // The status endpoints report failures as an `error` field; the probe
    // reports them as `{ok:false, error}`, so the two are reconciled here.
    setProbe(result.error !== undefined && result.ok !== false
      ? { ok: false, error: result.error }
      : result)
    setProbing(false)
  }, [])

  if (status === undefined) {
    // An error can arrive before any status does (the host is unreachable), and
    // returning the spinner alone here would hide it forever.
    return (
      <div className="cgpt-root">
        {error === undefined
          ? <span className="cgpt-muted">{t('loading')}</span>
          : <span className="cgpt-error">{error}</span>}
      </div>
    )
  }
  if (status.credentialsMissing) {
    return <div className="cgpt-root"><span className="cgpt-error">{t('noCredentials')}</span></div>
  }

  return (
    <div className="cgpt-root">
      <div className="cgpt-head">
        <span className="cgpt-title">{t('title')}</span>
        {status.planEnabled && <span className="cgpt-muted">· {t('usingPlan')}</span>}
      </div>

      {status.accounts.length === 0 && !pending && (
        <span className="cgpt-muted">{t('intro')}</span>
      )}

      {status.accounts.map(account => (
        <div key={account.id} className="cgpt-account">
          <span>
            {account.email ?? account.subject}
            {account.id === status.activeAccountId && <span className="cgpt-muted"> · {t('active')}</span>}
            {!account.planEnabled && <span className="cgpt-muted"> · {t('noPlan')}</span>}
          </span>
          <span className="cgpt-row">
            {account.id !== status.activeAccountId && (
              <button type="button" className="cgpt-button" disabled={busy}
                onClick={() => { void select(account.id) }}>{t('use')}</button>
            )}
            <button type="button" className="cgpt-button" disabled={busy}
              onClick={() => { void start(account.id) }}>{t('reauthorize')}</button>
            <button type="button" className="cgpt-button" disabled={busy}
              onClick={() => { void signOut(account.id) }}>{t('signOut')}</button>
          </span>
        </div>
      ))}

      {pending ? (
        <div className="cgpt-stack">
          <span>{attempt.state === 'exchanging' ? t('exchanging') : attempt.message ?? t('waiting')}</span>
          {attempt.url !== undefined && (
            <span className="cgpt-muted">
              {t('fallback')}
              <a className="cgpt-link" href={attempt.url} target="_blank" rel="noopener noreferrer">
                {t('fallbackLink')}
              </a>
            </span>
          )}
          <div className="cgpt-row">
            <button type="button" className="cgpt-button" disabled={busy} onClick={() => { void cancel() }}>
              {t('cancel')}
            </button>
          </div>
        </div>
      ) : (
        <div className="cgpt-row">
          <button type="button" className="cgpt-button cgpt-primary" disabled={busy}
            onClick={() => { void start() }}>
            {status.accounts.length === 0 ? t('continue') : t('different')}
          </button>
          <a className="cgpt-button" href="https://chatgpt.com/settings/usage"
            target="_blank" rel="noopener noreferrer">{t('manageUsage')}</a>
          {status.signedIn && (
            <button type="button" className="cgpt-button" disabled={busy || probing}
              onClick={() => { void runProbe() }}>{t('test')}</button>
          )}
        </div>
      )}

      {/* The probe is what turns "a credential is stored" into "this provider
          actually answers", so its result states the model and the usage too. */}
      {probing && <span className="cgpt-muted">{t('testing')}</span>}
      {probe !== undefined && (
        probe.ok ? (
          <span className="cgpt-muted">
            {t('testOk')}{probe.model}
            {probe.text !== undefined && probe.text !== '' ? ` · ${JSON.stringify(probe.text)}` : ''}
            {probe.usage !== undefined
              ? ` · ${String(probe.usage.inputTokens)} in / ${String(probe.usage.outputTokens)} out`
              : ''}
          </span>
        ) : (
          <span className="cgpt-error">{t('testFail')}{probe.error ?? 'unknown error'}</span>
        )
      )}

      {attempt?.state === 'failed' && attempt.error !== undefined && (
        <span className="cgpt-error">{attempt.error}</span>
      )}
      {attempt?.state === 'completed' && attempt.message !== undefined && (
        <span className="cgpt-muted">{attempt.message}</span>
      )}
      {error !== undefined && <span className="cgpt-error">{error}</span>}
    </div>
  )
}
