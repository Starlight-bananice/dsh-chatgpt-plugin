/**
 * OpenAI "Sign in with ChatGPT" (SIWC) OAuth for open-source clients.
 *
 * Every constant and request shape here is taken from OpenAI's official
 * token-sharing documentation for OSS apps:
 *
 * - Authorization endpoint `https://auth.openai.com/api/accounts/authorize`,
 *   first-time registration with `client_id=dynamic_agent_client`.
 * - `agent_name_hint` is sent ONLY on initial dynamic registration; a
 *   reauthorization uses the issued `client_id` and omits it.
 * - The callback MUST be an HTTP loopback on `127.0.0.1` whose path is exactly
 *   `/auth/callback`; only the port may vary, and `localhost` is not a
 *   substitute for `127.0.0.1`.
 * - A new registration returns the issued `client_id` (`oaiapp_…`) on the
 *   callback; that value — never `dynamic_agent_client` — is what the code
 *   exchange, every later authorization, and every refresh use.
 * - The flow is a public client: no client secret exists at any step.
 *
 * @module dsh-chatgpt-provider/oauth
 */
/** Issuer every token in this flow must carry. */
export declare const ISSUER = "https://auth.openai.com";
/** The `resource` every authorization, exchange, and refresh must repeat. */
export declare const RESOURCE = "https://api.openai.com/v1";
/**
 * The endpoints one flow talks to.
 *
 * Production always uses {@link OFFICIAL_ENDPOINTS}; the seam exists so the
 * whole flow — authorization, callback, exchange, ID-token verification against
 * a real JWKS, refresh, revocation — can be exercised end to end against a local
 * server without a live ChatGPT account. It is deliberately not part of the
 * plugin's user-facing configuration: a deployment that could repoint the token
 * endpoint from a settings file could be talked into sending tokens elsewhere.
 */
export interface OAuthEndpoints {
    /** Authorization endpoint the browser is sent to. */
    authorize: string;
    /** Token endpoint for the code exchange and refresh grants. */
    token: string;
    /** OIDC discovery document holding `revocation_endpoint`. */
    discovery: string;
    /** JWKS the ID token's signature is verified against. */
    jwks: string;
    /** Expected `iss` claim. */
    issuer: string;
}
/** The official OpenAI endpoints; every entry point defaults to these. */
export declare const OFFICIAL_ENDPOINTS: OAuthEndpoints;
/**
 * The first-time registration entrypoint. It is deliberately never stored as a
 * connection's client id: it addresses "register a new client", not a client.
 */
export declare const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
/**
 * Identity scopes plus the two ChatGPT-plan-usage scopes. `chatgpt.tokens.use.direct`
 * is the one that actually authorizes plan usage, and its absence in the
 * granted scope set is a valid sign-in with plan usage disabled.
 */
export declare const SCOPE: string;
/** The granted scope whose presence means ChatGPT plan usage is enabled. */
export declare const PLAN_SCOPE = "chatgpt.tokens.use.direct";
/** One OAuth token response, normalized to the fields this plugin stores. */
export interface TokenSet {
    accessToken: string;
    refreshToken: string;
    /** Absent on refresh responses that do not reissue it. */
    idToken?: string;
    tokenType: string;
    expiresIn: number;
    /** Granted scopes, space-separated, exactly as returned. */
    scope?: string;
    /** Server hint: do not refresh before this instant (unix seconds). */
    earliestRefreshAt?: number;
}
/** A completed authorization: the tokens plus the client identity they bind to. */
export interface AuthorizationResult {
    tokens: TokenSet;
    /**
     * The issued client id. For a new registration this comes from the callback;
     * for a reauthorization it is the one already associated with the account.
     */
    clientId: string;
}
/** A PKCE verifier and its S256 challenge. */
export interface Pkce {
    verifier: string;
    challenge: string;
}
/**
 * A fresh PKCE pair per attempt. The verifier is high-entropy and never leaves
 * this process; the challenge is the base64url SHA-256 digest with no padding,
 * as the authorization request requires.
 * @returns the verifier to hold until the exchange and the challenge to send.
 */
export declare function createPkce(): Pkce;
/** A fresh opaque `state`, bound to one attempt and validated on return. */
export declare function createState(): string;
/** A fresh OIDC `nonce`, validated against the ID token's `nonce` claim. */
export declare function createNonce(): string;
/**
 * A per-host opaque identifier in the `urn:uuid:` form the docs accept. It is
 * an identifier only — no possession proof — and must stay stable across
 * sign-ins for a host while staying distinct between hosts.
 * @returns a fresh `urn:uuid:<v4>` value to persist for this host.
 */
