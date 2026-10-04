#!/usr/bin/env node
/**
 * Browser-half contract test.
 *
 * The client bundle is a lazy-CJS factory the page evaluates, so nothing else
 * in the suite has ever executed it. This test does, in a real DOM: it captures
 * the `window.__ModuleLoader__.load(...)` registration exactly as the page's
 * module system does, runs the factory, applies the plugin against a stub
 * client context, and then **mounts the component with React** so its effects,
 * its fetches, and its state transitions actually run. That covers the class of
 * failure a build cannot catch: a wrong registration shape, a thrown `apply`,
 * a locale key missing from one dictionary, or a component that crashes — or
 * silently renders nothing — on a real render.
 *
 * Usage: node tests/client.mjs
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const require = createRequire(join(ROOT, 'package.json'))
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const bundle = readFileSync(join(ROOT, 'lib/client.js'), 'utf8')

const React = require('react')
const { act } = React
const { createRoot } = require('react-dom/client')

// ── A real DOM, installed before the bundle is evaluated ─────────────────────
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  url: 'http://127.0.0.1:19387/',
  pretendToBeVisual: true,
})
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.IS_REACT_ACT_ENVIRONMENT = true
// The card opens the authorization page in a new tab; jsdom's own open logs a
// "not implemented" notice, so it is replaced with a recorder the tests assert on.
const opened = []
dom.window.open = url => { opened.push(url); return null }

// ── Evaluate the bundle the way the page does ────────────────────────────────
let registration
dom.window.__ModuleLoader__ = { load(value) { registration = value } }
const shim = specifier => require(specifier)
// eslint-disable-next-line no-new-func -- the bundle is CJS by contract
new Function('window', 'require', bundle)(dom.window, shim)
const clientModule = registration.factory(shim)

/** A stub client context recording every registration. */
function clientContext() {
  const seen = { effects: [], locales: [], injected: [], registered: [] }
  return {
    seen,
    ctx: {
      effect(fn, label) { seen.effects.push({ label, dispose: fn() }) },
      locale: { register(ns, dictionaries) { seen.locales.push({ ns, dictionaries }) } },
      slots: {
        inject(slot, callback) { seen.injected.push({ slot, callback }); return () => {} },
        register(options, component) {
          seen.registered.push({ options, component })
          return () => {}
        },
      },
    },
  }
}

const { seen, ctx } = clientContext()
let applyError
try {
  clientModule.apply(ctx)
} catch (error) {
  applyError = error
}

let passed = 0
const failures = []
async function check(name, fn) {
  try {
    await fn()
    passed += 1
    process.stdout.write(`  ok  ${name}\n`)
  } catch (error) {
    failures.push({ name, error })
    process.stdout.write(`FAIL  ${name}\n      ${error?.message ?? error}\n`)
  }
}

/** Settle pending effects and microtasks. */
async function settle(ticks = 8) {
  for (let tick = 0; tick < ticks; tick += 1) {
    await act(async () => { await new Promise(resolve => { setTimeout(resolve, 0) }) })
  }
}

/** Mount the registered component and let its effects run. */
/** The registered component for one seat. */
function componentOf(slot) {
  const entry = seen.registered.find(candidate => candidate.options.name === slot)
  if (entry === undefined) throw new Error(`no registration for ${slot}`)
  return entry.component
}

async function render(props, slot = 'settings.models.provider-card') {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => { root.render(React.createElement(componentOf(slot), props)) })
  await settle()
  return { host, root }
}

/** Point the card's API calls at a fixed status document. */
function answerWith(status, { record } = {}) {
  globalThis.fetch = async (path, init) => {
    record?.push({ path, init })
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(typeof status === 'function' ? status(path) : status),
    }
  }
}

/** Clear the seat between renders so assertions read one card at a time. */
function resetBody() {
  document.body.replaceChildren()
}

const t = key => `t:${key}`
const ACCOUNT = { id: 'acct-1', subject: 's', email: 'user@example.com', clientId: 'c',
  planEnabled: true, expiresAt: 0, savedAt: '2026-01-01T00:00:00Z' }

process.stdout.write('module face\n')

await check('the bundle registers under the package name the profile installed', () => {
  assert.equal(registration.id, manifest.name)
  assert.equal(typeof registration.factory, 'function')
})

await check('the module exports the client plugin face', () => {
  assert.deepEqual(clientModule.inject, ['slots', 'locale'])
  assert.equal(typeof clientModule.apply, 'function')
})

process.stdout.write('apply\n')

await check('apply() completes without throwing', () => {
  assert.equal(applyError, undefined, applyError === undefined ? '' : String(applyError))
})

await check('it installs exactly two effects and registers one dictionary set', () => {
  assert.equal(seen.effects.length, 2, `expected styles + locale effects, saw ${String(seen.effects.length)}`)
  assert.equal(seen.locales.length, 1)
  assert.equal(seen.locales[0].ns, 'chatgpt-provider')
  assert.equal(typeof seen.effects[0].dispose, 'function', 'the stylesheet effect must be disposable')
})

