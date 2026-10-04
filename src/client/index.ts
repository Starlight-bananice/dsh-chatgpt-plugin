/**
 * Browser entry for the ChatGPT provider plugin.
 *
 * It contributes one surface: the extension area inside this provider's card on
 * Settings → Models. The Models page dispatches
 * `settings.models.provider-card` with the row's settings namespace as the key,
 * so registering under `chatgpt` puts the sign-in controls exactly where a user
 * looks for a provider that needs an account.
 *
 * The `ctx` face is declared structurally, matching the runtime services rather
 * than a package's declarations — the shipped application has no `.d.ts` for
 * its client packages, and describing what is actually used keeps this entry
 * building against any version that provides `slots`, `locale`, and `effect`.
 *
 * @module dsh-chatgpt-provider/client
 */

import { ChatGptCard } from './Card.tsx'
import { ChatGptSection } from './Section.tsx'
import { en, NS, zh } from './locales.ts'
import { installStyles } from './styles.ts'

/** The Models-page extension area this card also occupies. */
const SLOT = 'settings.models.provider-card'

/** The Settings-sidebar seat this plugin's own page occupies. */
const SECTION_SLOT = 'settings.section'

/**
 * The key the Models page dispatches with.
 *
 * It must equal the directory entry's `settingsNs`, which is this plugin's
 * profile entry id — not a name of the plugin's own choosing. A mismatch is
 * silent: the page dispatches one key, nothing is registered under it, and the
 * extension area simply renders nothing.
 */
const KEY = 'dsh-chatgpt-provider'

/**
 * Where this plugin's page sits in the Settings sidebar. The shipped pages use
 * low orders and the sibling plugin's page uses 40, so this lands after them.
 */
const SECTION_ORDER = 45

/** The slots face, as the runtime service provides it. */
interface SlotsService {
  inject(key: string, callback: () => () => void): () => void
  register(options: Record<string, unknown>, component: unknown): () => void
}

/** Locale registration, as the runtime service provides it. */
interface LocaleService {
  register(ns: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): void
  /** Bind a namespace to a translator, for a label resolved lazily. */
  bind(ns: string): (key: string, params?: Record<string, string | number>) => string
}

/** The client context this entry needs. */
interface ClientContext {
  slots: SlotsService
  locale: LocaleService
  effect(fn: () => void | (() => void), label: string): void
}

export const inject = ['slots', 'locale']

/** Install the stylesheet, the dictionaries, and the provider-card extension. */
export function apply(ctx: ClientContext): void {
  ctx.effect(installStyles, 'dsh-chatgpt-provider: styles')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-chatgpt-provider: locale')
  // `inject` waits for the Models page to declare the slot, so this entry can
  // load before the page it extends and still land.
  ctx.slots.inject(SLOT, () => ctx.slots.register({ name: SLOT, key: KEY, locale: NS }, ChatGptCard))

  // The plugin's own Settings page. It is registered independently of the
  // Models-page seat on purpose: this page talks to the plugin's own HTTP
  // surface, so it keeps working even when the settings namespace — which the
  // Models page needs to build a provider row — is unavailable.
  ctx.slots.inject(SECTION_SLOT, () => ctx.slots.register({
    name: SECTION_SLOT,
    id: 'chatgpt',
    order: SECTION_ORDER,
    label: () => ctx.locale.bind(NS)('nav'),
    locale: NS,
  }, ChatGptSection))
}
