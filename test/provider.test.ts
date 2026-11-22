// The provider through the real OpenClaw SDK (cache, guarded fetch, content wrapping) with fetch mocked.
// Nothing here reaches the network: every request must hit the fetch mock.
import { readFileSync } from "node:fs";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createClawifiWebSearchProvider } from "../web-search-contract-api.js";
import { PLUGIN_VERSION } from "../src/version.js";

const keylessFixture = readFileSync(new URL("./fixtures/keyless-search.json", import.meta.url), "utf8");
const KEY = "clawifi_live_fixture_key";
let fetchMock: MockInstance<typeof fetch>;
let unique = 0;
// each test searches for something new, so the host's search cache never answers for another test
const freshQuery = (label: string) => `${label} ${Date.now()} ${unique++}`;

type Json = Record<string, unknown>;

function tool(options: { apiKey?: unknown; searchConfig?: Json; config?: Json } = {}) {
  const config =
    options.config ??
    (options.apiKey === undefined
      ? {}
      : { plugins: { entries: { clawifi: { config: { webSearch: { apiKey: options.apiKey } } } } } });
  const definition = createClawifiWebSearchProvider().createTool({
    config: config as never,
    searchConfig: options.searchConfig,
  });
  if (!definition) {
    throw new Error("Expected a Clawifi tool definition");
  }
  return definition;
}

function lastRequest() {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) {
    throw new Error("fetch was not called");
  }
  const [url, init] = call;
  return {
    url: String(url instanceof Request ? url.url : url),
    headers: new Headers(init?.headers),
    body: JSON.parse(String(init?.body)) as Json,
  };
}

const keyedBody = (results: Json[]) => ({ success: true, cache_hit: false, result_count: results.length, results });

