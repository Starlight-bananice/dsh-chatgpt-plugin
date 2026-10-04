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
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
/** Authorization endpoint for the ChatGPT-plan OAuth flow. */
const AUTHORIZE_URL = 'https://auth.openai.com/api/accounts/authorize';
/** Token endpoint for both the authorization-code and refresh grants. */
const TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token';
/** OIDC discovery document; the sign-out path reads `revocation_endpoint` from it. */
const DISCOVERY_URL = 'https://auth.openai.com/.well-known/openid-configuration';
/** Issuer every token in this flow must carry. */
export const ISSUER = 'https://auth.openai.com';
/** The `resource` every authorization, exchange, and refresh must repeat. */
export const RESOURCE = 'https://api.openai.com/v1';
/** The official OpenAI endpoints; every entry point defaults to these. */
export const OFFICIAL_ENDPOINTS = Object.freeze({
    authorize: AUTHORIZE_URL,
    token: TOKEN_URL,
    discovery: DISCOVERY_URL,
    jwks: 'https://auth.openai.com/.well-known/jwks.json',
    issuer: ISSUER,
});
/**
 * The first-time registration entrypoint. It is deliberately never stored as a
 * connection's client id: it addresses "register a new client", not a client.
 */
export const DYNAMIC_CLIENT_ID = 'dynamic_agent_client';
/**
 * Identity scopes plus the two ChatGPT-plan-usage scopes. `chatgpt.tokens.use.direct`
 * is the one that actually authorizes plan usage, and its absence in the
 * granted scope set is a valid sign-in with plan usage disabled.
 */
export const SCOPE = [
    'openid',
    'profile',
    'email',
    'offline_access',
    'resource.invoke',
    'chatgpt.tokens.use.direct',
].join(' ');
/** The granted scope whose presence means ChatGPT plan usage is enabled. */
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
/** The only callback path the token endpoint accepts for this client. */
const CALLBACK_PATH = '/auth/callback';
/** Default loopback port; a later attempt may fall back to another free port. */
const DEFAULT_CALLBACK_PORT = 1455;
/** Base64url without padding, the JOSE encoding used by PKCE and JWTs. */
function base64url(input) {
    return input.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
/**
 * A fresh PKCE pair per attempt. The verifier is high-entropy and never leaves
 * this process; the challenge is the base64url SHA-256 digest with no padding,
 * as the authorization request requires.
 * @returns the verifier to hold until the exchange and the challenge to send.
 */
export function createPkce() {
    const verifier = base64url(randomBytes(32));
    return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) };
}
/** A fresh opaque `state`, bound to one attempt and validated on return. */
export function createState() {
    return base64url(randomBytes(16));
}
/** A fresh OIDC `nonce`, validated against the ID token's `nonce` claim. */
export function createNonce() {
    return base64url(randomBytes(16));
}
/**
 * A per-host opaque identifier in the `urn:uuid:` form the docs accept. It is
 * an identifier only — no possession proof — and must stay stable across
 * sign-ins for a host while staying distinct between hosts.
 * @returns a fresh `urn:uuid:<v4>` value to persist for this host.
 */
export function createHostId() {
    return `urn:uuid:${randomUUID()}`;
}
/**
 * Build the authorization URL the system browser is opened at.
 * @param input - one attempt's parameters.
 * @returns the fully encoded authorization URL.
 */
