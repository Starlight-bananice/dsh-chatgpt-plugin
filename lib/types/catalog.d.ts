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
    slug: string;
    /** Human-readable name for the picker. */
    displayName: string;
    /** Context capacity, when the listing discloses one. */
    contextWindow?: number;
}
/**
 * Public API base for this flow. The docs are explicit that ChatGPT plan usage
 * goes to the public Responses endpoint and **not** to ChatGPT's `backend-api`.
 */
export declare const OFFICIAL_API_BASE = "https://api.openai.com/v1";
/**
 * One entry exactly as the listing reported it, before any filtering.
 *
 * Kept separate from {@link CatalogModel} so a surface can show what the account
 * actually offers next to what this adapter chose to display: a model missing
 * from the picker is then explainable (its `visibility` is not `list`) rather
 * than mysterious.
 */
export interface RawCatalogEntry {
    id: string;
    displayName: string;
    visibility?: string;
}
/**
 * Fetch the account's raw model listing, unfiltered.
 * @param accessToken - the OAuth access token for the account.
 * @param options - the API base (defaults to the official one) and cancellation.
 * @returns every entry the endpoint reported, in its order.
 */
export declare function fetchRawCatalog(accessToken: string, options?: {
    base?: string;
    signal?: AbortSignal;
}): Promise<RawCatalogEntry[]>;
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
export declare function fetchCatalog(accessToken: string, options?: {
    base?: string;
    signal?: AbortSignal;
}): Promise<CatalogModel[]>;
