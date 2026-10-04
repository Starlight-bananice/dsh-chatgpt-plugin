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
import { buildAuthorizeUrl, createNonce, createPkce, createState, DYNAMIC_CLIENT_ID, exchangeCode, OAuthError, OFFICIAL_ENDPOINTS, startCallbackListener, } from "./oauth.js";
import { grantFrom, planUsageEnabled, readGrant, saveAccount, verifyIdToken } from "./accounts.js";
import { ChatGptError, codeForStatus } from "./errors.js";
/**
 * Owns the single in-flight authorization attempt.
 *
 * A `state`-carrying callback is only ever believed for the attempt that
 * created it, so the manager never holds two attempts: a second start is
 * refused rather than queued, matching the authorization seam's own
 * one-attempt-per-key rule.
 */
export class SignInManager {
    deps;
    controller;
    listener;
    current = { state: 'idle' };
    constructor(deps) {
        this.deps = deps;
    }
    /** The endpoints this flow talks to; the official set unless a test injects another. */
    endpoints() {
        return this.deps.endpoints ?? OFFICIAL_ENDPOINTS;
    }
    /** The attempt's current state, detached for transport. */
    view() {
        return { ...this.current };
    }
    /**
     * Begin an attempt and return as soon as there is a URL to open.
     * @param target - a brand-new registration, or an existing saved account.
     * @returns the attempt state, normally `waiting` with a `url`.
     * @throws {ChatGptError} `ALREADY_IN_FLIGHT` when an attempt is still running.
     */
    async start(target) {
        if (this.controller !== undefined) {
            throw new ChatGptError('chatgpt: a sign-in is already in progress; cancel it before starting another', 'ALREADY_IN_FLIGHT');
        }
        const credentials = this.deps.credentials();
        if (credentials === undefined) {
            throw new ChatGptError('chatgpt: this deployment mounts no credentials service, so a sign-in has nowhere to be stored', 'NO_CREDENTIAL_STORE');
        }
        const config = this.deps.config();
        const controller = new AbortController();
        this.controller = controller;
        this.current = { state: 'waiting', message: 'Preparing the ChatGPT sign-in…' };
        try {
            const hostId = await this.deps.hostId();
            // A returning account reuses its issued client id and may carry hints;
            // a new registration uses the entrypoint and names the app.
            const existing = target.kind === 'account' ? await readGrant(credentials, target.id) : undefined;
            if (target.kind === 'account' && existing === undefined) {
                throw new ChatGptError(`chatgpt: no saved account "${target.id}"`, 'ACCOUNT_NOT_FOUND');
            }
            const pkce = createPkce();
            const state = createState();
            const nonce = createNonce();
            const listener = await startCallbackListener({
                state,
                preferredPort: config.callbackPort ?? 1455,
                signal: controller.signal,
            });
            this.listener = listener;
            const url = buildAuthorizeUrl({
                clientId: existing?.clientId ?? DYNAMIC_CLIENT_ID,
                redirectUri: listener.redirectUri,
                state,
                nonce,
                codeChallenge: pkce.challenge,
                hostId,
                // Present only on initial registration.
                ...existing === undefined
                    ? { agentNameHint: config.agentName ?? 'DeepSeek Harness' }
                    : {
                        ...existing.idToken === undefined ? {} : { idTokenHint: existing.idToken },
                        ...existing.email === undefined ? {} : { loginHint: existing.email },
                    },
            }, this.endpoints());
            this.current = {
                state: 'waiting',
                url,
                message: 'Complete the sign-in in your browser. This window will update when it finishes.',
            };
            // Detached on purpose: the caller returns the URL now, and the attempt
            // settles later through its own polling surface.
            void this.awaitCallback({ listener, pkce, state, nonce, hostId, existingClientId: existing?.clientId });
            return this.view();
        }
        catch (error) {
            this.settle();
            this.current = failureView(error);
            throw error;
        }
    }
    /** Withdraw whatever is running. */
    cancel() {
        if (this.controller === undefined)
            return this.view();
        this.controller.abort();
        this.listener?.close();
        this.settle();
        this.current = { state: 'cancelled', message: 'The ChatGPT sign-in was cancelled.' };
        return this.view();
    }
    /** Wait for the browser callback, exchange the code, and persist the account. */
    async awaitCallback(input) {
        const { listener } = input;
        try {
            const callback = await listener.waitForCode();
            this.current = { state: 'exchanging', message: 'Finishing the ChatGPT sign-in…' };
            // The issued client id comes from the callback on a new registration and
            // must be saved; the entrypoint value is never stored as a connection.
            const clientId = input.existingClientId ?? callback.clientId;
            if (clientId === undefined || clientId === DYNAMIC_CLIENT_ID) {
                throw new OAuthError('the registration callback carried no issued client_id, so registration is incomplete', 'MISSING_ISSUED_CLIENT_ID');
            }
            if (input.existingClientId !== undefined && callback.clientId !== undefined
                && callback.clientId !== input.existingClientId) {
                // Replacing the account's registration with a different client would
                // silently repoint an existing connection at another identity.
                throw new OAuthError('the callback named a different client_id than the selected account is registered under', 'CLIENT_ID_MISMATCH');
            }
            const tokens = await exchangeCode({
                code: callback.code,
                verifier: input.pkce.verifier,
                clientId,
                redirectUri: listener.redirectUri,
                signal: this.controller?.signal,
            }, this.endpoints());
            if (tokens.idToken === undefined) {
                throw new OAuthError('the token response carried no id_token to validate the identity with', 'ID_TOKEN_MISSING');
            }
            const identity = await verifyIdToken(tokens.idToken, clientId, input.nonce, this.endpoints());
            const credentials = this.deps.credentials();
            if (credentials === undefined)
                throw new ChatGptError('the credential store vanished', 'NO_CREDENTIAL_STORE');
            const account = await saveAccount(credentials, identity.subject, clientId, grantFrom({
                tokens,
                subject: identity.subject,
                clientId,
                hostId: input.hostId,
                issuer: this.endpoints().issuer,
                ...identity.email === undefined ? {} : { email: identity.email },
            }));
            this.settle();
            this.current = {
                state: 'completed',
                accountId: account.id,
                message: planUsageEnabled(account.scopes)
                    ? `Signed in as ${account.email ?? account.subject}. ChatGPT plan usage is enabled.`
                    // A valid sign-in without the plan scope is a real outcome the docs
                    // describe, so it is reported as a limitation rather than a failure.
                    : `Signed in as ${account.email ?? account.subject}, but this grant does not include ChatGPT plan `
                        + 'usage; re-run the sign-in and approve the plan-usage permission.',
            };
        }
        catch (error) {
            this.settle();
            this.current = failureView(error);
        }
    }
    /** Release the attempt's resources, leaving the settled view in place. */
    settle() {
        this.listener?.close();
        this.listener = undefined;
        this.controller = undefined;
    }
}
/** Render a thrown value as an attempt outcome, keeping the code visible. */
function failureView(error) {
    if (error instanceof OAuthError && error.code === 'ACCESS_DENIED') {
        return { state: 'cancelled', message: 'The ChatGPT sign-in was declined in the browser.' };
    }
    if (error instanceof OAuthError && error.code === 'CANCELLED') {
        return { state: 'cancelled', message: 'The ChatGPT sign-in was cancelled.' };
    }
    if (error instanceof ChatGptError || error instanceof OAuthError) {
        return { state: 'failed', error: `${error.code}: ${error.message}` };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { state: 'failed', error: `${codeForStatus(0, message)}: ${message}` };
}
//# sourceMappingURL=signin.js.map