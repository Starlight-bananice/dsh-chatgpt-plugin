/**
 * The ChatGPT-plan adapter: one provider route over OpenAI's Responses API,
 * authenticated by the SIWC OAuth access token.
 *
 * This is a duck-typed implementation of the harness's adapter contract rather
 * than a subclass of its `LlmAdapter` class: a plugin outside the harness tree
 * cannot rely on class identity across package copies, and the registry checks
 * behavior (route identity, non-empty name, a `stream()` method) rather than
 * `instanceof`. The shape of every returned value is the documented one.
 *
 * Transport failures and protocol violations **throw**, which the runtime
 * normalizes into a terminal failure; provider-reported failures that arrive
 * in-band — a usage limit surfacing mid-stream, for instance — end the stream
 * with `finish {kind:'error'}`, exactly as the adapter contract prescribes.
 *
 * @module dsh-chatgpt-provider/adapter
 */

import { createRequire } from 'node:module'
import type {
  GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmReasoningEffortInfo, LlmResolvedModelInfo,
  ResolvedRetryPolicy, StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { accessTokenFor, listAccounts } from './accounts.ts'
import type { CredentialStoreLike } from './accounts.ts'
import { fetchCatalog, OFFICIAL_API_BASE } from './catalog.ts'
import type { CatalogModel } from './catalog.ts'
import { KNOWN_EFFORTS, type Config } from './config.ts'
import { ChatGptError, httpFailure } from './errors.ts'
import { serializeRequest } from './serialize.ts'
import type { ResolvedImage, SerializeDeps } from './serialize.ts'
import { translateStream } from './stream.ts'

/** This package's own manifest is the source of the attribution version. */
const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

/**
 * The `User-Agent` this adapter sends. The harness requires every product
 * adapter to identify its application on provider requests, and this is the
 * same `product/version (+url)` form the shipped adapters use — it names this
 * plugin rather than the harness, because this plugin is the caller.
 */
const USER_AGENT = `dsh-chatgpt-provider/${version} (+https://github.com/Starlight-bananice/dsh-chatgpt-provider)`

/** The single provider route this plugin owns. */
export const PROVIDER = 'chatgpt'

/**
 * Codes this route is willing to retry, in the resolved policy the registry
 * captures at registration.
 *
 * The default harness set is widened with the two transient 503 conditions this
 * route documents — an availability check that could not run is explicitly
 * worth a bounded retry — and deliberately **excludes** every terminal plan
 * condition. That exclusion is the documented requirement, not a preference:
 * `subscription_sharing_usage_limit_exceeded` says to pause new requests, and
 * `subscription_sharing_user_not_eligible` says not to repeat the request or
 * loop through OAuth.
 */
const RETRY_POLICY: ResolvedRetryPolicy = Object.freeze({
  mode: 'normal',
  maxRetries: 5,
  retryableCodes: Object.freeze([
    'EMPTY_RESPONSE',
    'RATE_LIMIT',
    'SERVER',
    'TIMEOUT',
    'TRANSPORT',
    'PROVIDER_UNAVAILABLE',
    'REQUEST_FAILED',
    'STREAM_INCOMPLETE',
    'subscription_sharing_usage_unavailable',
    'subscription_sharing_user_unavailable',
  ]),
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  jitterRatio: 0.1,
})

/** How long a fetched catalog is reused before asking the account again. */
const CATALOG_TTL_MS = 5 * 60_000

/** What the adapter needs from the plugin that owns it. */
export interface ChatGptAdapterDeps {
  /** The current resolved configuration, read per call. */
  config: () => Config
  /** The credential seam, read per call so a settings change is seen at once. */
  credentials: () => CredentialStoreLike | undefined
  /** The record id of the account a request bills, or `undefined` when none is saved. */
  accountId: () => Promise<string | undefined>
  /** Resolve stored image bytes through the attachment seam. */
  readImage: (ref: ImageAttachmentRef, signal?: AbortSignal) => Promise<ResolvedImage>
  /** Report a decision worth an operator's attention. */
  onNotice: (message: string) => void
  /**
   * The API base this adapter calls. Production omits it and gets the official
   * one; the seam exists so the request path — headers, payload, streaming, and
   * image inlining — can be exercised end to end against a local server. Like
   * the OAuth endpoints, it is deliberately not user-configurable: a deployment
   * that could repoint it from a settings file could be talked into sending an
   * access token elsewhere.
   */
  apiBase?: () => string
}

/** One cached catalog listing, keyed by the account it was read for. */
interface CatalogCache {
  accountId: string
  at: number
  models: CatalogModel[]
}

/** The adapter instance handed to `ctx.llm.registerAdapter()`. */
export class ChatGptAdapter {
  private cache: CatalogCache | undefined

  constructor(private readonly deps: ChatGptAdapterDeps) {}

  /** Display metadata for the route; the id must equal the registered route. */
  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.deps.config().displayName ?? 'ChatGPT' }
  }

  /** The policy the registry captures for this route. */
  providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return RETRY_POLICY
  }

  /**
   * List the signed-in account's models.
   *
   * Advisory by contract: a listing failure degrades the picker rather than the
   * request path, so a transport error yields the configured fallback catalog
   * (or an empty list) instead of throwing into a selector.
   * @param _provider - this adapter's sole route.
   * @returns the models to offer, in the account's order.
   */
  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    const credentials = this.deps.credentials()
    if (credentials === undefined) return this.configuredOnly()
    const accountId = await this.deps.accountId().catch(() => undefined)
    if (accountId === undefined) return []
    const cached = this.cache
    if (cached !== undefined && cached.accountId === accountId && Date.now() - cached.at < CATALOG_TTL_MS) {
      return this.withConfigured(cached.models)
    }
    try {
      const { accessToken } = await accessTokenFor(credentials, accountId)
      const models = await fetchCatalog(accessToken, { base: this.base() })
      this.cache = { accountId, at: Date.now(), models }
      return this.withConfigured(models)
    } catch (error) {
      this.deps.onNotice(`chatgpt: could not read the account's model list; only the configured models are`
        + ` offered (${error instanceof Error ? error.message : String(error)})`)
      return this.configuredOnly()
    }
  }

  /**
   * Append the configured extras to the account's own listing.
   *
   * Configured entries come last and never displace a listed model: the account
   * is the authority on what it offers, and an extra is a deliberate addition
   * the listing simply does not mention.
   * @param listed - the models the account reported.
   * @returns the account's models followed by any configured extras.
   */
  private withConfigured(listed: readonly CatalogModel[]): LlmModelInfo[] {
    const seen = new Set(listed.map(model => model.slug))
    const info = listed.map(model => this.toInfo(model))
    for (const extra of this.deps.config().models ?? []) {
      if (seen.has(extra.id)) continue
      seen.add(extra.id)
      info.push({
        provider: PROVIDER,
        id: extra.id,
        name: extra.name ?? extra.id,
        inputModalities: ['text', 'image'],
      })
    }
    return info
  }

  /**
   * Describe one exact model.
   *
   * Context capacity is reported only when it is actually known — from a
   * cached listing or the configured catalog. Reporting a guessed window would
   * let compaction misjudge the budget, and the contract is explicit that an
   * absent field preserves unknown capacity rather than inviting a default.
   * @param provider - this adapter's sole route.
   * @param model - the exact model id.
   * @param signal - cancellation for any lookup.
   * @returns identity plus whatever capacity and reasoning metadata is known.
   */
  async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    if (signal?.aborted === true) throw new ChatGptError('chatgpt: model resolution was cancelled', 'ABORTED')
    const config = this.deps.config()
    const listed = this.cache?.models.find(entry => entry.slug === model)
    const configured = (config.models ?? []).find(entry => entry.id === model)
    const contextWindow = listed?.contextWindow ?? configured?.contextWindow
    const name = listed?.displayName ?? configured?.name ?? model
    const efforts = config.reasoningEfforts ?? ['off', 'low', 'medium', 'high']
    const defaultEffort = config.reasoningEffort
    return {
      provider,
      id: model,
      name,
      ...contextWindow === undefined ? {} : { context: { contextWindow } },
      reasoning: {
        efforts: efforts.filter(effort => (KNOWN_EFFORTS as readonly string[]).includes(effort))
          .map(effort => ({ id: effort as LlmReasoningEffortInfo['id'], name: effort })),
        ...defaultEffort === undefined ? {} : { defaultEffort: defaultEffort as LlmReasoningEffortInfo['id'] },
      },
    }
  }

  /**
   * Bind one exact model's metadata and the eventual dispatch to this
   * generation.
   *
   * Implemented rather than inherited (this adapter is duck-typed, not a
   * subclass): the registry's contract expects a dynamic adapter to resolve
   * metadata and hand back a stream entry point bound to the same generation, so
   * a configuration change landing between preparation and dispatch cannot pair
   * one generation's capabilities with another's endpoint. Everything this
   * adapter needs is read from a single closure over the live configuration, so
   * binding means resolving now and streaming through the same instance.
   * @param provider - this adapter's sole route.
   * @param model - the exact model id.
   * @param signal - cancellation for model resolution.
   * @returns the resolved metadata and the generation-bound stream entry point.
   */
  async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ model: LlmResolvedModelInfo; stream: (options: GenerateOptions) => AsyncIterable<StreamChunk> }> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: options => this.stream(options),
    }
  }

  /**
   * Stream one model call.
   * @param options - the harness's assembled request.
   * @returns the translated chunk stream.
   * @throws {ChatGptError} on a missing account, a rejected request, or an unusable response body.
   */
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const credentials = this.deps.credentials()
    if (credentials === undefined) {
      throw new ChatGptError(
        'chatgpt: this deployment mounts no credentials service, so a ChatGPT sign-in cannot be stored or read',
        'NO_CREDENTIAL_STORE')
    }
    const accountId = await this.deps.accountId()
    if (accountId === undefined) {
      throw new ChatGptError(
        'chatgpt: no ChatGPT account is signed in; open Settings → Models and choose "Continue with ChatGPT"',
        'MISSING_CREDENTIAL')
    }
    const { accessToken } = await accessTokenFor(credentials, accountId, options.signal)

    const config = this.deps.config()
    const serializeDeps: SerializeDeps = {
      readImage: this.deps.readImage,
      onNotice: this.deps.onNotice,
      maxImageBytes: config.maxImageBytes,
      maxInlineImageBytes: config.maxInlineImageBytes,
    }
    const body = await serializeRequest(options, serializeDeps)

    const response = await fetch(`${this.base()}/responses`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify(body),
      ...options.signal === undefined ? {} : { signal: options.signal },
    })
    if (!response.ok) throw await httpFailure('response request', response)
    if (response.body === null) {
      throw new ChatGptError('chatgpt: the response carried no body to stream', 'STREAM_UNAVAILABLE')
    }
    yield * translateStream(response.body, (error) => { this.deps.onNotice(error.message) })
  }

  /** The API base for this generation, read per call so a swap reaches the next request. */
  private base(): string {
    return this.deps.apiBase?.() ?? OFFICIAL_API_BASE
  }

  /** Map one catalog entry onto the harness's advisory model metadata. */
  private toInfo(model: CatalogModel): LlmModelInfo {
    return {
      provider: PROVIDER,
      id: model.slug,
      name: model.displayName,
      // Images ride the request as data URLs, so the route accepts them for
      // every model; whether a given model uses them is the model's business.
      inputModalities: ['text', 'image'],
    }
  }

  /** Just the configured extras, for a listing that could not be read. */
  private configuredOnly(): LlmModelInfo[] {
    return this.withConfigured([])
  }
}

/**
 * The account a request should bill.
 *
 * A configured id that is no longer saved falls back to the newest sign-in
 * rather than resolving to nothing: signing one account out while another
 * remains must not leave the provider unable to serve at all. The caller warns
 * when this happens, because the selection silently stopped meaning what it
 * said.
 * @param credentials - the credential seam, when one is mounted.
 * @param configured - the record id the settings section names, if any.
 * @returns the account to bill, or `undefined` when none is saved.
 */
export async function resolveAccountId(
  credentials: CredentialStoreLike | undefined,
  configured: string | undefined,
): Promise<string | undefined> {
  if (credentials === undefined) return undefined
  const accounts = await listAccounts(credentials)
  if (accounts.length === 0) return undefined
  if (configured !== undefined && configured !== '') {
    if (accounts.some(account => account.id === configured)) return configured
  }
  return accounts[0]?.id
}
