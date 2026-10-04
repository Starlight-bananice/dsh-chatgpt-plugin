/**
 * Failure vocabulary for this adapter.
 *
 * The harness normalizes a thrown adapter error into a terminal `finish`
 * failure, and it prefers the error's own `failure` payload over its class —
 * that is how an adapter living outside the harness tree keeps a stable code,
 * since `instanceof HarnessError` cannot hold across package copies. Both own
 * data properties are therefore required, and the normalization trusts the
 * snapshot only when `failure.code` and `code` agree.
 *
 * Codes follow the provider-neutral conventions the harness documents:
 * `MISSING_CREDENTIAL`, `AUTH`, `QUOTA`, `RATE_LIMIT`, `UNSUPPORTED`,
 * `CONTEXT_WINDOW_EXCEEDED`, plus the ChatGPT-plan codes OpenAI publishes for
 * this route verbatim.
 *
 * @module dsh-chatgpt-provider/errors
 */

/** Serializable failure facts, in the shape the harness validates. */
export interface FailureFacts {
  message: string
  code: string
  status?: number
  providerRetryAfterMs?: number
  requestId?: string
}

/** An adapter failure carrying both a code and the snapshot the harness prefers. */
export class ChatGptError extends Error {
  /** Stable machine-routable code. */
  readonly code: string
  /** Own-property snapshot; must agree with {@link code} to be trusted. */
  readonly failure: FailureFacts

  constructor(message: string, code: string, extra: Omit<FailureFacts, 'message' | 'code'> = {}) {
    super(message)
    this.name = 'ChatGptError'
    this.code = code
    this.failure = Object.freeze({ message, code, ...extra })
  }
}

/**
 * The ChatGPT-plan codes OpenAI documents for this route, kept verbatim so the
 * harness's retry policy and the user-facing message can both name the exact
 * condition rather than a paraphrase.
 */
export const PLAN_CODES = {
  /** 403 — the account, workspace, or policy does not permit plan usage. */
  userNotEligible: 'subscription_sharing_user_not_eligible',
  /** 429 — an app-specific or plan usage limit is currently exhausted. */
  usageLimitExceeded: 'subscription_sharing_usage_limit_exceeded',
  /** 503 — availability could not be checked; retry later with backoff. */
  usageUnavailable: 'subscription_sharing_usage_unavailable',
  /** 400 — an input, tool, or model this route does not accept. */
  unsupportedCapability: 'subscription_sharing_unsupported_capability',
  /** 403 — wrong method or endpoint for this route. */
  routeNotSupported: 'subscription_sharing_route_not_supported',
  /** 401 — the subscriber context could not be validated; sign in again. */
  invalidUser: 'subscription_sharing_invalid_user',
  /** 503 — user or workspace information is temporarily unavailable. */
  userUnavailable: 'subscription_sharing_user_unavailable',
} as const

/** Provider request-id headers, in the order the docs give them. */
const REQUEST_ID_HEADERS = ['openai-request-id', 'x-request-id'] as const

/**
 * Map an HTTP failure from the Responses route onto a stable code.
 *
 * The ChatGPT-plan codes arrive as the response's `error.code`, and they are
 * preserved verbatim because retry policy depends on them: a usage limit (429)
 * and an availability blip (503) must not be conflated, and a not-eligible
 * refusal (403) must never be retried in a loop.
 * @param status - the HTTP status.
 * @param detail - the raw body text, used only to recover a provider code.
 * @returns the provider-neutral or verbatim code to surface.
 */
export function codeForStatus(status: number, detail: string): string {
  for (const known of Object.values(PLAN_CODES)) {
    if (detail.includes(known)) return known
  }
  if (detail.includes('chatpass_v2_scope_not_authorized')
    || detail.includes('chatpass_v2_invalid_authorization_context')) return 'AUTH'
  if (status === 401) return 'AUTH'
  if (status === 403) return 'AUTH'
  if (status === 404) return 'MODEL_NOT_FOUND'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400 || status === 422) {
    return /context|too long|too large|maximum/i.test(detail) ? 'CONTEXT_WINDOW_EXCEEDED' : 'INVALID_REQUEST'
  }
  if (status === 503 || status >= 500) return 'PROVIDER_UNAVAILABLE'
  return 'REQUEST_FAILED'
}

/**
 * Read a provider request id from a response, for diagnostics.
 * @param headers - the response headers.
 * @returns the id, or `undefined` when the provider sent none.
 */
export function requestIdOf(headers: Headers): string | undefined {
  for (const name of REQUEST_ID_HEADERS) {
    const value = headers.get(name)
    if (value !== null && value !== '') return value
  }
  return undefined
}

/**
 * Read the provider's `error.code` out of a body, without trusting its shape.
 * The docs warn that a pre-stream admission failure may instead return a bare
 * `{"detail":"..."}`, which is diagnostic text rather than a stable code.
 * @param text - the raw response body.
 * @returns the provider code when one is present and well-formed.
 */
export function providerCodeOf(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const error = (parsed as Record<string, unknown>)['error']
    if (typeof error !== 'object' || error === null) return undefined
    const code = (error as Record<string, unknown>)['code']
    return typeof code === 'string' && code !== '' ? code : undefined
  } catch {
    return undefined
  }
}

/**
 * Build the failure for one rejected HTTP response.
 * @param operation - a short verb naming what failed.
 * @param response - the rejected response.
 * @returns the error to throw.
 */
export async function httpFailure(operation: string, response: Response): Promise<ChatGptError> {
  const text = await response.text().catch(() => '')
  const requestId = requestIdOf(response.headers)
  const providerCode = providerCodeOf(text)
  // A documented ChatGPT-plan code wins over the status-derived guess, because
  // it is the code the docs tell a client to branch on.
  const code = providerCode !== undefined && Object.values(PLAN_CODES).includes(
    providerCode as (typeof PLAN_CODES)[keyof typeof PLAN_CODES])
    ? providerCode
    : codeForStatus(response.status, text)
  const retryAfter = response.headers.get('retry-after')
  const retryAfterSeconds = retryAfter === null ? Number.NaN : Number(retryAfter)
  return new ChatGptError(
    `ChatGPT ${operation} failed (HTTP ${String(response.status)}): ${text.slice(0, 500) || response.statusText}`,
    code,
    {
      status: response.status,
      ...Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? { providerRetryAfterMs: retryAfterSeconds * 1000 }
        : {},
      ...requestId === undefined ? {} : { requestId },
    },
  )
}