await check('zh and en dictionaries carry the same keys, and no value is empty', () => {
  const { zh, en } = seen.locales[0].dictionaries
  const zhKeys = Object.keys(zh).sort()
  const enKeys = Object.keys(en).sort()
  assert.ok(zhKeys.length > 0)
  assert.deepEqual(enKeys, zhKeys, 'en must be complete against the zh key set')
  for (const key of zhKeys) {
    assert.ok(typeof zh[key] === 'string' && zh[key] !== '', `zh.${key} must be a non-empty string`)
    assert.ok(typeof en[key] === 'string' && en[key] !== '', `en.${key} must be a non-empty string`)
  }
})

await check('it waits for each seat to be declared before registering into it', () => {
  assert.equal(seen.injected.length, 2, 'the Models card and the plugin page are both contributed')
  assert.deepEqual(seen.injected.map(entry => entry.slot).sort(),
    ['settings.models.provider-card', 'settings.section'])
  // A seat exists only once its owner declares it, so registration happens
  // inside the injection callback rather than eagerly.
  assert.equal(seen.registered.length, 0, 'nothing may register before its slot is declared')
  for (const injection of seen.injected) injection.callback()
  assert.equal(seen.registered.length, 2)
})

await check('the Models-page registration targets the plugin settings namespace', () => {
  const entry = seen.registered.find(candidate => candidate.options.name === 'settings.models.provider-card')
  assert.ok(entry !== undefined, 'the provider-card seat must be claimed')
  // The page dispatches with the directory row's settingsNs, which is the
  // profile entry id; registering under any other key renders nothing, silently.
  assert.equal(entry.options.key, 'dsh-chatgpt-provider',
    'the key must equal the settingsNs the directory entry declares')
  assert.equal(entry.options.locale, 'chatgpt-provider')
  assert.equal(typeof entry.component, 'function')
})

await check('the plugin page claims its own Settings-sidebar entry', () => {
  const entry = seen.registered.find(candidate => candidate.options.name === 'settings.section')
  assert.ok(entry !== undefined, 'the settings.section seat must be claimed')
  assert.equal(entry.options.id, 'chatgpt')
  assert.equal(typeof entry.options.order, 'number')
  assert.equal(entry.options.locale, 'chatgpt-provider')
  // The label is resolved lazily so a language change relabels the entry.
  assert.equal(typeof entry.options.label, 'function')
  assert.equal(typeof entry.component, 'function')
})

await check('one stylesheet is installed and unloading removes it', () => {
  const selector = 'style[data-dsh-chatgpt-provider]'
  assert.equal(document.head.querySelectorAll(selector).length, 1)
  assert.match(document.head.querySelector(selector).textContent, /\.cgpt-root/)
  seen.effects[0].dispose()
  assert.equal(document.head.querySelectorAll(selector).length, 0)
})

process.stdout.write('render\n')

await check('the signed-out state shows the prescribed action and the usage link', async () => {
  resetBody()
  answerWith({ signedIn: false, accounts: [], planEnabled: false, credentialsMissing: false })
  const { host, root } = await render({ t })
  const text = host.textContent
  assert.match(text, /t:title/)
  // The label OpenAI's UI guidelines prescribe for a first sign-in.
  assert.match(text, /t:continue/)
  assert.match(text, /t:intro/)
  assert.ok(host.querySelector('a[href="https://chatgpt.com/settings/usage"]') !== null,
    'the Manage usage link must be present')
  root.unmount()
})

await check('a signed-in account renders its identity, the plan indicator, and Test', async () => {
  resetBody()
  answerWith({ signedIn: true, accounts: [ACCOUNT], activeAccountId: 'acct-1',
    planEnabled: true, credentialsMissing: false })
  const { host, root } = await render({ t })
  const text = host.textContent
  assert.match(text, /user@example\.com/, 'the account email must be shown')
  assert.match(text, /t:usingPlan/, 'the plan indicator must be shown')
  assert.match(text, /t:test/, 'the probe action must be offered once signed in')
  assert.match(text, /t:signOut/)
  assert.match(text, /t:different/, 'adding another account must be offered')
  root.unmount()
})

await check('a grant without plan usage is reported as a limitation, not a success', async () => {
  resetBody()
  answerWith({ signedIn: true, accounts: [{ ...ACCOUNT, planEnabled: false }],
    activeAccountId: 'acct-1', planEnabled: false, credentialsMissing: false })
  const { host, root } = await render({ t })
  assert.match(host.textContent, /t:noPlan/)
  assert.doesNotMatch(host.textContent, /t:usingPlan/, 'the indicator must not claim usage the grant lacks')
  root.unmount()
})

await check('a pending attempt opens the authorization page and offers a manual link', async () => {
  resetBody()
  const authorize = 'https://auth.openai.com/api/accounts/authorize?x=1'
  answerWith({ signedIn: false, accounts: [], planEnabled: false, credentialsMissing: false,
    attempt: { state: 'waiting', url: authorize, message: 'waiting…' } })
  const before = opened.length
  const { host, root } = await render({ t })
  assert.match(host.textContent, /t:fallback/)
  assert.match(host.textContent, /t:cancel/)
  assert.equal(opened.length, before + 1, 'the authorization page must be opened exactly once')
  assert.equal(opened.at(-1), authorize)
  assert.ok(host.querySelector(`a[href="${authorize}"]`) !== null,
    'a manual link must be offered when the popup is blocked')
  root.unmount()
})