export function buildAuthorizeUrl(input, endpoints = OFFICIAL_ENDPOINTS) {
    const url = new URL(endpoints.authorize);
    const params = url.searchParams;
    params.set('client_id', input.clientId);
    params.set('response_type', 'code');
    params.set('redirect_uri', input.redirectUri);
    params.set('scope', SCOPE);
    params.set('resource', RESOURCE);
    params.set('state', input.state);
    params.set('nonce', input.nonce);
    params.set('code_challenge_method', 'S256');
    params.set('code_challenge', input.codeChallenge);
    params.set('ext_agent_host_id', input.hostId);
    // Initial registration only: a reauthorization with an issued client id must
    // omit the hint, because the name is already bound to that registration.
    if (input.agentNameHint !== undefined)
        params.set('agent_name_hint', input.agentNameHint);
    if (input.idTokenHint !== undefined)
        params.set('id_token_hint', input.idTokenHint);
    if (input.loginHint !== undefined)
        params.set('login_hint', input.loginHint);
    return url.toString();
}
/** HTML the browser lands on once the callback has been consumed. */
function resultPage(ok, message) {
    const title = ok ? 'Signed in' : 'Sign-in failed';
    return `<!doctype html><meta charset="utf-8"><title>${title}</title>`
        + '<body style="font:15px/1.5 system-ui;margin:6rem auto;max-width:32rem;text-align:center">'
        + `<h1 style="font-size:1.25rem">${title}</h1><p>${message}</p>`
        + '<p style="color:#666">You can close this window and return to DeepSeek Harness.</p></body>';
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
export async function startCallbackListener(options) {
    const preferred = options.preferredPort ?? DEFAULT_CALLBACK_PORT;
    let settle = () => { };
    let fail = () => { };
    const settled = new Promise((resolve, reject) => {
        settle = resolve;
        fail = reject;
    });
    let done = false;
    const finish = (action) => {
        if (done)
            return;
        done = true;
        action();
    };
    const handler = (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname !== CALLBACK_PATH) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('Not found');
            return;
        }
        // State is validated before anything else is believed: a callback that
        // does not belong to this attempt must not be able to settle it.
        if (url.searchParams.get('state') !== options.state) {
            res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
            res.end(resultPage(false, 'This sign-in response did not match the pending request.'));
            return;
        }
        const error = url.searchParams.get('error');
        if (error !== null) {
            const description = url.searchParams.get('error_description') ?? '';
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(resultPage(false, `${error}${description === '' ? '' : `: ${description}`}`));
            // A declined consent is an outcome, not a crash: reject with a coded
            // error so the attempt settles as cancelled rather than failed.
            // Argument order matters: (message, code). A declined consent carries its
            // own code so the attempt settles as cancelled rather than failed.
            const message = `${error}${description === '' ? '' : `: ${description}`}`;
            finish(() => { fail(new OAuthError(message, error === 'access_denied' ? 'ACCESS_DENIED' : 'AUTHORIZE_FAILED')); });
            return;
        }
        const code = url.searchParams.get('code');
        if (code === null || code === '') {
            res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
            res.end(resultPage(false, 'The sign-in response carried no authorization code.'));
            return;
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(resultPage(true, 'ChatGPT sign-in completed.'));
        const issued = url.searchParams.get('client_id');
        const scope = url.searchParams.get('scope');
        finish(() => {
            settle({
                code,
                ...issued === null || issued === '' ? {} : { clientId: issued },
                ...scope === null || scope === '' ? {} : { scope },
            });
        });
    };
    const listen = async (port) => {
        const server = createServer(handler);
        await new Promise((resolve, reject) => {
            const onError = (error) => {
                server.off('listening', onListening);
                reject(error);
            };
            const onListening = () => {
                server.off('error', onError);
                resolve();
            };
            server.once('error', onError);
            server.once('listening', onListening);
            // Bound to 127.0.0.1 exactly: the docs forbid substituting `localhost`,
            // and an all-interfaces bind would expose this endpoint to the network.
            server.listen(port, '127.0.0.1');
        });
        return server;
    };
    let server;
    let lastError;
    for (let port = preferred; port < preferred + 16; port += 1) {
        try {
            server = await listen(port);
            // The chosen port is remembered so `redirectUri` and the exchange agree.
            return make(server, port);
        }
        catch (error) {
            lastError = error;
            if (error.code !== 'EADDRINUSE')
                throw error;
        }
    }
    throw new OAuthError(`no free loopback port in ${preferred}..${preferred + 15} for the OAuth callback`, 'CALLBACK_UNAVAILABLE', { cause: lastError });
    function make(bound, port) {
        const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
        const onAbort = () => {
            finish(() => { fail(new OAuthError('the sign-in attempt was cancelled', 'CANCELLED')); });
        };
        options.signal?.addEventListener('abort', onAbort, { once: true });
        const close = () => {
            options.signal?.removeEventListener('abort', onAbort);
            bound.close();
            // A listener closed without a result must not leave the attempt hanging.
            finish(() => {
                fail(new OAuthError('the sign-in attempt ended before the browser returned', 'CANCELLED'));
            });
        };
        if (options.signal?.aborted === true)
            onAbort();
        return { redirectUri, waitForCode: () => settled, close };
    }
}
/** Failure taxonomy for this module, matching the harness error `code` convention. */
export class OAuthError extends Error {
    code;
    constructor(message, code, options) {
        super(message, options);
        this.code = code;
        this.name = 'OAuthError';
    }
}
/** Read a JSON body, turning a non-2xx into a coded error carrying the raw text. */
async function readTokenResponse(response, operation) {
    const text = await response.text();
    if (!response.ok) {
        let detail = text;
        try {
            const parsed = JSON.parse(text);
            detail = JSON.stringify(parsed);
        }
        catch {
            // Non-JSON bodies are reported verbatim; admission failures are
            // documented to return `{"detail": "..."}` or plain text.
        }
        throw new OAuthError(`OpenAI ${operation} failed (HTTP ${String(response.status)}): ${detail}`, refreshFailureCode(detail, response.status));
    }
    try {
        const parsed = JSON.parse(text);
        if (typeof parsed !== 'object' || parsed === null) {
            throw new OAuthError(`OpenAI ${operation} returned a non-object body`, 'TOKEN_RESPONSE_INVALID');
        }
        return parsed;
    }
    catch (error) {
        if (error instanceof OAuthError)
            throw error;
        throw new OAuthError(`OpenAI ${operation} returned unparseable JSON: ${text.slice(0, 300)}`, 'TOKEN_RESPONSE_INVALID', { cause: error });
    }
}
/**
 * Map a token-endpoint failure onto a stable code. A rotating refresh token
 * that was already spent is the one failure that must never be retried with
 * the same value, so it keeps its own identity rather than folding into a
 * generic auth failure.
 * @param detail - the raw response text or serialized JSON.
 * @param status - the HTTP status, used when the body names no code.
 * @returns the code to surface.
 */
