/**
 * The browser-facing API for the settings card.
 *
 * The authorization seam is host-only — nothing about a sign-in can be driven
 * from the page directly — so this plugin carries its own small JSON surface
 * over the same loopback web server the rest of the app uses. The surface is
 * deliberately tiny and does exactly what the card offers: report status, start
 * or cancel a sign-in, choose the billed account, and sign one out.
 *
 * Every response is `no-store` and connection-closing, matching the sibling
 * plugin's choice for this deployment: short, infrequent JSON calls gain nothing
 * from pooling and a pooled half-open socket is a hung UI.
 *
 * @module dsh-chatgpt-provider/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { deleteAccount, listAccounts, planUsageEnabled, readGrant } from './accounts.ts'
import type { AccountView, CredentialStoreLike } from './accounts.ts'
import { revokeSession } from './oauth.ts'
import type { AttemptView, SignInManager } from './signin.ts'

/** Everything the routes need from the plugin. */
export interface RouteDeps {
  credentials: () => CredentialStoreLike | undefined
  signIn: () => SignInManager | undefined
  /** The account a request currently bills. */
  activeAccountId: () => Promise<string | undefined>
  /** Persist the account selection through the settings section. */
  selectAccount: (accountId: string) => Promise<void>
  /** Report what the client module registry knows about the browser half. */
  clientModule: () => ClientModuleReport
  /** Report what the LLM registry knows about the provider route. */
  directory: () => DirectoryReport
  /** Report whether this plugin's settings section registered. */
  settingsSectionMounted: () => boolean
  /** Report why the settings section could not be registered, if it could not. */
  settingsSectionError: () => string | undefined
  /** Report why the provider route could not be registered, if it could not. */
  mountError: () => string | undefined
  /** Report the settings address this plugin declares, and what the service serves. */
  settingsNamespaces: () => { declared: string; available: string[] }
  /** Report the account's raw model listing next to what is displayed. */
  catalog: () => Promise<{ displayed: number; reported: { id: string; visibility?: string }[] } | undefined>
  /**
   * Send one small real request through the provider, so the card can prove the
   * credential actually works instead of only reporting that it is stored.
   */
  selfTest: () => Promise<SelfTestResult>
  onNotice: (message: string) => void
}

/** Outcome of one end-to-end probe request. */
export interface SelfTestResult {
  /** Whether a model answered. */
  ok: boolean
  /** The model that answered. */
  model?: string
  /** The reply text, trimmed for display. */
  text?: string
  /** Reported token usage, when the provider disclosed it. */
  usage?: { inputTokens: number; outputTokens: number }
  /** Why the probe failed, when it did. */
  error?: string
}

/** The status document the card renders from. */
export interface ChatGptStatus {
  /** True when at least one account is saved and the credential seam is mounted. */
  signedIn: boolean
  accounts: AccountView[]
  activeAccountId?: string
  /** Whether the active account's grant authorizes ChatGPT plan usage. */
  planEnabled: boolean
  /** The in-flight or last attempt, when there is one. */
  attempt?: AttemptView
  /** True when the composition mounts no credential service at all. */
  credentialsMissing: boolean
  /**
   * What the client module registry knows about this plugin's browser half.
   *
   * The settings card is contributed through that registry, and an extension
   * area with no registrant renders **nothing at all** — no error, no empty
   * state. So when the card does not appear, this is the first question worth
   * answering, and it cannot be answered from the browser.
   */
  clientModule: ClientModuleReport
  /** What the LLM registry knows about this plugin's provider route. */
  directory: DirectoryReport
  /**
   * Whether this plugin's settings section actually registered.
   *
   * The Models page joins the provider directory against the served settings
   * namespaces, so a provider whose namespace never registered has no address
   * the page can read or write — and it renders no row for it.
   */
  settingsSectionMounted: boolean
  /** Why the settings section could not be registered, when it could not. */
  settingsSectionError?: string
  /**
   * Why the provider route could not be registered, when it could not.
   *
   * A mount step that throws would otherwise abort `apply()` and take this
   * endpoint down with it — leaving a broken provider and no way to ask why —
   * so the failure is caught, reported here, and the rest keeps serving.
   */
  mountError?: string
  /** The settings address this plugin's config is declared under. */
  settingsSettingsNamespace?: string
  /** Every settings address the service serves, for diagnosing a mismatch. */
  settingsNamespaces?: string[]
  /**
   * What the account's model listing reported, and what this adapter displays.
   *
   * A model missing from the picker is otherwise indistinguishable from a model
   * the account does not have, which makes "why can't I select X" unanswerable.
   */
  catalog?: { displayed: number; reported: { id: string; visibility?: string }[] }
}

