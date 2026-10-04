/**
 * ChatGPT provider plugin for DeepSeek Harness.
 *
 * It contributes three things:
 *
 * 1. **A provider route** (`chatgpt`) on `ctx.llm`, backed by OpenAI's public
 *    Responses API and authenticated with a Sign-in-with-ChatGPT OAuth access
 *    token, so ChatGPT plan models appear in the model picker like any other
 *    provider.
 * 2. **A sign-in surface** in Settings → Models. The harness's authorization
 *    seam is host-only and nothing in the product consumes it, so an OAuth flow
 *    with no surface of its own can be registered but never started.
 * 3. **Durable account state** in the harness credential document — one
 *    registration per account, plus the stable per-host identifier every
 *    authorization and refresh must repeat.
 *
 * Configuration is optional: signing in is what makes the route usable, and the
 * model catalog comes from the account. The settings section exists mainly so
 * the Models page has a namespace to address and a place to record which saved
 * account requests should bill.
 *
 * @module @bananiceee/dsh-chatgpt-provider
 */
import { createRequire } from 'node:module';
import { accessTokenFor, ensureHostId } from "./accounts.js";
import { ChatGptAdapter, PROVIDER, resolveAccountId } from "./adapter.js";
import { assertServiceable } from "./config.js";
import { fetchRawCatalog } from "./catalog.js";
import { createHostId } from "./oauth.js";
/**
 * This package's own name.
 *
 * Every registry keys a client half by the *package* name, which is not the same
 * string as this plugin's `name` export. The manifest is the single source of it
 * so the two cannot drift. The path is relative to the compiled entry, which
 * sits one level below the package root.
 */
const PACKAGE_NAME = createRequire(import.meta.url)('../package.json').name;
import { handleChatGptApi } from "./routes.js";
import { SignInManager } from "./signin.js";
export { Config } from "./config.js";
export { ChatGptAdapter, PROVIDER } from "./adapter.js";
export { SignInManager } from "./signin.js";
export { ChatGptError } from "./errors.js";
export { accountIdFor, RECORD_SCOPE } from "./accounts.js";
export const name = 'dsh-chatgpt-provider';
/** The provider route cannot serve a request before the LLM registry exists. */
export const inject = ['llm'];
/**
 * The settings address this plugin's configuration lives at.
 *
 * It is the **profile entry id** — the `id` this bundle's `cordis.patch.yml`
 * inserts — because that is what a settings surface keys a form by. The shipped
 * adapters appear to use a private namespace, but their namespace string simply
 * happens to equal their entry id (`llm-pi-ai`, `llm-deepseek`), which is why
 * the coincidence is easy to miss: a plugin whose two names differ gets no row,
 * no editor, and no diagnostic. The Models page joins its provider directory
 * against these ids, so this constant is also the key its card extension is
 * dispatched with.
 */
export const SETTINGS_NS = 'dsh-chatgpt-provider';
/** The path prefix the settings card talks to. */
const API_PREFIX = '/chatgpt/api';
/**
 * Build the settings bridge for whichever service this composition mounts.
 *
 * A failure to address the entry is returned rather than thrown so it can be
 * reported as a diagnostic: an unwritable preference field must not take the
 * provider down, and the reason it is unwritable is not otherwise observable
 * from any surface.
 * @param ctx - the plugin context.
 * @param entryId - the profile entry id this plugin's Config lives on.
 * @returns the bridge, plus why it is unusable when it is.
 */
function settingsBridge(ctx, entryId) {
    const service = ctx.get('settings');
    if (service === undefined) {
        return { bridge: { kind: 'absent', write: async () => { } }, error: 'no settings service is mounted' };
    }
    if (typeof service.describe === 'function' && typeof service.update === 'function') {
        return {
            bridge: {
                kind: 'projected',
                write: async (field, value) => {
                    // The revision fences the write, so a concurrent edit from another
                    // tab is refused instead of silently overwritten.
                    const entry = service.describe().find(candidate => candidate.ns === entryId);
                    if (entry === undefined) {
                        throw new Error(`the settings service serves no entry named "${entryId}"`);
                    }
                    await service.update(entryId, { [field]: value }, entry.revision);
                },
            },
        };
    }
    if (typeof service.register === 'function') {
        // Legacy shape: the plugin owns a namespace of its own rather than having
        // its Config projected. Nothing here writes, so the bridge is read-only.
        return { bridge: { kind: 'registered', write: async () => { } } };
    }
    return {
        bridge: { kind: 'absent', write: async () => { } },
        error: 'the settings service exposes neither describe/update nor register',
    };
}
/**
 * Which settings address this plugin's own config is served under.
 *
 * The address is a **profile entry id**, and which spelling that is depends on
 * how the row entered the tree: a row a bundle *inserts* is addressed by its
 * entry id (`include:<id>`) while a row the profile patch declares is addressed
 * by its patch id (`<id>`). Rather than guess — a wrong guess is silent, because
 * a provider whose address is unresolvable simply never gets a row — the service
 * is asked which of the candidate spellings it actually serves. The candidates
 * are tried in order and the first that resolves wins; when none does, the
 * available names are reported so the mismatch is legible instead of invisible.
 * @param ctx - the plugin context.
 * @param patchId - the `id` this bundle's patch declares for the row.
 * @returns the address to declare, plus why none resolved when none did.
 */
