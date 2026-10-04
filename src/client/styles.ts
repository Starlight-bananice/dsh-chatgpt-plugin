/**
 * The card's stylesheet.
 *
 * Injected as a plain `<style>` element rather than imported as a CSS module:
 * the bundle-purity rules reject value imports across plugin packages, and a
 * stylesheet that ships with the bundle would otherwise need the host's CSS
 * pipeline. Class names are prefixed `cgpt-` to stay collision-free, and colors
 * come from the application's own CSS variables with literal fallbacks so the
 * card matches whichever theme is active.
 *
 * @module dsh-chatgpt-provider/client/styles
 */

/** Class name prefix for this card. */
const P = 'cgpt'

/** The stylesheet this card installs once. */
export const STYLES = `
.${P}-page { display: flex; flex-direction: column; gap: 10px; max-width: 46rem; }
.${P}-pageTitle { margin: 0; font-size: 16px; font-weight: 600; }
.${P}-pageLede {
  margin: 0; font-size: 13px; line-height: 1.6;
  color: var(--dsw-alias-label-tertiary, #9aa0aa);
}
.${P}-root { display: flex; flex-direction: column; gap: 8px; font-size: 13px; }
.${P}-head { display: flex; align-items: baseline; gap: 6px; }
.${P}-title { font-weight: 600; }
.${P}-muted { color: var(--dsw-alias-label-tertiary, #9aa0aa); }
.${P}-error { color: var(--dsw-alias-label-error, #c0392b); white-space: pre-wrap; }
.${P}-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.${P}-stack { display: flex; flex-direction: column; gap: 6px; }
.${P}-account {
  display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;
  padding: 6px 8px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35));
  border-radius: 6px;
}
.${P}-button {
  padding: 5px 10px; border-radius: 6px; font-size: 13px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.45));
  background: transparent; color: inherit; text-decoration: none; line-height: 1.5;
}
.${P}-button:disabled { opacity: 0.5; cursor: default; }
.${P}-button:hover:not(:disabled) { border-color: var(--dsw-alias-label-secondary, currentColor); }
.${P}-button.${P}-primary {
  background: var(--dsw-alias-bg-inverted, #000);
  color: var(--dsw-alias-label-inverted, #fff);
  border-color: var(--dsw-alias-bg-inverted, #000);
}
.${P}-link { color: inherit; text-decoration: underline; word-break: break-all; }
`

/** Install the stylesheet once, returning its remover. */
export function installStyles(): () => void {
  const element = document.createElement('style')
  element.dataset['dshChatgptProvider'] = ''
  element.textContent = STYLES
  document.head.append(element)
  return () => { element.remove() }
}