/** Whether the provider route is live, dormant, and visible to configuration surfaces. */
export interface DirectoryReport {
  /** `listProviders()` contains this route: it can serve a request right now. */
  routeLive: boolean
  /** Every route `listProviders()` reports, in registration order. */
  routes: string[]
  /** `listConfigurableProviders()` contains this entry: configuration surfaces should offer it. */
  inDirectory: boolean
  /** How many entries the directory holds in total. */
  directorySize: number
  /** A one-line account of the verdict. */
  note: string
}

/** Whether the page will be told to load this plugin's browser half. */
export interface ClientModuleReport {
  /** The package name the registry is keyed by — not the plugin's `name`. */
  packageName: string
  /** The registry resolved a bundle path for this package. */
  registered: boolean
  /** Resolved bundle path on disk, when it is registered. */
  path?: string
  /** The boot graph lists this package, so the page preloads it. */
  served: boolean
  /** The URL the page would fetch, when the graph lists it. */
  url?: string
  /**
   * What the same probe reports for a package known to ship a client half.
   * Without this control, a `false` from a probe that is itself wrong looks
   * exactly like a genuinely unregistered plugin.
   */
  control: { packageName: string; registered: boolean; served: boolean }
  /** A one-line account of the verdict. */
  note: string
}

/** Write one JSON response and end the connection. */
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'close',
  })
  res.end(JSON.stringify(body))
}

/** Read and parse a JSON request body, bounded so a hostile client cannot balloon memory. */
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    total += buffer.byteLength
    if (total > 64 * 1024) throw new Error('request body too large')
    chunks.push(buffer)
  }
  if (total === 0) return {}
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof parsed !== 'object' || parsed === null) throw new Error('request body must be a JSON object')
  return parsed as Record<string, unknown>
}

/** Read an optional non-empty string field. */
function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Build the status document from live state. */
async function statusOf(deps: RouteDeps): Promise<ChatGptStatus> {
  const clientModule = deps.clientModule()
  const directory = deps.directory()
  const settingsSectionMounted = deps.settingsSectionMounted()
  const settingsSectionError = deps.settingsSectionError()
  const namespaces = deps.settingsNamespaces()
  const mountError = deps.mountError()
  const catalog = await deps.catalog()
  const credentials = deps.credentials()
  if (credentials === undefined) {
    return { signedIn: false, accounts: [], planEnabled: false, credentialsMissing: true,
      clientModule, directory, settingsSectionMounted,
      ...mountError === undefined ? {} : { mountError },
      ...settingsSectionError === undefined ? {} : { settingsSectionError },
      ...catalog === undefined ? {} : { catalog } }
  }
  const accounts = await listAccounts(credentials)
  const activeAccountId = await deps.activeAccountId()
  const active = accounts.find(account => account.id === activeAccountId)
  const attempt = deps.signIn()?.view()
  return {
    signedIn: accounts.length > 0,
    accounts,
    ...activeAccountId === undefined ? {} : { activeAccountId },
    planEnabled: active === undefined ? false : planUsageEnabled(active.scopes),
    ...attempt === undefined || attempt.state === 'idle' ? {} : { attempt },
    credentialsMissing: false,
    clientModule,
    directory,
    settingsSectionMounted,
    ...mountError === undefined ? {} : { mountError },
    ...settingsSectionError === undefined ? {} : { settingsSectionError },
    ...namespaces === undefined ? {} : {
      settingsSettingsNamespace: namespaces.declared,
      settingsNamespaces: namespaces.available,
    },
    ...catalog === undefined ? {} : { catalog },
  }
}

