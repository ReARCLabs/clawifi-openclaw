import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildClawifiSearchRequest,
  ClawifiApiError,
  ignoredKeylessFilters,
  parseClawifiSearchResponse,
  parseRetryAfter,
} from "../src/clawifi-client.js";
import { PLUGIN_VERSION } from "../src/version.js";

// A real keyless answer from POST https://api.clawifi.dev/mcp (tools/call search_free), recorded 2026-11-22.
const keylessFixture = readFileSync(new URL("./fixtures/keyless-search.json", import.meta.url), "utf8");

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("buildClawifiSearchRequest", () => {
  it("without a key calls the hosted MCP endpoint and sends no credential", () => {
    const request = buildClawifiSearchRequest({ query: "llm evals", count: 5, timeRange: "week" });
    expect(request.mode).toBe("keyless");
    expect(request.url).toBe("https://api.clawifi.dev/mcp");
    expect(request.init.headers.Authorization).toBeUndefined();
    expect(request.init.headers.Accept).toBe("application/json, text/event-stream");
    expect(JSON.parse(request.init.body)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "search_free", arguments: { query: "llm evals" } },
    });
  });

  it("with a key calls REST /search/free with the key and the filters", () => {
    const request = buildClawifiSearchRequest({
      query: "llm evals",
      count: 7,
      apiKey: "clawifi_live_fixture",
      timeRange: "month",
      includeDomains: ["arxiv.org"],
      excludeDomains: ["pinterest.com"],
      country: "us",
      language: "en",
    });
    expect(request.mode).toBe("keyed");
    expect(request.url).toBe("https://api.clawifi.dev/search/free");
    expect(request.init.headers.Authorization).toBe("Bearer clawifi_live_fixture");
    expect(JSON.parse(request.init.body)).toEqual({
      query: "llm evals",
      max_results: 7,
      time_range: "month",
      include_domains: ["arxiv.org"],
      exclude_domains: ["pinterest.com"],
      country: "us",
      language: "en",
    });
  });

  it("names the client and nothing personal in the request headers", () => {
    for (const apiKey of [undefined, "clawifi_live_fixture"]) {
      const { headers } = buildClawifiSearchRequest({ query: "q", count: 1, apiKey }).init;
      expect(headers["User-Agent"]).toBe(`clawifi-openclaw/${PLUGIN_VERSION}`);
      expect(headers["X-Clawifi-Client"]).toBe(`clawifi-openclaw/${PLUGIN_VERSION}`);
      expect(headers["User-Agent"]).not.toMatch(/@/);
    }
  });

  it("omits empty filters from the keyed body", () => {
    const request = buildClawifiSearchRequest({
      query: "q",
      count: 3,
      apiKey: "k",
      includeDomains: [],
      excludeDomains: [],
    });
    expect(JSON.parse(request.init.body)).toEqual({ query: "q", max_results: 3 });
  });
});

describe("ignoredKeylessFilters", () => {
  it("lists the filters a keyless search cannot apply, and none with a key", () => {
    const input = { query: "q", count: 3, timeRange: "day" as const, includeDomains: ["a.com"], country: "us" };
    expect(ignoredKeylessFilters(input)).toEqual(["freshness", "include_domains", "country"]);
    expect(ignoredKeylessFilters({ ...input, apiKey: "k" })).toEqual([]);
  });
});

describe("parseClawifiSearchResponse, keyless", () => {
  it("reads a recorded live answer", async () => {
    const outcome = await parseClawifiSearchResponse("keyless", new Response(keylessFixture), 10);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.mode).toBe("keyless");
    expect(outcome.results).toHaveLength(3);
    for (const result of outcome.results) {
      expect(result.url).toMatch(/^https?:\/\//);
      expect(result.title.length).toBeGreaterThan(0);
      expect(Object.keys(result).sort()).toEqual(
        expect.arrayContaining(["snippet", "title", "url"]),
      );
    }
  });

  it("honours a count below the keyless maximum", async () => {
    const outcome = await parseClawifiSearchResponse("keyless", new Response(keylessFixture), 1);
    expect(outcome.ok && outcome.results).toHaveLength(1);
  });

  it("falls back to the text content when structuredContent is missing", async () => {
    const inner = { results: [{ url: "https://a.test/", title: "A", snippet: "s", published_at: "2026-11-01" }] };
    const outcome = await parseClawifiSearchResponse(
      "keyless",
      json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(inner) }], isError: false } }),
      5,
    );
    expect(outcome).toEqual({
      ok: true,
      mode: "keyless",
      cacheHit: false,
      results: [{ url: "https://a.test/", title: "A", snippet: "s", publishedAt: "2026-11-01" }],
    });
  });

  it("maps the per-minute limit (an isError result) to keyless_limit with its wait", async () => {
    const text =
      "Keyless limit reached (Playground rate limit exceeded) Sign in to Clawifi when your client offers it. retry_after=42";
    const outcome = await parseClawifiSearchResponse(
      "keyless",
      json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }], isError: true } }),
      5,
    );
    expect(outcome).toMatchObject({ ok: false, code: "keyless_limit", retryAfterSeconds: 42 });
  });

  it("maps the used-up day (401 with a JSON-RPC error) to keyless_limit", async () => {
    const outcome = await parseClawifiSearchResponse(
      "keyless",
      json(
        { jsonrpc: "2.0", id: 1, error: { code: -32001, message: "Keyless daily limit reached: 50 calls a day per address." } },
        { status: 401, headers: { "WWW-Authenticate": "Bearer resource_metadata=x" } },
      ),
      5,
    );
    expect(outcome).toMatchObject({ ok: false, code: "keyless_limit" });
  });

  it("maps an edge 429 to keyless_limit with Retry-After", async () => {
    const outcome = await parseClawifiSearchResponse(
      "keyless",
      new Response("slow down", { status: 429, headers: { "Retry-After": "7" } }),
      5,
    );
    expect(outcome).toMatchObject({ ok: false, code: "keyless_limit", retryAfterSeconds: 7 });
  });

  it("throws on any other tool error, a JSON-RPC error or a server error", async () => {
    const toolError = json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Every search engine failed." }], isError: true } });
    await expect(parseClawifiSearchResponse("keyless", toolError, 5)).rejects.toThrow(/Every search engine failed/);
    const rpcError = json({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid params" } });
    await expect(parseClawifiSearchResponse("keyless", rpcError, 5)).rejects.toThrow(/Invalid params/);
    const failure = parseClawifiSearchResponse("keyless", new Response("bad gateway", { status: 502 }), 5);
    await expect(failure).rejects.toBeInstanceOf(ClawifiApiError);
    await expect(failure).rejects.toMatchObject({ status: 502 });
  });

  it("throws on a 200 that is not JSON", async () => {
    await expect(parseClawifiSearchResponse("keyless", new Response("<html>"), 5)).rejects.toThrow(/malformed JSON/);
  });
});

