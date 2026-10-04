#!/usr/bin/env node
/**
 * Live model probe: which model ids will this ChatGPT account actually serve?
 *
 * The documented model listing is authoritative about what an account *offers*,
 * but it is not a routing whitelist — the adapter accepts an unlisted id, and a
 * companion client's bundled catalog names ids this endpoint never returns. The
 * only honest way to answer "can I use this model?" is to ask the provider.
 *
 * This reads the harness credential document **read-only** and sends one minimal
 * real request per candidate. It never prints or copies a token, and it refuses
 * to run rather than refresh one: a refresh rotates the single-use refresh token,
 * and doing that outside the credential store's lock could invalidate the value
 * the running application holds.
 *
 * Usage: node tests/live-models.mjs [model ...]
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

/** Candidate ids: what the CLI asked for, else the ones in question plus a control. */
const CANDIDATES = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : ['gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-5.6-luna']

const { accessTokenFor, listAccounts } = await import('../lib/accounts.js')
const { fetchRawCatalog } = await import('../lib/catalog.js')

const credentialsPath = join(process.env['DSH_HOME'] ?? join(homedir(), '.dsh'), '.credentials.yaml')

/** The stored document, parsed. */
function readDocument() {
  const text = readFileSync(credentialsPath, 'utf8')
  const document = parse(text)
  assert.ok(document !== null && typeof document === 'object', 'credential document is not a mapping')
  const records = new Map()
  for (const [key, value] of Object.entries(document.records ?? {})) records.set(key, value)
  return records
}

const records = readDocument()

/**
 * A read-only credential store.
 *
 * `modifyRecord` refuses on purpose: the only mutation this flow could trigger
 * is a refresh, and a refresh performed here would rotate a single-use token
 * without the store's cross-process lock — invalidating the value the running
 * application is holding.
 */
const store = {
  readRecord: async key => records.get(key),
  listRecords: async () => [...records.entries()].map(([key, value]) => ({ key, kind: value.kind })),
  modifyRecord: async () => {
    throw new Error('this probe is read-only; refresh the token from the Models page and re-run')
  },
  deleteRecord: async () => {
    throw new Error('this probe is read-only')
  },
}

const accounts = await listAccounts(store)
if (accounts.length === 0) {
  process.stdout.write('no ChatGPT account is stored; sign in first\n')
  process.exit(1)
}
const account = accounts[0]
process.stdout.write(`account: ${account.email ?? account.subject}\n`)

const { accessToken, grant } = await accessTokenFor(store, account.id)
const minutes = Math.round((grant.expiresAt - Date.now()) / 60_000)
process.stdout.write(`access token valid for ${String(minutes)} more minutes\n\n`)

// ── What the account reports ─────────────────────────────────────────────────
const reported = await fetchRawCatalog(accessToken)
process.stdout.write(`GET /v1/models reported ${String(reported.length)} entries:\n`)
for (const entry of reported) {
  const shown = entry.visibility === undefined || entry.visibility === 'list' ? 'displayed' : `hidden (${entry.visibility})`
  process.stdout.write(`  ${entry.id.padEnd(24)} ${shown}\n`)
}
const listed = new Set(reported.map(entry => entry.id))
process.stdout.write('\n')

/** Send one minimal real request and report how the provider answered. */
async function probe(model) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'user-agent': 'dsh-chatgpt-provider/live-model-probe',
    },
    body: JSON.stringify({
      model,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'Reply with exactly: ok' }] }],
      store: false,
      stream: true,
    }),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    let detail = body.slice(0, 300)
    try {
      const parsed = JSON.parse(body)
      detail = `${parsed?.error?.code ?? ''} ${parsed?.error?.message ?? ''}`.trim() || detail
    } catch {
      // A non-JSON body is reported verbatim.
    }
    return { ok: false, status: response.status, detail }
  }
  // Read the stream to a terminal event: a 200 with a failed response in it is
  // still a failure, and this route reports usage limits that way.
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  let failure
  let sawTerminal = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) {
      const line = frame.split('\n').find(part => part.startsWith('data:'))
      if (line === undefined) continue
      let event
      try {
        event = JSON.parse(line.slice(5).trim())
      } catch {
        continue
      }
      if (event.type === 'response.output_text.delta') text += event.delta ?? ''
      if (event.type === 'response.completed') sawTerminal = true
      if (event.type === 'response.failed' || event.type === 'error') {
        sawTerminal = true
        const error = event.response?.error ?? event
        failure = `${error.code ?? 'error'} ${error.message ?? ''}`.trim()
      }
    }
  }
  if (failure !== undefined) return { ok: false, status: 200, detail: failure }
  if (!sawTerminal) return { ok: false, status: 200, detail: 'stream ended without response.completed' }
  return { ok: true, text: text.trim().slice(0, 40) }
}

process.stdout.write(`probing ${String(CANDIDATES.length)} model ids with one real request each:\n`)
for (const model of CANDIDATES) {
  const inListing = listed.has(model)
  const result = await probe(model)
  const verdict = result.ok === true ? `OK  reply=${JSON.stringify(result.text ?? '')}` : `FAILED  ${result.detail}`
  process.stdout.write(`  ${model.padEnd(24)} ${inListing ? 'listed  ' : 'unlisted'}  ${verdict}\n`)
}