function refreshFailureCode(detail, status) {
    if (/\binvalid_grant\b|\binvalid_refresh_token\b|\brefresh_token_(?:expired|invalidated|reused)\b|\btoken_expired\b/
        .test(detail))
        return 'REFRESH_TOKEN_UNUSABLE';
    if (/\binvalid_client\b/.test(detail))
        return 'INVALID_CLIENT';
    if (status === 401 || status === 403)
        return 'AUTH';
    return 'TOKEN_REQUEST_FAILED';
}
/** Normalize a token endpoint payload into a {@link TokenSet}. */
function toTokenSet(json) {
    const accessToken = json['access_token'];
    const refreshToken = json['refresh_token'];
    if (typeof accessToken !== 'string' || accessToken === '') {
        throw new OAuthError('OpenAI token response carried no access_token', 'TOKEN_RESPONSE_INVALID');
    }
    // A rotating refresh token is the whole point of this flow: a response that
    // omits it cannot be stored, because the previous one is already spent.
    if (typeof refreshToken !== 'string' || refreshToken === '') {
        throw new OAuthError('OpenAI token response carried no refresh_token', 'TOKEN_RESPONSE_INVALID');
    }
    const idToken = json['id_token'];
    const scope = json['scope'];
    const tokenType = json['token_type'];
    const expiresIn = json['expires_in'];
    const earliestRefreshAt = json['earliest_refresh_at'];
    return {
        accessToken,
        refreshToken,
        ...typeof idToken === 'string' && idToken !== '' ? { idToken } : {},
        tokenType: typeof tokenType === 'string' && tokenType !== '' ? tokenType : 'Bearer',
        expiresIn: typeof expiresIn === 'number' && Number.isFinite(expiresIn) ? expiresIn : 3600,
        ...typeof scope === 'string' && scope !== '' ? { scope } : {},
        ...typeof earliestRefreshAt === 'number' && Number.isFinite(earliestRefreshAt)
            ? { earliestRefreshAt }
            : {},
    };
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
export async function exchangeCode(input, endpoints = OFFICIAL_ENDPOINTS) {
    if (input.clientId === DYNAMIC_CLIENT_ID) {
        throw new OAuthError('refusing to exchange a code under the registration entrypoint client id', 'MISSING_ISSUED_CLIENT_ID');
    }
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: input.clientId,
        code: input.code,
        code_verifier: input.verifier,
        redirect_uri: input.redirectUri,
        resource: RESOURCE,
    });
    const response = await fetch(endpoints.token, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body,
        ...input.signal === undefined ? {} : { signal: input.signal },
    });
    return toTokenSet(await readTokenResponse(response, 'code exchange'));
}
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
export async function refreshTokens(input, endpoints = OFFICIAL_ENDPOINTS) {
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: input.clientId,
        refresh_token: input.refreshToken,
        resource: RESOURCE,
    });
    const response = await fetch(endpoints.token, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body,
        ...input.signal === undefined ? {} : { signal: input.signal },
    });
    return toTokenSet(await readTokenResponse(response, 'token refresh'));
}
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
export async function revokeSession(input, endpoints = OFFICIAL_ENDPOINTS) {
    const discovery = await fetch(endpoints.discovery, {
        headers: { accept: 'application/json' },
        ...input.signal === undefined ? {} : { signal: input.signal },
    });
    if (!discovery.ok) {
        throw new OAuthError(`OIDC discovery failed (HTTP ${String(discovery.status)})`, 'DISCOVERY_FAILED');
    }
    const document = await discovery.json();
    const endpoint = typeof document === 'object' && document !== null
        ? document['revocation_endpoint']
        : undefined;
    if (typeof endpoint !== 'string' || endpoint === '') {
        throw new OAuthError('OIDC discovery document declared no revocation_endpoint', 'DISCOVERY_FAILED');
    }
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
            token: input.refreshToken,
            token_type_hint: 'refresh_token',
            client_id: input.clientId,
        }),
        ...input.signal === undefined ? {} : { signal: input.signal },
    });
    // An empty 200 is the documented success response, including for a token
    // that was already invalid.
    if (!response.ok) {
        throw new OAuthError(`revocation failed (HTTP ${String(response.status)})`, 'REVOKE_FAILED');
    }
}
//# sourceMappingURL=oauth.js.map