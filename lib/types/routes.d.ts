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
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AccountView, CredentialStoreLike } from './accounts.ts';
import type { AttemptView, SignInManager } from './signin.ts';
/** Everything the routes need from the plugin. */
export interface RouteDeps {
    credentials: () => CredentialStoreLike | undefined;
    signIn: () => SignInManager | undefined;
    /** The account a request currently bills. */
    activeAccountId: () => Promise<string | undefined>;
    /** Persist the account selection through the settings section. */
    selectAccount: (accountId: string) => Promise<void>;
    /** Report what the client module registry knows about the browser half. */
    clientModule: () => ClientModuleReport;
    /** Report what the LLM registry knows about the provider route. */
    directory: () => DirectoryReport;
    /** Report whether this plugin's settings section registered. */
    settingsSectionMounted: () => boolean;
    /** Report why the settings section could not be registered, if it could not. */
    settingsSectionError: () => string | undefined;
    /** Report why the provider route could not be registered, if it could not. */
    mountError: () => string | undefined;
    /** Report the settings address this plugin declares, and what the service serves. */
    settingsNamespaces: () => {
        declared: string;
        available: string[];
    };
    /** Report the account's raw model listing next to what is displayed. */
    catalog: () => Promise<{
        displayed: number;
        reported: {
            id: string;
            visibility?: string;
        }[];
    } | undefined>;
    /**
     * Send one small real request through the provider, so the card can prove the
     * credential actually works instead of only reporting that it is stored.
     */
    selfTest: () => Promise<SelfTestResult>;
    onNotice: (message: string) => void;
}
/** Outcome of one end-to-end probe request. */
export interface SelfTestResult {
    /** Whether a model answered. */
    ok: boolean;
    /** The model that answered. */
    model?: string;
    /** The reply text, trimmed for display. */
    text?: string;
    /** Reported token usage, when the provider disclosed it. */
    usage?: {
        inputTokens: number;
        outputTokens: number;
    };
    /** Why the probe failed, when it did. */
    error?: string;
}
/** The status document the card renders from. */
export interface ChatGptStatus {
    /** True when at least one account is saved and the credential seam is mounted. */
    signedIn: boolean;
    accounts: AccountView[];
    activeAccountId?: string;
    /** Whether the active account's grant authorizes ChatGPT plan usage. */
    planEnabled: boolean;
    /** The in-flight or last attempt, when there is one. */
    attempt?: AttemptView;
    /** True when the composition mounts no credential service at all. */
    credentialsMissing: boolean;
    /**
     * What the client module registry knows about this plugin's browser half.
     *
     * The settings card is contributed through that registry, and an extension
     * area with no registrant renders **nothing at all** — no error, no empty
     * state. So when the card does not appear, this is the first question worth
     * answering, and it cannot be answered from the browser.
     */
    clientModule: ClientModuleReport;
    /** What the LLM registry knows about this plugin's provider route. */
    directory: DirectoryReport;
    /**
     * Whether this plugin's settings section actually registered.
     *
     * The Models page joins the provider directory against the served settings
     * namespaces, so a provider whose namespace never registered has no address
     * the page can read or write — and it renders no row for it.
     */
    settingsSectionMounted: boolean;
    /** Why the settings section could not be registered, when it could not. */
    settingsSectionError?: string;
    /**
     * Why the provider route could not be registered, when it could not.
     *
     * A mount step that throws would otherwise abort `apply()` and take this
     * endpoint down with it — leaving a broken provider and no way to ask why —
     * so the failure is caught, reported here, and the rest keeps serving.
     */
    mountError?: string;
    /** The settings address this plugin's config is declared under. */
    settingsSettingsNamespace?: string;
    /** Every settings address the service serves, for diagnosing a mismatch. */
    settingsNamespaces?: string[];
    /**
     * What the account's model listing reported, and what this adapter displays.
     *
     * A model missing from the picker is otherwise indistinguishable from a model
     * the account does not have, which makes "why can't I select X" unanswerable.
     */
    catalog?: {
        displayed: number;
        reported: {
            id: string;
            visibility?: string;
        }[];
    };
}
/** Whether the provider route is live, dormant, and visible to configuration surfaces. */
export interface DirectoryReport {
    /** `listProviders()` contains this route: it can serve a request right now. */
    routeLive: boolean;
    /** Every route `listProviders()` reports, in registration order. */
    routes: string[];
    /** `listConfigurableProviders()` contains this entry: configuration surfaces should offer it. */
    inDirectory: boolean;
    /** How many entries the directory holds in total. */
    directorySize: number;
    /** A one-line account of the verdict. */
    note: string;
}
/** Whether the page will be told to load this plugin's browser half. */
export interface ClientModuleReport {
    /** The package name the registry is keyed by — not the plugin's `name`. */
    packageName: string;
    /** The registry resolved a bundle path for this package. */
    registered: boolean;
    /** Resolved bundle path on disk, when it is registered. */
    path?: string;
    /** The boot graph lists this package, so the page preloads it. */
    served: boolean;
    /** The URL the page would fetch, when the graph lists it. */
    url?: string;
    /**
     * What the same probe reports for a package known to ship a client half.
     * Without this control, a `false` from a probe that is itself wrong looks
     * exactly like a genuinely unregistered plugin.
     */
    control: {
        packageName: string;
        registered: boolean;
        served: boolean;
    };
    /** A one-line account of the verdict. */
    note: string;
}
/**
 * Handle one request under `/chatgpt/api`.
 * @param req - the incoming request.
 * @param res - the response to own.
 * @param deps - live plugin state.
 * @param pathname - the request path, already parsed.
 */
export declare function handleChatGptApi(req: IncomingMessage, res: ServerResponse, deps: RouteDeps, pathname: string): Promise<void>;
