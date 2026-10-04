/**
 * Durable account state for the ChatGPT provider.
 *
 * Two kinds of state live here, both inside the harness credential document
 * rather than in a file this plugin owns:
 *
 * - **One record per ChatGPT account registration**, keyed by the issued
 *   `client_id` together with the ID token's validated `sub`. The docs require
 *   registrations to stay separate even when two share an email address, so the
 *   key is derived from exactly those two facts and never from the email.
 * - **The stable host id**, under a reserved record id. It is not a secret; it
 *   lives here because this is the one durable, atomically written,
 *   0600-protected store the plugin can reach without inventing a file path,
 *   and because it must survive restarts to stay the same host.
 *
 * Storing through `ctx.credentials` is what makes the rotating refresh token
 * safe: `modifyRecord` is a locked, cross-process read-modify-write, so a
 * refresh performed inside it cannot race a second DSH process to the same
 * one-time-use token.
 *
 * @module dsh-chatgpt-provider/accounts
 */
import { createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { OFFICIAL_ENDPOINTS, OAuthError, PLAN_SCOPE, refreshTokens } from "./oauth.js";
/** Scope naming this plugin as the owner of its credential records. */
export const RECORD_SCOPE = 'chatgpt';
/** Reserved record id holding the host identifier rather than an account. */
export const HOST_RECORD_ID = 'host';
/**
 * How long before expiry a token is treated as stale. The access token lives
 * one hour; renewing two minutes early keeps a request from starting on a
 * token that expires mid-stream.
 */
const REFRESH_MARGIN_MS = 120_000;
/**
 * Bound on a token-endpoint call.
 *
 * Deliberately below the credential store's own 30 s document-lock wait: a
 * refresh runs while holding that lock, so a hung token endpoint must give up
 * before a second process waiting on the same document times out. A healthy
 * token endpoint answers in well under a second.
 */
const TOKEN_TIMEOUT_MS = 20_000;
/**
 * One cached JWKS resolver per JWKS URL. jose re-fetches on an unknown `kid`,
 * so a key rotation is picked up without restarting the plugin, and the cache
 * is keyed by URL rather than held in a module singleton so a flow pointed at a
 * different issuer cannot be verified against the wrong keys.
 */
const jwksCache = new Map();
/** The JWKS resolver for one endpoint set, created on first use. */
function jwksFor(endpoints) {
    const existing = jwksCache.get(endpoints.jwks);
    if (existing !== undefined)
        return existing;
    const created = createRemoteJWKSet(new URL(endpoints.jwks), { timeoutDuration: TOKEN_TIMEOUT_MS });
    jwksCache.set(endpoints.jwks, created);
    return created;
}
/**
 * Derive the record id for one registration.
 *
 * The docs make the issued client id plus the verified subject the identity of
 * a registration, and explicitly allow two registrations to share an email —
 * so the id is a hash of those two facts and nothing else. The hash keeps the
 * result inside the record-id grammar (lowercase hyphenated), which a raw
 * subject or client id would not satisfy.
 * @param subject - the validated ID-token `sub`.
 * @param clientId - the issued client id.
 * @returns a stable, grammar-legal record id.
 */
export function accountIdFor(subject, clientId) {
    const digest = createHash('sha256').update(`${subject}\u0000${clientId}`).digest('hex');
    return `acct-${digest.slice(0, 16)}`;
}
/** Build the credential key string for one record id. */
export function recordKey(id) {
    return `${RECORD_SCOPE}/${id}`;
}
/** The record id half of a credential key, or `undefined` for a foreign key. */
function idOf(key) {
    const separator = key.indexOf('/');
    if (separator < 0 || key.slice(0, separator) !== RECORD_SCOPE)
        return undefined;
    return key.slice(separator + 1);
}
/** Narrow a stored record to a ChatGPT grant, or `undefined` for anything else. */
function asGrant(record) {
    if (record === undefined || record.kind !== 'grant')
        return undefined;
    const payload = record.payload;
    if (typeof payload !== 'object' || payload === null)
        return undefined;
    const grant = payload;
    if (grant.type !== 'chatgpt-plan')
        return undefined;
    if (typeof grant.accessToken !== 'string' || typeof grant.refreshToken !== 'string')
        return undefined;
    if (typeof grant.clientId !== 'string' || typeof grant.subject !== 'string')
        return undefined;
    return grant;
}
/** Project a grant into the view the plugin's own surfaces render. */
function toView(id, grant) {
    return {
        id,
        subject: grant.subject,
        ...grant.email === undefined ? {} : { email: grant.email },
        clientId: grant.clientId,
        planEnabled: grant.scopes.includes(PLAN_SCOPE),
        scopes: [...grant.scopes],
        expiresAt: grant.expiresAt,
        savedAt: grant.savedAt,
    };
}
/** Turn a token set into the grant to persist, given the account identity. */
export function grantFrom(input) {
    const { tokens } = input;
    const scopes = tokens.scope !== undefined
        ? tokens.scope.split(' ').filter(part => part !== '')
        // A refresh response may omit `scope`; the grant is retained, so the
        // previously granted set is still the truth.
        : input.previous?.scopes ?? [];
    const idToken = tokens.idToken ?? input.previous?.idToken;
    return {
        type: 'chatgpt-plan',
        subject: input.subject,
        ...input.email === undefined
            ? input.previous?.email === undefined ? {} : { email: input.previous.email }
            : { email: input.email },
        issuer: input.issuer ?? OFFICIAL_ENDPOINTS.issuer,
        clientId: input.clientId,
        hostId: input.hostId,
        ...idToken === undefined ? {} : { idToken },
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        tokenType: tokens.tokenType,
        expiresAt: Date.now() + tokens.expiresIn * 1000,
        ...tokens.earliestRefreshAt === undefined ? {} : { earliestRefreshAt: tokens.earliestRefreshAt },
        scopes,
        savedAt: new Date().toISOString(),
    };
}
/** Raised when no usable credential store is mounted. */
export class CredentialStoreMissingError extends Error {
    code = 'NO_CREDENTIAL_STORE';
    constructor() {
        super('dsh-chatgpt-provider: this composition mounts no credentials service, so there is nowhere to '
            + 'store a ChatGPT sign-in; mount one (dsh-credentials-local) to sign in');
        this.name = 'CredentialStoreMissingError';
    }
}
/** Require the credential seam, naming what is missing when it is absent. */
export function requireCredentials(ctx) {
    const credentials = ctx.get('credentials');
    if (credentials === undefined)
        throw new CredentialStoreMissingError();
    return credentials;
}
/**
 * Read this host's stable identifier, creating it on first use.
 *
 * Registration, authorization, and every refresh must send the same value for
 * the same host, and it must differ between hosts — so it is generated once and
 * persisted rather than derived from anything that could change.
 * @param credentials - the credential seam.
 * @returns the persisted `urn:uuid:` host id.
 */
export async function ensureHostId(credentials, create) {
    const key = recordKey(HOST_RECORD_ID);
    // The decision happens INSIDE the locked read-modify-write. Reading first and
    // then writing would let two processes that both saw "nothing stored" each
    // mint a different host id, and the loser's write would silently change the
    // host identity that every later authorization and refresh must repeat.
    const stored = await credentials.modifyRecord(key, async (current) => {
        const payload = current?.kind === 'grant' ? current.payload : undefined;
        if (typeof payload === 'object' && payload !== null) {
            const value = payload['hostId'];
            if (typeof value === 'string' && value !== '')
                return current;
        }
        return { kind: 'grant', payload: { type: 'chatgpt-host', hostId: create() } };
    });
    const payload = stored?.kind === 'grant' ? stored.payload : undefined;
    const value = typeof payload === 'object' && payload !== null
        ? payload['hostId']
        : undefined;
    if (typeof value !== 'string' || value === '') {
        throw new OAuthError('the stored host identifier could not be written or read back', 'HOST_ID_UNAVAILABLE');
    }
    return value;
}
/** List every stored ChatGPT account registration, newest first. */
export async function listAccounts(credentials) {
    const records = await credentials.listRecords();
    const accounts = [];
    for (const entry of records) {
        const id = idOf(entry.key);
        if (id === undefined || id === HOST_RECORD_ID)
            continue;
        const grant = asGrant(await credentials.readRecord(entry.key));
        if (grant === undefined)
            continue;
        accounts.push(toView(id, grant));
    }
    return accounts.sort((left, right) => right.savedAt.localeCompare(left.savedAt));
}
/** Read one account by record id. */
export async function readAccount(credentials, id) {
    const grant = asGrant(await credentials.readRecord(recordKey(id)));
    return grant === undefined ? undefined : toView(id, grant);
}
/** Persist one account registration. */
export async function saveAccount(credentials, subject, clientId, grant) {
    const id = accountIdFor(subject, clientId);
    await credentials.modifyRecord(recordKey(id), async () => ({ kind: 'grant', payload: grant }));
    return toView(id, grant);
}
/** Remove one account registration. */
export async function deleteAccount(credentials, id) {
    await credentials.deleteRecord(recordKey(id));
}
/** Read the raw grant for one account, for flows that need the refresh token. */
export async function readGrant(credentials, id) {
    return asGrant(await credentials.readRecord(recordKey(id)));
}
/**
 * Whether a grant's access token is still usable.
 *
 * The only fact that retires a token is its own expiry, minus a margin so a
 * request cannot start on a token that dies mid-stream.
 *
 * `earliest_refresh_at` is deliberately **not** consulted here. It is the moment
 * from which a refresh is expected to be permitted, and the server sets it
 * comfortably *before* expiry — observed at roughly 54 minutes into a 60-minute
 * token. Reading it as "the token is unusable before this instant" inverts its
 * meaning and, because it sits far in the future for most of the token's life,
 * makes every single request take the refresh path: a token exchange per model
 * request, each one rotating the refresh token. The provider tolerates an early
 * refresh, so the failure is invisible — it just quietly costs a round trip and
 * churns a single-use credential on every call.
 * @param grant - the stored grant.
 * @returns true when the access token may be used as-is.
 */
function isFresh(grant) {
    return grant.expiresAt - REFRESH_MARGIN_MS > Date.now();
}
/**
 * Resolve a usable access token for one account, refreshing when stale.
 *
 * The refresh runs *inside* `modifyRecord`, which the credential store
 * implements as a locked, cross-process read-modify-write. That placement is
 * what satisfies the documented requirement to serialize refreshes: the
 * refresh token is single-use and rotates on every exchange, so two processes
 * refreshing concurrently would invalidate each other. The lock also means the
 * replacement access token, expiry, scopes, and refresh token are committed
 * together, as the docs require.
 * @param credentials - the credential seam.
 * @param id - the account record id.
 * @param signal - cancellation for the refresh call.
 * @returns the access token to send, and the account it belongs to.
 */
export async function accessTokenFor(credentials, id, signal, endpoints = OFFICIAL_ENDPOINTS) {
    const key = recordKey(id);
    // Hot path: a plain read, which takes no lock. Every model request resolves
    // its token here, and most of them find a fresh one — acquiring the
    // document lock for that would serialize unrelated requests against each
    // other for no reason. Only a stale token has anything to rotate.
    const existing = asGrant(await credentials.readRecord(key));
    if (existing === undefined) {
        throw new OAuthError(`no stored ChatGPT account under "${key}"`, 'ACCOUNT_NOT_FOUND');
    }
    if (isFresh(existing))
        return { accessToken: existing.accessToken, grant: existing };
    // Cold path. The refresh runs inside `modifyRecord`, which the credential
    // store implements as a locked, cross-process read-modify-write: the refresh
    // token is single-use and rotates on every exchange, so two processes
    // refreshing concurrently would invalidate each other. Freshness is re-judged
    // inside the mutation, so a process that refreshed while this one was
    // deciding does not rotate a second time.
    const stored = await credentials.modifyRecord(key, async (current) => {
        const grant = asGrant(current);
        if (grant === undefined) {
            throw new OAuthError(`no stored ChatGPT account under "${key}"`, 'ACCOUNT_NOT_FOUND');
        }
        if (isFresh(grant))
            return current;
        const timeout = AbortSignal.timeout(TOKEN_TIMEOUT_MS);
        const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
        const tokens = await refreshTokens({
            clientId: grant.clientId,
            refreshToken: grant.refreshToken,
            signal: combined,
        }, endpoints);
        return { kind: 'grant', payload: grantFrom({ tokens, subject: grant.subject, clientId: grant.clientId,
                hostId: grant.hostId, issuer: endpoints.issuer, previous: grant }) };
    });
    const grant = asGrant(stored);
    if (grant === undefined) {
        throw new OAuthError(`the stored ChatGPT account under "${key}" vanished during refresh`, 'ACCOUNT_NOT_FOUND');
    }
    return { accessToken: grant.accessToken, grant };
}
/**
 * Verify an ID token against OpenAI's published JWKS and return its identity.
 *
 * Signature, issuer, audience (the issued client id), expiry, and the nonce
 * bound to this attempt are all checked before any claim is believed; `sub` is
 * the account identity, and the email is display metadata only — the docs are
 * explicit that two registrations may share one.
 * @param idToken - the compact JWS from the token response.
 * @param clientId - the issued client id, which must be the token's audience.
 * @param nonce - the nonce generated for this attempt.
 * @returns the validated identity.
 */
export async function verifyIdToken(idToken, clientId, nonce, endpoints = OFFICIAL_ENDPOINTS) {
    let payload;
    try {
        const verified = await jwtVerify(idToken, jwksFor(endpoints), {
            issuer: endpoints.issuer,
            audience: clientId,
            requiredClaims: ['sub', 'exp', 'iat'],
            clockTolerance: 5,
        });
        payload = verified.payload;
    }
    catch (error) {
        throw new OAuthError(`the ID token failed verification: ${error instanceof Error ? error.message : String(error)}`, 'ID_TOKEN_INVALID', { cause: error });
    }
    if (payload['nonce'] !== nonce) {
        throw new OAuthError('the ID token nonce did not match this sign-in attempt', 'ID_TOKEN_INVALID');
    }
    const subject = payload['sub'];
    if (typeof subject !== 'string' || subject === '') {
        throw new OAuthError('the ID token carried no subject', 'ID_TOKEN_INVALID');
    }
    const email = payload['email'];
    const scope = payload['scope'];
    return {
        subject,
        ...typeof email === 'string' && email !== '' ? { email } : {},
        ...typeof scope === 'string' && scope !== '' ? { scopes: scope.split(' ').filter(part => part !== '') } : {},
    };
}
/** Whether a grant's scopes authorize ChatGPT plan usage at all. */
export function planUsageEnabled(scopes) {
    return scopes.includes(PLAN_SCOPE);
}
//# sourceMappingURL=accounts.js.map