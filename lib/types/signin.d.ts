/**
 * One ChatGPT sign-in attempt, orchestrated end to end.
 *
 * The attempt outlives the HTTP request that starts it: the human has to leave
 * for a browser and come back, so `start()` returns as soon as there is a URL
 * to open, and the UI polls {@link SignInManager.view} until the attempt
 * settles. Exactly one attempt runs at a time, which is what keeps the loopback
 * listener, the pending `state`, and the code exchange describing one flow.
 *
 * The order below is the documented one and every step is load-bearing:
 * a fresh `state`, `nonce`, and PKCE verifier per attempt; the listener bound
 * before the browser is opened; the same `redirect_uri` in the authorization
 * request and the exchange; the issued `client_id` from a new registration
 * saved instead of `dynamic_agent_client`; the ID token verified before its
 * claims are believed; and the granted scopes inspected before plan usage is
 * reported as available.
 *
 * @module dsh-chatgpt-provider/signin
 */
import type { OAuthEndpoints } from './oauth.ts';
import type { CredentialStoreLike } from './accounts.ts';
import type { Config } from './config.ts';
/** Where an attempt is in its lifecycle. */
export type AttemptState = 'idle' | 'waiting' | 'exchanging' | 'completed' | 'failed' | 'cancelled';
/** The attempt's externally visible state. */
export interface AttemptView {
    state: AttemptState;
    /** The authorization URL the human opens, while the attempt waits. */
    url?: string;
    /** Progress or outcome text. */
    message?: string;
    /** Failure detail when `state` is `failed`. */
    error?: string;
    /** The account the attempt produced, when it completed. */
    accountId?: string;
}
/** What the manager needs from the plugin. */
export interface SignInDeps {
    credentials: () => CredentialStoreLike | undefined;
    config: () => Config;
    /** The persisted per-host identifier sent on every attempt. */
    hostId: () => Promise<string>;
    /** Report progress to the operator log. */
    onNotice: (message: string) => void;
    /**
     * Endpoints this flow talks to. Production omits it and gets the official
     * ones; the seam exists so the whole flow can be exercised end to end against
     * a local server.
     */
    endpoints?: OAuthEndpoints;
}
/** Which registration an attempt is for. */
export type SignInTarget = {
    kind: 'new';
} | {
    kind: 'account';
    id: string;
};
/**
 * Owns the single in-flight authorization attempt.
 *
 * A `state`-carrying callback is only ever believed for the attempt that
 * created it, so the manager never holds two attempts: a second start is
 * refused rather than queued, matching the authorization seam's own
 * one-attempt-per-key rule.
 */
export declare class SignInManager {
    private readonly deps;
    private controller;
    private listener;
    private current;
    constructor(deps: SignInDeps);
    /** The endpoints this flow talks to; the official set unless a test injects another. */
    private endpoints;
    /** The attempt's current state, detached for transport. */
    view(): AttemptView;
    /**
     * Begin an attempt and return as soon as there is a URL to open.
     * @param target - a brand-new registration, or an existing saved account.
     * @returns the attempt state, normally `waiting` with a `url`.
     * @throws {ChatGptError} `ALREADY_IN_FLIGHT` when an attempt is still running.
     */
    start(target: SignInTarget): Promise<AttemptView>;
    /** Withdraw whatever is running. */
    cancel(): AttemptView;
    /** Wait for the browser callback, exchange the code, and persist the account. */
    private awaitCallback;
    /** Release the attempt's resources, leaving the settled view in place. */
    private settle;
}
