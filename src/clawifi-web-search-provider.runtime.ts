import { createHash } from "node:crypto";
import {
  buildSearchCacheKey,
  DEFAULT_SEARCH_COUNT,
  readCachedSearchPayload,
  readConfiguredSecretString,
  readProviderEnvValue,
  readStringParam,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  resolveSiteName,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";
import {
  buildClawifiSearchRequest,
  CLAWIFI_KEYLESS_MAX_RESULTS,
  CLAWIFI_QUERY_MAX_CHARS,
  CLAWIFI_SIGNUP_URL,
  CLAWIFI_TIME_RANGES,
  ignoredKeylessFilters,
  parseClawifiSearchResponse,
  type ClawifiSearchInput,
  type ClawifiSearchOutcome,
  type ClawifiTimeRange,
} from "./clawifi-client.js";

const CREDENTIAL_PATH = "plugins.entries.clawifi.config.webSearch.apiKey";
const DOCS_URL = "https://clawifi.dev/docs/search";
const MAX_INCLUDE_DOMAINS = 20;
const MAX_EXCLUDE_DOMAINS = 50;
const GET_A_KEY = `A free Clawifi account has 1,000 credits a month: ${CLAWIFI_SIGNUP_URL} . Then set CLAWIFI_API_KEY in the Gateway environment or ${CREDENTIAL_PATH}.`;

type ErrorPayload = { error: string; message: string; docs: string; retryAfterSeconds?: number };

function errorPayload(error: string, message: string, retryAfterSeconds?: number): ErrorPayload {
  return {
    error,
    message,
    docs: DOCS_URL,
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  };
}

function resolveApiKey(searchConfig: Record<string, unknown> | undefined): string | undefined {
  const scoped = searchConfig?.clawifi;
  const configured =
    typeof scoped === "object" && scoped !== null && !Array.isArray(scoped)
      ? (scoped as Record<string, unknown>).apiKey
      : undefined;
  return (
    readConfiguredSecretString(configured, CREDENTIAL_PATH) ?? readProviderEnvValue(["CLAWIFI_API_KEY"])
  );
}

function readDomains(value: unknown, limit: number): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const domains: string[] = [];
  for (const entry of raw) {
    const domain = typeof entry === "string" ? entry.trim().toLowerCase() : "";
    if (domain && !domains.includes(domain)) {
      domains.push(domain);
    }
  }
  return domains.slice(0, limit);
}

function readCode(
  args: Record<string, unknown>,
  name: "country" | "language",
): { value?: string; error?: ErrorPayload } {
  const raw = readStringParam(args, name)?.trim().toLowerCase();
  if (!raw) {
    return {};
  }
  if (!/^[a-z]{2}$/.test(raw)) {
    return { error: errorPayload(`invalid_${name}`, `${name} must be a two-letter code, e.g. "${name === "country" ? "us" : "en"}".`) };
  }
  return { value: raw };
}

function failurePayload(outcome: Extract<ClawifiSearchOutcome, { ok: false }>): ErrorPayload {
  const wait =
    outcome.retryAfterSeconds !== undefined ? ` Retry after ${outcome.retryAfterSeconds} s.` : "";
  switch (outcome.code) {
    case "invalid_api_key":
      return errorPayload(
        "clawifi_invalid_api_key",
        `Clawifi refused the API key${outcome.detail ? ` (${outcome.detail})` : ""}. Check CLAWIFI_API_KEY or ${CREDENTIAL_PATH}; remove the key to search without one. Keys: ${CLAWIFI_SIGNUP_URL}`,
      );
    case "out_of_credits":
      return errorPayload(
        "clawifi_out_of_credits",
        `The Clawifi account has no credits left${outcome.detail ? ` (${outcome.detail})` : ""}. Add credits or change plan: ${CLAWIFI_SIGNUP_URL}`,
      );
    case "rate_limited":
      return errorPayload(
        "clawifi_rate_limited",
        `Clawifi search is rate limited${outcome.detail ? ` (${outcome.detail})` : ""}.${wait}`,
        outcome.retryAfterSeconds,
      );
    case "keyless_limit":
      return errorPayload(
        "clawifi_keyless_limit",
        `Clawifi search without an API key is limited to 12 calls a minute and 50 a day per address, and that limit is reached.${wait} ${GET_A_KEY}`,
        outcome.retryAfterSeconds,
      );
  }
}