/**
 * Handle one request under `/chatgpt/api`.
 * @param req - the incoming request.
 * @param res - the response to own.
 * @param deps - live plugin state.
 * @param pathname - the request path, already parsed.
 */
export async function handleChatGptApi(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RouteDeps,
  pathname: string,
): Promise<void> {
  const method = req.method ?? 'GET'
  try {
    if (pathname === '/chatgpt/api/status' && method === 'GET') {
      json(res, 200, await statusOf(deps))
      return
    }

    if (pathname === '/chatgpt/api/signin' && method === 'POST') {
      const body = await readJson(req)
      const manager = deps.signIn()
      if (manager === undefined) {
        json(res, 503, { error: 'sign-in is unavailable in this composition' })
        return
      }
      const accountId = stringField(body, 'accountId')
      const attempt = await manager.start(accountId === undefined ? { kind: 'new' } : { kind: 'account', id: accountId })
      json(res, 200, { attempt })
      return
    }

    if (pathname === '/chatgpt/api/cancel' && method === 'POST') {
      const manager = deps.signIn()
      json(res, 200, { attempt: manager?.cancel() ?? { state: 'idle' } })
      return
    }

    if (pathname === '/chatgpt/api/selftest' && method === 'POST') {
      const result = await deps.selfTest()
      json(res, 200, result)
      return
    }

    if (pathname === '/chatgpt/api/select' && method === 'POST') {
      const body = await readJson(req)
      const accountId = stringField(body, 'accountId')
      const credentials = deps.credentials()
      if (accountId === undefined || credentials === undefined) {
        json(res, 400, { error: 'accountId is required' })
        return
      }
      if (await readGrant(credentials, accountId) === undefined) {
        json(res, 404, { error: 'no such account' })
        return
      }
      await deps.selectAccount(accountId)
      json(res, 200, await statusOf(deps))
      return
    }

    if (pathname === '/chatgpt/api/signout' && method === 'POST') {
      const body = await readJson(req)
      const accountId = stringField(body, 'accountId')
      const credentials = deps.credentials()
      if (accountId === undefined || credentials === undefined) {
        json(res, 400, { error: 'accountId is required' })
        return
      }
      const grant = await readGrant(credentials, accountId)
      if (grant === undefined) {
        json(res, 404, { error: 'no such account' })
        return
      }
      // Revocation is attempted first because the refresh token is the only
      // handle on the remote session, and it is about to be deleted. A failure
      // to revoke is reported rather than hidden: the docs are explicit that a
      // network failure is not proof of disconnection, and that the user can
      // always disconnect the app from ChatGPT settings.
      let revoked = false
      let revokeError: string | undefined
      try {
        await revokeSession({ clientId: grant.clientId, refreshToken: grant.refreshToken })
        revoked = true
      } catch (error) {
        revokeError = error instanceof Error ? error.message : String(error)
        deps.onNotice(`chatgpt: could not revoke the ChatGPT session on sign-out: ${revokeError}`)
      }
      await deleteAccount(credentials, accountId)
      json(res, 200, {
        ...await statusOf(deps),
        revoked,
        ...revokeError === undefined ? {} : { revokeError },
      })
      return
    }

    json(res, 404, { error: 'not-found' })
  } catch (error) {
    // A thrown handler must still answer: an unanswered request leaves the card
    // spinning with no way to learn what happened.
    json(res, 500, { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) })
  }
}