function resolveSettingsEntry(ctx, patchId) {
    const candidates = [patchId, `include:${patchId}`, PACKAGE_NAME, `include:${PACKAGE_NAME}`];
    const service = ctx.get('settings');
    if (service === undefined) {
        return { ns: patchId, served: false, available: [], error: 'no settings service is mounted' };
    }
    if (typeof service.describe !== 'function') {
        return { ns: patchId, served: false, available: [],
            error: 'this settings service does not expose describe()' };
    }
    let available;
    try {
        available = service.describe().map(entry => String(entry.ns));
    }
    catch (error) {
        return { ns: patchId, served: false, available: [],
            error: error instanceof Error ? error.message : String(error) };
    }
    const hit = candidates.find(candidate => available.includes(candidate));
    return hit === undefined
        ? { ns: patchId, served: false, available,
            error: `none of ${candidates.map(name => `"${name}"`).join(', ')} is a settings entry; the service `
                + `serves ${available.length === 0 ? 'none' : available.map(name => `"${name}"`).join(', ')}` }
        : { ns: hit, served: true, available };
}
/** Register the ChatGPT provider route, its settings section, and its sign-in surface. */
export function apply(ctx, config) {
    let current = () => config;
    /**
     * The live configuration.
     *
     * Re-judged on every read rather than at load: a programmatic entry can
     * bypass Schemastery, and a stored section lands here before anything else
     * looks at it, so an unserviceable value must be refused at the point it
     * would be used.
     */
    const resolved = () => assertServiceable(current());
    const credentials = () => ctx.get('credentials');
    // The host id is generated once and persisted, then memoized for the process:
    // every attempt from this host must repeat the same value and no other host
    // may share it, so it can never be derived from anything that varies per call.
    let hostIdPromise;
    const hostId = () => {
        hostIdPromise ??= (async () => {
            const store = credentials();
            if (store === undefined) {
                throw new Error("chatgpt: no credential store to persist this host's identifier in");
            }
            return ensureHostId(store, createHostId);
        })();
        return hostIdPromise;
    };
    /** The account a request bills: the configured one, else the newest sign-in. */
    const activeAccountId = async () => {
        const configured = selectedAccount ?? resolved().account;
        const id = await resolveAccountId(credentials(), configured);
        if (configured !== undefined && configured !== '' && id !== configured) {
            // Says what actually happens: the named account is gone (most often signed
            // out) and the newest sign-in is billed instead. Leaving requests unable
            // to serve because a stale id is still in the settings would be worse.
            ctx.logger.warn('chatgpt: the configured account "%s" is not saved; billing the account "%s" instead', configured, id ?? '(none)');
        }
        return id;
    };
    const adapter = new ChatGptAdapter({
        config: resolved,
        credentials,
        accountId: activeAccountId,
        readImage: async (ref, signal) => {
            const attachments = ctx.get('attachments');
            if (attachments === undefined) {
                throw new Error('chatgpt: this deployment mounts no attachment service to resolve request images');
            }
            return attachments.readImage(ref, signal);
        },
        onNotice: (message) => { ctx.logger.warn(message); },
    });
    /**
     * Send one small real request through the adapter.
     *
     * This is what turns "a credential is stored" into "the credential works":
     * the card can only claim the provider is usable if a model actually
     * answered, and the failure a user hits first (an expired grant, a limit, a
     * revoked session) surfaces here by name instead of on their next prompt.
     */
    const selfTest = async () => {
        const config = resolved();
        const models = await adapter.listModels(PROVIDER);
        // Prefer the configured probe model, then a `luna` model, then whatever the
        // account lists first. The probe is about connectivity, and picking the
        // endpoint's first entry made the reported model an accident of ordering.
        const preferred = config.testModel;
        const model = preferred !== undefined && preferred !== ''
            ? preferred
            : models.find(entry => entry.id.includes('luna'))?.id ?? models[0]?.id;
        if (model === undefined) {
            return { ok: false, error: 'no ChatGPT model is available; sign in and try again' };
        }
        const chunks = [];
        try {
            for await (const chunk of adapter.stream({
                provider: PROVIDER,
                model,
                // A hand-built one-shot probe rather than a session request: the adapter
                // reads only role, content, and source off these values, and building a
                // real Message would pull the session machinery into a diagnostic path.
                messages: [{
                        id: 'chatgpt-selftest',
                        role: 'user',
                        content: [{ type: 'text', text: 'Reply with exactly: ok' }],
                        source: { kind: 'user' },
                    }],
                // The lowest level the route accepts: the probe is about connectivity,
                // not reasoning depth, and `off` is not a level this route takes.
                reasoningEffort: 'low',
                signal: AbortSignal.timeout(60_000),
            })) {
                chunks.push(chunk);
            }
        }
        catch (error) {
            const failure = error;
            return { ok: false, model, error: `${failure.code ?? 'REQUEST_FAILED'}: ${failure.message ?? String(error)}` };
        }
        let finish;
        let usage;
        for (const chunk of chunks) {
            if (chunk.type === 'finish')
                finish = chunk;
            else if (chunk.type === 'usage')
                usage = chunk;
        }
        if (finish === undefined) {
            return { ok: false, model, error: 'the provider ended the stream without a terminal event' };
        }
        if (finish.reason.kind === 'error' || finish.reason.kind === 'aborted') {
            return { ok: false, model, error: `${finish.reason.failure.code}: ${finish.reason.failure.message}` };
        }
        const text = chunks
            .flatMap(chunk => chunk.type === 'block-end' && chunk.block.type === 'text' ? [chunk.block.text] : [])
            .join('')
            .trim();
        return {
            ok: true,
            model,
            text: text.slice(0, 500),
            ...usage === undefined
                ? {}
                : { usage: { inputTokens: usage.usage.inputTokens, outputTokens: usage.usage.outputTokens } },
        };
    };
    /**
     * Ask the client module registry what it knows about this plugin's browser
     * half. An extension area with no registrant renders nothing, silently, so
     * "the card did not appear" is otherwise indistinguishable from "the browser
     * half never loaded" — and that question cannot be answered from the page.
     */
    const clientModule = () => {
        /** A package this application certainly ships a client half for. */
        const CONTROL = '@deepseek-ai/dsh-client-ui-settings-models';
        const registry = ctx.get('clientModules');
        const probe = (id) => {
            if (registry === undefined || typeof registry.clientPath !== 'function') {
                return { registered: false, served: false };
            }
            let path;
            try {
                // The registry is keyed by **package name**; a plugin's `name` export is
                // a different string and asking with it silently answers "no entry".
                path = registry.clientPath(id);
            }
            catch {
                return { registered: false, served: false };
            }
            let entry;
            try {
                entry = registry.graph?.()?.entries?.find(candidate => candidate.id === id);
            }
            catch {
                // A graph that cannot be read is reported as "not served" below.
            }
            return {
                registered: path !== undefined,
                ...path === undefined ? {} : { path },
                served: entry !== undefined,
                ...entry?.url === undefined ? {} : { url: entry.url },
            };
        };
        if (registry === undefined || typeof registry.clientPath !== 'function') {
            return {
                packageName: PACKAGE_NAME,
                registered: false,
                served: false,
                control: { packageName: CONTROL, registered: false, served: false },
                note: 'this composition mounts no client module registry, so there is no browser surface to extend',
            };
        }
        const mine = probe(PACKAGE_NAME);
        const control = probe(CONTROL);
        return {
            packageName: PACKAGE_NAME,
            ...mine,
            control: { packageName: CONTROL, registered: control.registered, served: control.served },
            note: !control.registered
                ? 'the control package is also unresolved, so this probe cannot be trusted in this composition'
                : mine.registered
                    ? mine.served
                        ? 'ok'
                        : 'the bundle resolves but the boot graph does not list it, so the page never loads it'
                    : 'the registry holds no client entry for this package; it declares dsh.client and ships the bundle '
                        + 'its ./client export names, so the entry was skipped — check the boot log for a client-modules '
                        + 'activation error',
        };
    };
    /**
     * Ask the LLM registry how this plugin's route is registered.
     *
     * A provider that is absent from the configurable directory has no settings
     * address for a configuration surface to render, so its card never appears —
     * and that failure is invisible from the page, which simply shows nothing.
     */
    const directory = () => {
        let routes = [];
        try {
            routes = ctx.llm.listProviders().map(entry => entry.id);
        }
        catch {
            // A registry that cannot be listed is reported as "not live" below.
        }
        let entries = [];
        try {
            entries = ctx.llm.listConfigurableProviders();
        }
        catch {
            // Likewise; the note distinguishes the two cases.
        }
        const routeLive = routes.includes(PROVIDER);
        const inDirectory = entries.some(entry => entry.provider === PROVIDER);
        return {
            routeLive,
            routes,
            inDirectory,
            directorySize: entries.length,
            note: routeLive && inDirectory
                ? 'ok'
                : routeLive
                    ? 'the route serves requests but the configurable directory does not list it, so no configuration '
                        + 'surface will render a row for it'
                    : 'the route is not registered; the adapter registration did not take effect',
        };
    };
    /**
     * Report the account's raw listing beside the displayed catalog.
     *
     * Cheap and read-only, and it answers the one question a picker cannot: which
     * models the account has but this adapter chose not to display.
     */
    const catalogReport = async () => {
        const store = credentials();
        const accountId = await activeAccountId().catch(() => undefined);
        if (store === undefined || accountId === undefined)
            return undefined;
        try {
            const { accessToken } = await accessTokenFor(store, accountId);
            const raw = await fetchRawCatalog(accessToken);
            const displayed = await adapter.listModels(PROVIDER);
            return {
                displayed: displayed.length,
                reported: raw.map(entry => ({
                    id: entry.id,
                    ...entry.visibility === undefined ? {} : { visibility: entry.visibility },
                })),
            };
        }
        catch {
            // A listing failure is not a status failure; the field is simply absent.
            return undefined;
        }
    };
    const signIn = new SignInManager({
        credentials,
        config: resolved,
        hostId,
        onNotice: (message) => { ctx.logger.info(message); },
    });
    // Which settings shape this composition exposes, and whether it serves this
    // plugin's entry. Both are reported as diagnostics: a provider whose entry a
    // configuration surface cannot address gets no row and no editor, and nothing
    // about that failure is visible from the surface itself.
    //
    // Order matters here, and it is diagnosis-first: the HTTP surface is
    // registered BEFORE any step that can throw, because a throw aborts `apply()`
    // and would otherwise take down the very endpoint that explains why. Every
    // fallible mount step then reports through it instead of being fatal.
    const settings = settingsBridge(ctx, SETTINGS_NS);
    let entry = { ns: SETTINGS_NS, served: false, available: [] };
    let sectionError;
    let mountError;
    // A selection made in this process takes effect immediately rather than
    // waiting for the loader to hand back a re-resolved config.
    let selectedAccount;
    // Optional: a headless composition has no browser to sign in from, and every
    // other part of this plugin still works without one.
    ctx.inject(['webServer'], (sctx) => {
        sctx.effect(() => sctx.webServer.register({
            kind: 'prefix',
            path: API_PREFIX,
            handler: (req, res) => {
                const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
                // The promise is returned rather than discarded so the server can
                // sequence on it and a rejection is observed instead of escaping.
                return handleChatGptApi(req, res, {
                    credentials,
                    signIn: () => signIn,
                    activeAccountId,
                    selfTest,
                    clientModule,
                    directory,
                    settingsSectionMounted: () => entry.served,
                    settingsNamespaces: () => ({ declared: entry.ns, available: entry.available }),
                    settingsSectionError: () => sectionError,
                    mountError: () => mountError,
                    catalog: catalogReport,
                    selectAccount: async (accountId) => {
                        selectedAccount = accountId;
                        await settings.bridge.write('account', accountId);
                    },
                    onNotice: (message) => { ctx.logger.warn(message); },
                }, pathname);
            },
        }), 'dsh-chatgpt-provider: sign-in API');
    });
    try {
        // Ask the service which spelling it serves rather than assuming one.
        entry = resolveSettingsEntry(ctx, SETTINGS_NS);
        sectionError = settings.error ?? entry.error;
        if (sectionError !== undefined) {
            ctx.logger.warn('chatgpt: preferences are not writable from a configuration surface: %s', sectionError);
        }
        // The directory entry is what puts a row and a card on the Models page;
        // registering the adapter is what makes the provider live rather than
        // dormant. An empty registration is refused by the registry, so this is
        // built before it is passed.
        ctx.llm.registerConfigurableProviders([
            {
                provider: PROVIDER,
                displayName: resolved().displayName ?? 'ChatGPT',
                settingsNs: entry.ns,
                settingsPath: [],
            },
        ]);
        ctx.llm.registerAdapter([PROVIDER], adapter);
    }
    catch (error) {
        // Reported, never fatal: a provider that failed to register must still leave
        // a surface that says so.
        mountError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        ctx.logger.error('chatgpt: the provider route could not be registered: %s', mountError);
    }
}
//# sourceMappingURL=index.js.map