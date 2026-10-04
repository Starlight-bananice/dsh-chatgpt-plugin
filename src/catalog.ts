/**
 * The signed-in account's model catalog.
 *
 * The docs are specific about how a model picker is populated in this flow:
 * ask `GET https://api.openai.com/v1/models` with the same access token used
 * for inference, keep the entries whose `visibility` is `"list"`, show
 * `display_name`, and pass `slug` as the request's `model`. The reply is
 * advisory — the adapter accepts a model id it never listed — so a listing
 * failure degrades the picker rather than the request path.
 *
 * @module dsh-chatgpt-provider/catalog
 */

/** One model the account can use. */
export interface CatalogModel {
  /** Value passed as `model` on a Responses request. */
  slug: string
  /** Human-readable name for the picker. */
  displayName: string
  /** Context capacity, when the listing discloses one. */
  contextWindow?: number
}

/**
 * Public API base for this flow. The docs are explicit that ChatGPT plan usage
 * goes to the public Responses endpoint and **not** to ChatGPT's `backend-api`.
 */
export const OFFICIAL_API_BASE = 'https://api.openai.com/v1'

/** Bound on a catalog listing, which is a configuration-time call. */
const CATALOG_TIMEOUT_MS = 20_000

/** Read a positive integer from an unknown field, or `undefined`. */
function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/**
 * One entry exactly as the listing reported it, before any filtering.
 *
 * Kept separate from {@link CatalogModel} so a surface can show what the account
 * actually offers next to what this adapter chose to display: a model missing
 * from the picker is then explainable (its `visibility` is not `list`) rather
 * than mysterious.
 */
export interface RawCatalogEntry {
  id: string
  displayName: string
  visibility?: string
}

/**
 * Fetch the account's raw model listing, unfiltered.
 * @param accessToken - the OAuth access token for the account.
 * @param options - the API base (defaults to the official one) and cancellation.
 * @returns every entry the endpoint reported, in its order.
 */
export async function fetchRawCatalog(
  accessToken: string,
  options: { base?: string; signal?: AbortSignal } = {},
): Promise<RawCatalogEntry[]> {
  const timeout = AbortSignal.timeout(CATALOG_TIMEOUT_MS)
  const response = await fetch(`${options.base ?? OFFICIAL_API_BASE}/models`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    signal: options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]),
  })
  if (!response.ok) return []
  const body: unknown = await response.json()
  const entries = typeof body === 'object' && body !== null
    ? (body as Record<string, unknown>)['models']
    : undefined
  if (!Array.isArray(entries)) return []
  const raw: RawCatalogEntry[] = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const id = record['slug'] ?? record['id']
    if (typeof id !== 'string' || id === '') continue
    const displayName = record['display_name']
    const visibility = record['visibility']
    raw.push({
      id,
      displayName: typeof displayName === 'string' && displayName !== '' ? displayName : id,
      ...typeof visibility === 'string' ? { visibility } : {},
    })
  }
  return raw
}

/**
 * Fetch the account's model list.
 *
 * Fields beyond the documented `slug`/`display_name`/`visibility` triple are
 * read defensively: a listing that grows a context field is used when it
 * appears and ignored when it does not, and a malformed entry is dropped
 * rather than failing the whole picker.
 * @param accessToken - the OAuth access token for the account.
 * @param options - the API base (defaults to the official one) and cancellation.
 * @returns the displayable models, in the server's order.
 */
export async function fetchCatalog(
  accessToken: string,
  options: { base?: string; signal?: AbortSignal } = {},
): Promise<CatalogModel[]> {
  const timeout = AbortSignal.timeout(CATALOG_TIMEOUT_MS)
  const signal = options.signal
  const response = await fetch(`${options.base ?? OFFICIAL_API_BASE}/models`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`model listing failed (HTTP ${String(response.status)}): ${detail.slice(0, 300)}`)
  }
  const body: unknown = await response.json()
  const entries = typeof body === 'object' && body !== null
    ? (body as Record<string, unknown>)['models']
    : undefined
  if (!Array.isArray(entries)) return []
  const models: CatalogModel[] = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    // `visibility` is the documented filter; an entry that omits it is kept,
    // because dropping everything on an absent optional field would empty the
    // picker for a listing that simply stopped sending it.
    const visibility = record['visibility']
    if (typeof visibility === 'string' && visibility !== 'list') continue
    const slug = record['slug']
    if (typeof slug !== 'string' || slug === '') continue
    const displayName = record['display_name']
    const contextWindow = positiveInt(record['context_window'])
      ?? positiveInt(record['contextWindow'])
      ?? positiveInt(record['max_context_tokens'])
    models.push({
      slug,
      displayName: typeof displayName === 'string' && displayName !== '' ? displayName : slug,
      ...contextWindow === undefined ? {} : { contextWindow },
    })
  }
  return models
}
