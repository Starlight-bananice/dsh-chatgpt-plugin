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
import type { Context } from 'cordis';
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings';
import type { Config } from './config.ts';
export { Config } from './config.ts';
export type { Config as ChatGptConfig } from './config.ts';
export { ChatGptAdapter, PROVIDER } from './adapter.ts';
export { SignInManager } from './signin.ts';
export { ChatGptError } from './errors.ts';
export { accountIdFor, RECORD_SCOPE } from './accounts.ts';
export type { AccountView } from './accounts.ts';
export declare const name = "dsh-chatgpt-provider";
/** The provider route cannot serve a request before the LLM registry exists. */
export declare const inject: string[];
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
export declare const SETTINGS_NS: SettingsNamespace;
/** Register the ChatGPT provider route, its settings section, and its sign-in surface. */
export declare function apply(ctx: Context, config: Config): void;