await check('a failed attempt surfaces its coded error', async () => {
  resetBody()
  answerWith({ signedIn: false, accounts: [], planEnabled: false, credentialsMissing: false,
    attempt: { state: 'failed', error: 'ID_TOKEN_INVALID: the ID token nonce did not match this sign-in attempt' } })
  const { host, root } = await render({ t })
  assert.match(host.textContent, /ID_TOKEN_INVALID/)
  root.unmount()
})

await check('the Test action posts to the probe endpoint and shows the answer', async () => {
  resetBody()
  const calls = []
  answerWith(path => path.endsWith('/selftest')
    ? { ok: true, model: 'gpt-6.1-sol', text: 'ok', usage: { inputTokens: 9, outputTokens: 1 } }
    : { signedIn: true, accounts: [ACCOUNT], activeAccountId: 'acct-1', planEnabled: true, credentialsMissing: false },
  { record: calls })
  const { host, root } = await render({ t })
  const button = [...host.querySelectorAll('button')].find(node => node.textContent === 't:test')
  assert.ok(button !== undefined, 'the Test button must be rendered')
  await act(async () => { button.click() })
  await settle()
  assert.ok(calls.some(call => call.path.endsWith('/selftest')), 'the click must call the probe endpoint')
  assert.match(host.textContent, /t:testOk/)
  assert.match(host.textContent, /gpt-6\.1-sol/)
  assert.match(host.textContent, /9 in \/ 1 out/)
  root.unmount()
})

await check('a probe failure is reported rather than swallowed', async () => {
  resetBody()
  answerWith(path => path.endsWith('/selftest')
    ? { ok: false, model: 'gpt-6.1-sol', error: 'subscription_sharing_usage_limit_exceeded: limit reached' }
    : { signedIn: true, accounts: [ACCOUNT], activeAccountId: 'acct-1', planEnabled: true, credentialsMissing: false })
  const { host, root } = await render({ t })
  const button = [...host.querySelectorAll('button')].find(node => node.textContent === 't:test')
  await act(async () => { button.click() })
  await settle()
  assert.match(host.textContent, /t:testFail/)
  assert.match(host.textContent, /subscription_sharing_usage_limit_exceeded/)
  root.unmount()
})

await check('signing out posts the account and reports an unconfirmed revocation', async () => {
  resetBody()
  const calls = []
  answerWith(path => path.endsWith('/signout')
    ? { signedIn: false, accounts: [], planEnabled: false, credentialsMissing: false,
        revoked: false, revokeError: 'revocation failed (HTTP 503)' }
    : { signedIn: true, accounts: [ACCOUNT], activeAccountId: 'acct-1', planEnabled: true, credentialsMissing: false },
  { record: calls })
  const { host, root } = await render({ t })
  const button = [...host.querySelectorAll('button')].find(node => node.textContent === 't:signOut')
  assert.ok(button !== undefined)
  await act(async () => { button.click() })
  await settle()
  const signOut = calls.find(call => call.path.endsWith('/signout'))
  assert.ok(signOut !== undefined, 'the sign-out endpoint must be called')
  assert.deepEqual(JSON.parse(signOut.init.body), { accountId: 'acct-1' })
  // A revocation that could not be confirmed must be stated: the remote session
  // may still be live, and the docs say a network failure is not proof.
  assert.match(host.textContent, /t:revokeWarning/)
  assert.match(host.textContent, /HTTP 503/)
  root.unmount()
})

await check('the plugin page renders its own heading above the same controls', async () => {
  resetBody()
  answerWith({ signedIn: false, accounts: [], planEnabled: false, credentialsMissing: false })
  const { host, root } = await render({ t }, 'settings.section')
  assert.match(host.textContent, /t:nav/, 'the page must carry its own heading')
  assert.match(host.textContent, /t:pageLede/)
  // The page is a wrapper, not a copy: the same sign-in controls appear on it.
  assert.match(host.textContent, /t:continue/)
  assert.ok(host.querySelector('a[href="https://chatgpt.com/settings/usage"]') !== null)
  root.unmount()
})

await check('a composition without a credential service says so instead of offering a dead button', async () => {
  resetBody()
  answerWith({ signedIn: false, accounts: [], planEnabled: false, credentialsMissing: true })
  const { host, root } = await render({ t })
  assert.match(host.textContent, /t:noCredentials/)
  assert.doesNotMatch(host.textContent, /t:continue/, 'no sign-in action may be offered')
  root.unmount()
})

await check('an unreachable API surfaces an error instead of an eternal spinner', async () => {
  resetBody()
  globalThis.fetch = async () => { throw new Error('network down') }
  const { host, root } = await render({ t })
  assert.match(host.textContent, /network down/)
  root.unmount()
})

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`)
if (failures.length > 0) process.exit(1)