describe("parseClawifiSearchResponse, keyed", () => {
  const body = {
    success: true,
    query: "q",
    result_count: 3,
    cache_hit: false,
    results: [
      { provider: "ddg_html", title: "One", url: "https://one.test/", snippet: "first", rank: 1, published_at: "2026-11-20", modified_at: null },
      { provider: "ddg_html", title: null, url: "https://two.test/", snippet: null, rank: 2, published_at: null, modified_at: "2026-10-01T00:00:00Z" },
      { provider: "ddg_html", title: "No link", url: "javascript:alert(1)", snippet: "x", rank: 3 },
      { provider: "ddg_html", title: "Three", url: "https://three.test/", snippet: "third", rank: 4 },
    ],
  };

  it("reads results, dates, the charge header and drops non-http URLs", async () => {
    const outcome = await parseClawifiSearchResponse(
      "keyed",
      json(body, { headers: { "X-Clawifi-Credits-Charged": "1" } }),
      10,
    );
    expect(outcome).toEqual({
      ok: true,
      mode: "keyed",
      cacheHit: false,
      creditsCharged: 1,
      results: [
        { title: "One", url: "https://one.test/", snippet: "first", publishedAt: "2026-11-20" },
        { title: "", url: "https://two.test/", snippet: "", publishedAt: "2026-10-01T00:00:00Z" },
        { title: "Three", url: "https://three.test/", snippet: "third" },
      ],
    });
  });

  it("caps the results at count and reports a cache hit", async () => {
    const outcome = await parseClawifiSearchResponse("keyed", json({ ...body, cache_hit: true }), 1);
    expect(outcome).toMatchObject({ ok: true, cacheHit: true });
    expect(outcome.ok && outcome.results).toHaveLength(1);
    expect(outcome.ok && outcome.creditsCharged).toBeUndefined();
  });

  it("treats a missing results list as no results", async () => {
    const outcome = await parseClawifiSearchResponse("keyed", json({ success: true }), 5);
    expect(outcome).toMatchObject({ ok: true, results: [] });
  });

  const refusal = (status: number, message: string, headers?: Record<string, string>, details: Record<string, unknown> = {}) =>
    json({ detail: message, error: { code: "http_error", message, details, retryable: false } }, { status, headers });

  it.each([
    [401, "invalid_api_key"],
    [403, "invalid_api_key"],
    [402, "out_of_credits"],
    [429, "rate_limited"],
  ])("maps %i to %s", async (status, code) => {
    const outcome = await parseClawifiSearchResponse("keyed", refusal(status, "Refused"), 5);
    expect(outcome).toMatchObject({ ok: false, mode: "keyed", code, detail: "Refused" });
  });

  it("reads the wait of a 429 from Retry-After, else from the error details", async () => {
    const header = await parseClawifiSearchResponse("keyed", refusal(429, "Slow down", { "Retry-After": "12" }), 5);
    expect(header).toMatchObject({ code: "rate_limited", retryAfterSeconds: 12 });
    const details = await parseClawifiSearchResponse("keyed", refusal(429, "Slow down", undefined, { retry_after: 3.2 }), 5);
    expect(details).toMatchObject({ code: "rate_limited", retryAfterSeconds: 4 });
  });

  it("throws a status-carrying error on a server error", async () => {
    const failure = parseClawifiSearchResponse("keyed", refusal(503, "Search is unavailable"), 5);
    await expect(failure).rejects.toThrow("Clawifi API error (503): Search is unavailable");
    await expect(failure).rejects.toMatchObject({ status: 503, statusCode: 503 });
  });

  it("clips a long error message", async () => {
    const outcome = await parseClawifiSearchResponse("keyed", refusal(401, "x".repeat(5000)), 5);
    expect(!outcome.ok && outcome.detail?.length).toBeLessThanOrEqual(301);
  });

  it("refuses an oversized body", async () => {
    const huge = new Response("a".repeat(4 * 1024 * 1024 + 1));
    await expect(parseClawifiSearchResponse("keyed", huge, 5)).rejects.toThrow(/exceeds/);
  });
});

describe("parseRetryAfter", () => {
  it("reads seconds and HTTP dates", () => {
    expect(parseRetryAfter("30")).toBe(30);
    expect(parseRetryAfter("1.2")).toBe(2);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
    const now = Date.parse("2026-11-22T00:00:00Z");
    expect(parseRetryAfter("Sun, 22 Nov 2026 00:00:10 GMT", now)).toBe(10);
    expect(parseRetryAfter("Sat, 21 Nov 2026 00:00:00 GMT", now)).toBe(0);
  });
});