export declare function createHostId(): string;
/** Inputs for one authorization request. */
export interface AuthorizeInput {
    /**
     * `dynamic_agent_client` for a brand-new registration, otherwise the issued
     * client id saved with the account being reauthorized.
     */
    clientId: string;
    /** App name for the consent screen; sent only on initial registration. */
    agentNameHint?: string;
    /** Stable per-host identifier; required on every attempt. */
    hostId: string;
    /** Retained ID token for a returning account; skips the account selector. */
    idTokenHint?: string;
    /** Optional saved email hint for a returning account. */
    loginHint?: string;
    redirectUri: string;
    state: string;
    nonce: string;
    codeChallenge: string;
}
/**
 * Build the authorization URL the system browser is opened at.
 * @param input - one attempt's parameters.
 * @returns the fully encoded authorization URL.
 */
export declare function buildAuthorizeUrl(input: AuthorizeInput, endpoints?: OAuthEndpoints): string;
/** What the loopback callback delivered. */
export interface CallbackResult {
    code: string;
    /** Present only on a new registration; the client id to save. */
    clientId?: string;
    scope?: string;
}
/** A running loopback listener for one authorization attempt. */
export interface CallbackListener {
    /** The exact `redirect_uri` this listener serves; must match the request verbatim. */
    redirectUri: string;
    /** Resolves with the authorization code, or rejects on error/timeout/abort. */
    waitForCode: () => Promise<CallbackResult>;
    /** Stop listening and settle any pending wait. */
    close: () => void;
}
/**
 * Start the loopback listener for one attempt.
 *
 * The port is chosen from `preferredPort` upward so a second concurrent
 * sign-in (or an unrelated process holding 1455) does not fail the attempt;
 * scheme, host, and path are fixed by the provider and never varied.
 * @param options - the expected `state`, the port to try first, and cancellation.
 * @returns the listener, whose `redirectUri` must be sent in the authorization request.
 */
export declare function startCallbackListener(options: {
    state: string;
    preferredPort?: number;
    signal?: AbortSignal;
}): Promise<CallbackListener>;
/** Failure taxonomy for this module, matching the harness error `code` convention. */
export declare class OAuthError extends Error {
    readonly code: string;
    constructor(message: string, code: string, options?: ErrorOptions);
}
/**
 * Exchange an authorization code for tokens.
 *
 * The client id is the issued one: for a new registration it came back on the
 * callback, and `dynamic_agent_client` is refused here on purpose, because
 * exchanging under the registration entrypoint would bind the tokens to
 * nothing the user authorized.
 * @param input - the code, its PKCE verifier, the client id, and the exact redirect URI.
 * @returns the issued token set.
 */
export declare function exchangeCode(input: {
    code: string;
    verifier: string;
    clientId: string;
    redirectUri: string;
    signal?: AbortSignal;
}, endpoints?: OAuthEndpoints): Promise<TokenSet>;
/**
 * Refresh an access token with the rotating refresh token.
 *
 * `scope` is deliberately omitted so the existing grant is retained, and the
 * issued client id — never the registration entrypoint — identifies the
 * client. Serialization against concurrent refreshes is the caller's
 * responsibility: this function performs one exchange, and the credential store
 * serializes the read-modify-write that surrounds it.
 * @param input - the issued client id and the current refresh token.
 * @returns the replacement token set, whose refresh token supersedes the input.
 */
export declare function refreshTokens(input: {
    clientId: string;
    refreshToken: string;
    signal?: AbortSignal;
}, endpoints?: OAuthEndpoints): Promise<TokenSet>;
/**
 * Revoke the renewable session on sign-out.
 *
 * The endpoint is discovered rather than hardcoded, and an already-invalid
 * token still counts as revoked. A network failure is reported to the caller
 * so the UI can say the remote session may still be live — the local record is
 * cleared either way, which is a deliberate choice recorded in the README.
 * @param input - the issued client id and the refresh token to revoke.
 * @returns nothing; a rejected promise means revocation was not confirmed.
 */
export declare function revokeSession(input: {
    clientId: string;
    refreshToken: string;
    signal?: AbortSignal;
}, endpoints?: OAuthEndpoints): Promise<void>;
