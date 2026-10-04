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
import { deleteAccount, listAccounts, planUsageEnabled, readGrant } from "./accounts.js";
import { revokeSession } from "./oauth.js";
/** Write one JSON response and end the connection. */
function json(res, status, body) {
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'close',
    });
    res.end(JSON.stringify(body));
}
/** Read and parse a JSON request body, bounded so a hostile client cannot balloon memory. */
async function readJson(req) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.byteLength;
        if (total > 64 * 1024)
            throw new Error('request body too large');
        chunks.push(buffer);
    }
    if (total === 0)
        return {};
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null)
        throw new Error('request body must be a JSON object');
    return parsed;
}
/** Read an optional non-empty string field. */
function stringField(body, key) {
    const value = body[key];
    return typeof value === 'string' && value !== '' ? value : undefined;
}
/** Build the status document from live state. */
async function statusOf(deps) {
    const clientModule = deps.clientModule();
    const directory = deps.directory();
    const settingsSectionMounted = deps.settingsSectionMounted();
    const settingsSectionError = deps.settingsSectionError();
    const namespaces = deps.settingsNamespaces();
    const mountError = deps.mountError();
    const catalog = await deps.catalog();
    const credentials = deps.credentials();
    if (credentials === undefined) {
        return { signedIn: false, accounts: [], planEnabled: false, credentialsMissing: true,
            clientModule, directory, settingsSectionMounted,
            ...mountError === undefined ? {} : { mountError },
            ...settingsSectionError === undefined ? {} : { settingsSectionError },
            ...catalog === undefined ? {} : { catalog } };
    }
    const accounts = await listAccounts(credentials);
    const activeAccountId = await deps.activeAccountId();
    const active = accounts.find(account => account.id === activeAccountId);
    const attempt = deps.signIn()?.view();
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
    };
}
/**
 * Handle one request under `/chatgpt/api`.
 * @param req - the incoming request.
 * @param res - the response to own.
 * @param deps - live plugin state.
 * @param pathname - the request path, already parsed.
 */
export async function handleChatGptApi(req, res, deps, pathname) {
    const method = req.method ?? 'GET';
    try {
        if (pathname === '/chatgpt/api/status' && method === 'GET') {
            json(res, 200, await statusOf(deps));
            return;
        }
        if (pathname === '/chatgpt/api/signin' && method === 'POST') {
            const body = await readJson(req);
            const manager = deps.signIn();
            if (manager === undefined) {
                json(res, 503, { error: 'sign-in is unavailable in this composition' });
                return;
            }
            const accountId = stringField(body, 'accountId');
            const attempt = await manager.start(accountId === undefined ? { kind: 'new' } : { kind: 'account', id: accountId });
            json(res, 200, { attempt });
            return;
        }
        if (pathname === '/chatgpt/api/cancel' && method === 'POST') {
            const manager = deps.signIn();
            json(res, 200, { attempt: manager?.cancel() ?? { state: 'idle' } });
            return;
        }
        if (pathname === '/chatgpt/api/selftest' && method === 'POST') {
            const result = await deps.selfTest();
            json(res, 200, result);
            return;
        }
        if (pathname === '/chatgpt/api/select' && method === 'POST') {
            const body = await readJson(req);
            const accountId = stringField(body, 'accountId');
            const credentials = deps.credentials();
            if (accountId === undefined || credentials === undefined) {
                json(res, 400, { error: 'accountId is required' });
                return;
            }
            if (await readGrant(credentials, accountId) === undefined) {
                json(res, 404, { error: 'no such account' });
                return;
            }
            await deps.selectAccount(accountId);
            json(res, 200, await statusOf(deps));
            return;
        }
        if (pathname === '/chatgpt/api/signout' && method === 'POST') {
            const body = await readJson(req);
            const accountId = stringField(body, 'accountId');
            const credentials = deps.credentials();
            if (accountId === undefined || credentials === undefined) {
                json(res, 400, { error: 'accountId is required' });
                return;
            }
            const grant = await readGrant(credentials, accountId);
            if (grant === undefined) {
                json(res, 404, { error: 'no such account' });
                return;
            }
            // Revocation is attempted first because the refresh token is the only
            // handle on the remote session, and it is about to be deleted. A failure
            // to revoke is reported rather than hidden: the docs are explicit that a
            // network failure is not proof of disconnection, and that the user can
            // always disconnect the app from ChatGPT settings.
            let revoked = false;
            let revokeError;
            try {
                await revokeSession({ clientId: grant.clientId, refreshToken: grant.refreshToken });
                revoked = true;
            }
            catch (error) {
                revokeError = error instanceof Error ? error.message : String(error);
                deps.onNotice(`chatgpt: could not revoke the ChatGPT session on sign-out: ${revokeError}`);
            }
            await deleteAccount(credentials, accountId);
            json(res, 200, {
                ...await statusOf(deps),
                revoked,
                ...revokeError === undefined ? {} : { revokeError },
            });
            return;
        }
        json(res, 404, { error: 'not-found' });
    }
    catch (error) {
        // A thrown handler must still answer: an unanswered request leaves the card
        // spinning with no way to learn what happened.
        json(res, 500, { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
    }
}
//# sourceMappingURL=routes.js.map