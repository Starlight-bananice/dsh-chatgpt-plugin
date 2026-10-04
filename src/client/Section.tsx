/**
 * The dedicated ChatGPT settings page.
 *
 * This is the plugin's own entry in the Settings sidebar, independent of the
 * Models page. It exists because the Models page renders a provider row only
 * for a provider whose settings namespace the Host actually serves, and joins
 * that row against the settings mirror — so a provider whose namespace failed
 * to register has no row, no card, and no visible sign that anything is wrong.
 * A page of this plugin's own has no such dependency: it talks to the plugin's
 * own HTTP surface, which is registered independently of settings.
 *
 * @module dsh-chatgpt-provider/client/section
 */

import { ChatGptCard } from './Card.tsx'
import type { Translate } from './Card.tsx'

/** Props the `settings.section` seat passes to a page. */
export interface ChatGptSectionProps {
  t: Translate
}

/**
 * Render the ChatGPT settings page.
 * @param props - the seat's composed props, of which `t` is used.
 * @returns the page's element tree.
 */
export function ChatGptSection({ t }: ChatGptSectionProps) {
  return (
    <div className="cgpt-page">
      <h2 className="cgpt-pageTitle">{t('nav')}</h2>
      <p className="cgpt-pageLede">{t('pageLede')}</p>
      <ChatGptCard t={t} />
    </div>
  )
}