export async function executeClawifiSearch(
  args: Record<string, unknown>,
  searchConfig: Record<string, unknown> | undefined,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const query = readStringParam(args, "query", { required: true }).trim();
  if (query.length > CLAWIFI_QUERY_MAX_CHARS) {
    return errorPayload(
      "query_too_long",
      `query must be ${CLAWIFI_QUERY_MAX_CHARS} characters or fewer (got ${query.length}).`,
    );
  }
  const rawFreshness = readStringParam(args, "freshness")?.trim().toLowerCase();
  const timeRange = CLAWIFI_TIME_RANGES.find((value) => value === rawFreshness) as
    | ClawifiTimeRange
    | undefined;
  if (rawFreshness && !timeRange) {
    return errorPayload("invalid_freshness", 'freshness must be one of "day", "week", "month" or "year".');
  }
  const country = readCode(args, "country");
  if (country.error) {
    return country.error;
  }
  const language = readCode(args, "language");
  if (language.error) {
    return language.error;
  }

  const apiKey = resolveApiKey(searchConfig);
  const count = resolveSearchCount(args.count ?? searchConfig?.maxResults, DEFAULT_SEARCH_COUNT);
  const input: ClawifiSearchInput = {
    query,
    count,
    apiKey,
    timeRange,
    includeDomains: readDomains(args.include_domains, MAX_INCLUDE_DOMAINS),
    excludeDomains: readDomains(args.exclude_domains, MAX_EXCLUDE_DOMAINS),
    country: country.value,
    language: language.value,
  };
  const ignoredFilters = ignoredKeylessFilters(input);

  // Keyless answers never depend on count above 3 or on filters, so they share one cache entry per query.
  const cacheKey = buildSearchCacheKey([
    "clawifi",
    apiKey ? `keyed-${createHash("sha256").update(apiKey).digest("hex").slice(0, 16)}` : "keyless",
    apiKey ? count : Math.min(count, CLAWIFI_KEYLESS_MAX_RESULTS),
    JSON.stringify(
      apiKey
        ? [timeRange, input.includeDomains, input.excludeDomains, input.country, input.language]
        : ignoredFilters,
    ),
    query,
  ]);
  const cacheTtlMs = resolveSearchCacheTtlMs(searchConfig);
  const cached = readCachedSearchPayload(cacheKey, cacheTtlMs);
  if (cached) {
    return cached;
  }

  const request = buildClawifiSearchRequest(input);
  const start = Date.now();
  const outcome = await withTrustedWebSearchEndpoint(
    {
      url: request.url,
      timeoutSeconds: resolveSearchTimeoutSeconds(searchConfig),
      init: request.init,
      ...(signal ? { signal } : {}),
    },
    (response) => parseClawifiSearchResponse(request.mode, response, count),
  );
  signal?.throwIfAborted();
  if (!outcome.ok) {
    return failurePayload(outcome); // never cached
  }

  const notices: string[] = [];
  if (outcome.mode === "keyless") {
    // Only when the caller asked for more: a default-count search carries no notice.
    if (resolveSearchCount(args.count, 1) > CLAWIFI_KEYLESS_MAX_RESULTS) {
      notices.push(`Without an API key Clawifi returns at most ${CLAWIFI_KEYLESS_MAX_RESULTS} results.`);
    }
    if (ignoredFilters.length > 0) {
      notices.push(`Not applied without an API key: ${ignoredFilters.join(", ")}.`);
    }
    if (notices.length > 0) {
      notices.push(GET_A_KEY);
    }
  }
  const payload: Record<string, unknown> = {
    query,
    provider: "clawifi",
    mode: outcome.mode,
    count: outcome.results.length,
    tookMs: Date.now() - start,
    externalContent: { untrusted: true, source: "web_search", provider: "clawifi", wrapped: true },
    results: outcome.results.map((result) => ({
      title: result.title ? wrapWebContent(result.title, "web_search") : "",
      url: result.url,
      description: result.snippet ? wrapWebContent(result.snippet, "web_search") : "",
      ...(result.publishedAt ? { published: result.publishedAt } : {}),
      siteName: resolveSiteName(result.url) || undefined,
    })),
    ...(outcome.creditsCharged !== undefined ? { creditsCharged: outcome.creditsCharged } : {}),
    ...(ignoredFilters.length > 0 ? { ignoredFilters } : {}),
    ...(notices.length > 0 ? { notice: notices.join(" ") } : {}),
  };
  writeCachedSearchPayload(cacheKey, payload, cacheTtlMs);
  return payload;
}
