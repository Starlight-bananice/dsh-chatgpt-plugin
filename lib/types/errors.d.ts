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
    message: string;
    code: string;
    status?: number;
    providerRetryAfterMs?: number;
    requestId?: string;
}
/** An adapter failure carrying both a code and the snapshot the harness prefers. */
export declare class ChatGptError extends Error {
    /** Stable machine-routable code. */
    readonly code: string;
    /** Own-property snapshot; must agree with {@link code} to be trusted. */
    readonly failure: FailureFacts;
    constructor(message: string, code: string, extra?: Omit<FailureFacts, 'message' | 'code'>);
}
/**
 * The ChatGPT-plan codes OpenAI documents for this route, kept verbatim so the
 * harness's retry policy and the user-facing message can both name the exact
 * condition rather than a paraphrase.
 */
export declare const PLAN_CODES: {
    /** 403 — the account, workspace, or policy does not permit plan usage. */
    readonly userNotEligible: "subscription_sharing_user_not_eligible";
    /** 429 — an app-specific or plan usage limit is currently exhausted. */
    readonly usageLimitExceeded: "subscription_sharing_usage_limit_exceeded";
    /** 503 — availability could not be checked; retry later with backoff. */
    readonly usageUnavailable: "subscription_sharing_usage_unavailable";
    /** 400 — an input, tool, or model this route does not accept. */
    readonly unsupportedCapability: "subscription_sharing_unsupported_capability";
    /** 403 — wrong method or endpoint for this route. */
    readonly routeNotSupported: "subscription_sharing_route_not_supported";
    /** 401 — the subscriber context could not be validated; sign in again. */
    readonly invalidUser: "subscription_sharing_invalid_user";
    /** 503 — user or workspace information is temporarily unavailable. */
    readonly userUnavailable: "subscription_sharing_user_unavailable";
};
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
export declare function codeForStatus(status: number, detail: string): string;
/**
 * Read a provider request id from a response, for diagnostics.
 * @param headers - the response headers.
 * @returns the id, or `undefined` when the provider sent none.
 */
export declare function requestIdOf(headers: Headers): string | undefined;
/**
 * Read the provider's `error.code` out of a body, without trusting its shape.
 * The docs warn that a pre-stream admission failure may instead return a bare
 * `{"detail":"..."}`, which is diagnostic text rather than a stable code.
 * @param text - the raw response body.
 * @returns the provider code when one is present and well-formed.
 */
export declare function providerCodeOf(text: string): string | undefined;
/**
 * Build the failure for one rejected HTTP response.
 * @param operation - a short verb naming what failed.
 * @param response - the rejected response.
 * @returns the error to throw.
 */
export declare function httpFailure(operation: string, response: Response): Promise<ChatGptError>;