beforeEach(() => {
  vi.stubEnv("CLAWIFI_API_KEY", "");
  fetchMock = vi.spyOn(globalThis, "fetch");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("searches without a key through the MCP endpoint and wraps the results as untrusted", async () => {
  fetchMock.mockImplementation(async () => new Response(keylessFixture));
  const query = freshQuery("keyless");
  const payload = await tool().execute({ query, count: 2 });

  expect(fetchMock).toHaveBeenCalledOnce();
  const request = lastRequest();
  expect(request.url).toBe("https://api.clawifi.dev/mcp");
  expect(request.headers.get("authorization")).toBeNull();
  expect(request.headers.get("x-clawifi-client")).toBe(`clawifi-openclaw/${PLUGIN_VERSION}`);
  expect(request.headers.get("user-agent")).toBe(`clawifi-openclaw/${PLUGIN_VERSION}`);
  expect(request.body).toMatchObject({ method: "tools/call", params: { name: "search_free", arguments: { query } } });

  expect(payload).toMatchObject({
    query,
    provider: "clawifi",
    mode: "keyless",
    count: 2,
    externalContent: { untrusted: true, source: "web_search", provider: "clawifi", wrapped: true },
  });
  const results = payload.results as Json[];
  expect(results).toHaveLength(2);
  expect(results[0]?.url).toBe("https://docs.openclaw.ai/plugins/sdk-provider-plugins/media-and-search");
  expect(results[0]?.siteName).toBe("docs.openclaw.ai");
  expect(String(results[0]?.title)).toContain("Provider media and search - OpenClaw");
  expect(String(results[0]?.title)).toMatch(/EXTERNAL_UNTRUSTED_CONTENT/);
  expect(String(results[0]?.description)).toMatch(/EXTERNAL_UNTRUSTED_CONTENT/);
  expect(payload.notice).toBeUndefined();
});

it("says so when a keyless search could not apply filters or the asked count", async () => {
  fetchMock.mockImplementation(async () => new Response(keylessFixture));
  const payload = await tool().execute({
    query: freshQuery("keyless filters"),
    count: 8,
    freshness: "week",
    include_domains: ["docs.openclaw.ai"],
  });
  expect(payload.count).toBe(3);
  expect(payload.ignoredFilters).toEqual(["freshness", "include_domains"]);
  expect(String(payload.notice)).toMatch(/at most 3 results/);
  expect(String(payload.notice)).toMatch(/freshness, include_domains/);
  expect(String(payload.notice)).toContain("utm_source=openclaw&utm_medium=integration&utm_campaign=clawhub-plugin");
});

it("searches with a configured key over REST, sending filters and the default count", async () => {
  fetchMock.mockImplementation(async () =>
    Response.json(keyedBody([{ url: "https://one.test/a", title: "One", snippet: "first", published_at: "2026-11-20" }]), {
      headers: { "X-Clawifi-Credits-Charged": "1" },
    }),
  );
  const query = freshQuery("keyed");
  const payload = await tool({ apiKey: KEY }).execute({
    query,
    freshness: "Month",
    include_domains: ["One.test", "one.test", " "],
    exclude_domains: "spam.test, junk.test",
    country: "US",
    language: "en",
  });

  const request = lastRequest();
  expect(request.url).toBe("https://api.clawifi.dev/search/free");
  expect(request.headers.get("authorization")).toBe(`Bearer ${KEY}`);
  expect(request.body).toEqual({
    query,
    max_results: 5,
    time_range: "month",
    include_domains: ["one.test"],
    exclude_domains: ["spam.test", "junk.test"],
    country: "us",
    language: "en",
  });
  expect(payload).toMatchObject({ mode: "keyed", count: 1, creditsCharged: 1 });
  expect((payload.results as Json[])[0]).toMatchObject({ url: "https://one.test/a", published: "2026-11-20", siteName: "one.test" });
  expect(payload.notice).toBeUndefined();
  expect(payload.ignoredFilters).toBeUndefined();
  expect(JSON.stringify(payload)).not.toContain(KEY);
});

it("reads the key from CLAWIFI_API_KEY when none is configured", async () => {
  vi.stubEnv("CLAWIFI_API_KEY", "clawifi_live_from_env");
  fetchMock.mockImplementation(async () => Response.json(keyedBody([])));
  const payload = await tool().execute({ query: freshQuery("env key") });
  expect(lastRequest().headers.get("authorization")).toBe("Bearer clawifi_live_from_env");
  expect(payload).toMatchObject({ mode: "keyed", count: 0, results: [] });
});

it("never sends the shared tools.web.search.apiKey, which may be another provider's key", async () => {
  fetchMock.mockImplementation(async () => new Response(keylessFixture));
  const payload = await tool({ searchConfig: { apiKey: "brave-or-other-provider-key" } }).execute({
    query: freshQuery("foreign key"),
  });
  const request = lastRequest();
  expect(request.url).toBe("https://api.clawifi.dev/mcp");
  expect(request.headers.get("authorization")).toBeNull();
  expect(JSON.stringify(request.body)).not.toContain("brave-or-other-provider-key");
  expect(payload.mode).toBe("keyless");
});

it("uses tools.web.search.maxResults as the default count and caps count at 10", async () => {
  fetchMock.mockImplementation(async () => Response.json(keyedBody([])));
  await tool({ apiKey: KEY, searchConfig: { maxResults: 7 } }).execute({ query: freshQuery("default count") });
  expect(lastRequest().body.max_results).toBe(7);
  await tool({ apiKey: KEY }).execute({ query: freshQuery("big count"), count: 50 });
  expect(lastRequest().body.max_results).toBe(10);
});

it("answers a repeated search from the host cache, per credential", async () => {
  fetchMock.mockImplementation(async (_url, init) =>
    new Headers(init?.headers).has("authorization")
      ? Response.json(keyedBody([{ url: "https://keyed.test/", title: "Keyed" }]))
      : new Response(keylessFixture),
  );
  const args = { query: freshQuery("cache") };
  const first = await tool({ apiKey: KEY }).execute(args);
  const second = await tool({ apiKey: KEY }).execute(args);
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(second).toEqual({ ...first, cached: true });

  const otherKey = await tool({ apiKey: "clawifi_live_other" }).execute(args);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(otherKey.cached).toBeUndefined();

  const keyless = await tool().execute(args);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(keyless.mode).toBe("keyless");
});

it.each([
  [401, "clawifi_invalid_api_key", /refused the API key \(Invalid API key\)/],
  [402, "clawifi_out_of_credits", /no credits left/],
  [429, "clawifi_rate_limited", /Retry after 9 s/],
])("returns an actionable payload for a keyed %i and does not cache it", async (status, error, message) => {
  fetchMock.mockImplementation(async () =>
    Response.json(
      { detail: "Invalid API key", error: { code: "http_error", message: "Invalid API key", details: {} } },
      { status, headers: { "Retry-After": "9" } },
    ),
  );
  const args = { query: freshQuery(`keyed ${status}`) };
  const payload = await tool({ apiKey: KEY }).execute(args);
  expect(payload.error).toBe(error);
  expect(String(payload.message)).toMatch(message);
  expect(JSON.stringify(payload)).not.toContain(KEY);
  expect(payload.results).toBeUndefined();

  await tool({ apiKey: KEY }).execute(args);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("turns a keyless limit into a hint to get a free key", async () => {
  const text = "Keyless limit reached (Playground rate limit exceeded) retry_after=30";
  fetchMock.mockImplementation(async () =>
    Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }], isError: true } }),
  );
  const payload = await tool().execute({ query: freshQuery("keyless limit") });
  expect(payload).toMatchObject({ error: "clawifi_keyless_limit", retryAfterSeconds: 30 });
  expect(String(payload.message)).toMatch(/12 calls a minute and 50 a day/);
  expect(String(payload.message)).toContain("https://clawifi.dev/?utm_source=openclaw&utm_medium=integration&utm_campaign=clawhub-plugin");
  expect(String(payload.message)).toContain("CLAWIFI_API_KEY");
});

it("throws on a server error so the host reports a tool failure", async () => {
  fetchMock.mockImplementation(async () => Response.json({ error: { message: "Search is unavailable" } }, { status: 503 }));
  const failure = tool({ apiKey: KEY }).execute({ query: freshQuery("server error") });
  await expect(failure).rejects.toThrow("Clawifi API error (503): Search is unavailable");
  await expect(failure).rejects.not.toThrow(KEY);
});

it.each([
  [{ freshness: "decade" }, "invalid_freshness"],
  [{ country: "usa" }, "invalid_country"],
  [{ language: "english" }, "invalid_language"],
])("refuses %o before any request", async (extra, error) => {
  const payload = await tool().execute({ query: freshQuery("invalid"), ...extra });
  expect(payload.error).toBe(error);
  expect(fetchMock).not.toHaveBeenCalled();
});

it("refuses a missing or too long query before any request", async () => {
  await expect(tool().execute({})).rejects.toThrow(/query/);
  const payload = await tool().execute({ query: "x".repeat(501) });
  expect(payload.error).toBe("query_too_long");
  expect(fetchMock).not.toHaveBeenCalled();
});

it("stops before the request when the call is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(tool().execute({ query: freshQuery("aborted") }, { signal: controller.signal })).rejects.toThrow();
  expect(fetchMock).not.toHaveBeenCalled();
});
