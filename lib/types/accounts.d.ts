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
import type { OAuthEndpoints, TokenSet } from './oauth.ts';
/** Scope naming this plugin as the owner of its credential records. */
export declare const RECORD_SCOPE = "chatgpt";
/** Reserved record id holding the host identifier rather than an account. */
export declare const HOST_RECORD_ID = "host";
/**
 * The subset of `ctx.credentials` this plugin uses. Typed structurally so the
 * plugin carries no runtime dependency on the credentials package.
 */
export interface CredentialStoreLike {
    readRecord: (key: string) => Promise<StoredRecord | undefined>;
    listRecords: () => Promise<readonly StoredRecordEntry[]>;
    modifyRecord: (key: string, mutate: (current: StoredRecord | undefined) => Promise<StoredRecord | undefined>) => Promise<StoredRecord | undefined>;
    deleteRecord: (key: string) => Promise<void>;
}
/** One stored credential record, in the union the credential seam persists. */
export interface StoredRecord {
    kind: string;
    payload?: unknown;
}
/** One stored record entry as listed by the seam. */
export interface StoredRecordEntry {
    key: string;
    kind: string;
}
/** Fields a granted ChatGPT account persists, in the layout the docs specify. */
export interface AccountGrant {
    type: 'chatgpt-plan';
    /** Validated identity. */
    subject: string;
    email?: string;
    issuer: string;
    /** The issued client id this registration is bound to. */
    clientId: string;
    /** Host that produced the registration. */
    hostId: string;
    /** Retained for `id_token_hint` on a later reauthorization. */
    idToken?: string;
    accessToken: string;
    refreshToken: string;
    tokenType: string;
    /** Absolute expiry, so a restart needs no clock arithmetic on `expires_in`. */
    expiresAt: number;
    /**
     * Unix seconds from which a refresh is expected to be permitted.
     *
     * Retained because it is part of the token set the server returned, and kept
     * out of the freshness decision on purpose — see `isFresh`.
     */
    earliestRefreshAt?: number;
    scopes: string[];
    savedAt: string;
}
/** One account as the plugin's own surfaces see it. */
export interface AccountView {
    /** Record id, addressable through the credential seam. */
    id: string;
    subject: string;
    email?: string;
    clientId: string;
    /** True when the grant carries the scope that actually authorizes plan usage. */
    planEnabled: boolean;
    scopes: readonly string[];
    expiresAt: number;
    savedAt: string;
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
export declare function accountIdFor(subject: string, clientId: string): string;
/** Build the credential key string for one record id. */
export declare function recordKey(id: string): string;
/** Turn a token set into the grant to persist, given the account identity. */
export declare function grantFrom(input: {
    tokens: TokenSet;
    subject: string;
    email?: string;
    clientId: string;
    hostId: string;
    /** Issuer the grant was obtained from; defaults to the official one. */
    issuer?: string;
    /** Previously stored grant, so a refresh that omits `id_token` keeps the old one. */
    previous?: AccountGrant;
}): AccountGrant;
/** Raised when no usable credential store is mounted. */
export declare class CredentialStoreMissingError extends Error {
    readonly code = "NO_CREDENTIAL_STORE";
    constructor();
}
/** Require the credential seam, naming what is missing when it is absent. */
export declare function requireCredentials(ctx: {
    get: (name: string) => unknown;
}): CredentialStoreLike;
/**
 * Read this host's stable identifier, creating it on first use.
 *
 * Registration, authorization, and every refresh must send the same value for
 * the same host, and it must differ between hosts — so it is generated once and
 * persisted rather than derived from anything that could change.
 * @param credentials - the credential seam.
 * @returns the persisted `urn:uuid:` host id.
 */
export declare function ensureHostId(credentials: CredentialStoreLike, create: () => string): Promise<string>;
/** List every stored ChatGPT account registration, newest first. */
export declare function listAccounts(credentials: CredentialStoreLike): Promise<AccountView[]>;
/** Read one account by record id. */
export declare function readAccount(credentials: CredentialStoreLike, id: string): Promise<AccountView | undefined>;
/** Persist one account registration. */
export declare function saveAccount(credentials: CredentialStoreLike, subject: string, clientId: string, grant: AccountGrant): Promise<AccountView>;
/** Remove one account registration. */
export declare function deleteAccount(credentials: CredentialStoreLike, id: string): Promise<void>;
/** Read the raw grant for one account, for flows that need the refresh token. */
export declare function readGrant(credentials: CredentialStoreLike, id: string): Promise<AccountGrant | undefined>;
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
export declare function accessTokenFor(credentials: CredentialStoreLike, id: string, signal?: AbortSignal, endpoints?: OAuthEndpoints): Promise<{
    accessToken: string;
    grant: AccountGrant;
}>;
/** The verified identity carried by an ID token. */
export interface VerifiedIdentity {
    subject: string;
    email?: string;
    /** Granted scopes as carried by the ID token, when present. */
    scopes?: string[];
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
export declare function verifyIdToken(idToken: string, clientId: string, nonce: string, endpoints?: OAuthEndpoints): Promise<VerifiedIdentity>;
/** Whether a grant's scopes authorize ChatGPT plan usage at all. */
export declare function planUsageEnabled(scopes: readonly string[]): boolean;
