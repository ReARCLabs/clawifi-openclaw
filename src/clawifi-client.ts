// Clawifi HTTP layer: builds the search request and reads the answer.
// No OpenClaw imports here, so it is unit-tested with plain Response objects.
//
// Clawifi has two ways in, and they are different transports:
//   with a key:    POST https://api.clawifi.dev/search/free   (REST, Bearer key, 1 credit, filters, up to 50 results)
//   without a key: POST https://api.clawifi.dev/mcp           (JSON-RPC tools/call search_free; 12 calls a minute and
//                  50 a day per address, at most 3 results, filters are not applied)
// The REST route answers 401 without a key, so the keyless path has to go through the hosted MCP endpoint.

import { CLIENT_LABEL } from "./version.js";

export const CLAWIFI_API_BASE_URL = "https://api.clawifi.dev";
export const CLAWIFI_SIGNUP_URL =
  "https://clawifi.dev/?utm_source=openclaw&utm_medium=integration&utm_campaign=clawhub-plugin";
export const CLAWIFI_QUERY_MAX_CHARS = 500;
export const CLAWIFI_KEYLESS_MAX_RESULTS = 3;
export const CLAWIFI_TIME_RANGES = ["day", "week", "month", "year"] as const;

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_DETAIL_CHARS = 300;

export type ClawifiTimeRange = (typeof CLAWIFI_TIME_RANGES)[number];
export type ClawifiSearchMode = "keyed" | "keyless";

export type ClawifiSearchInput = {
  query: string;
  count: number;
  apiKey?: string;
  timeRange?: ClawifiTimeRange;
  includeDomains?: string[];
  excludeDomains?: string[];
  country?: string;
  language?: string;
};

export type ClawifiHttpRequest = {
  mode: ClawifiSearchMode;
  url: string;
  init: { method: "POST"; headers: Record<string, string>; body: string };
};

export type ClawifiSearchResult = {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
};

export type ClawifiFailureCode =
  | "invalid_api_key"
  | "out_of_credits"
  | "rate_limited"
  | "keyless_limit";

export type ClawifiSearchOutcome =
  | {
      ok: true;
      mode: ClawifiSearchMode;
      results: ClawifiSearchResult[];
      cacheHit: boolean;
      creditsCharged?: number;
    }
  | {
      ok: false;
      mode: ClawifiSearchMode;
      code: ClawifiFailureCode;
      detail?: string;
      retryAfterSeconds?: number;
    };

/** A failure the agent cannot act on (server error, malformed answer). The host reports it as a tool error. */
export class ClawifiApiError extends Error {
  readonly status: number;
  readonly statusCode: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ClawifiApiError";
    this.status = status;
    this.statusCode = status;
  }
}

/** Filters a keyless search cannot apply. Empty with a key. */
export function ignoredKeylessFilters(input: ClawifiSearchInput): string[] {
  if (input.apiKey) {
    return [];
  }
  const ignored: string[] = [];
  if (input.timeRange) ignored.push("freshness");
  if (input.includeDomains?.length) ignored.push("include_domains");
  if (input.excludeDomains?.length) ignored.push("exclude_domains");
  if (input.country) ignored.push("country");
  if (input.language) ignored.push("language");
  return ignored;
}

export function buildClawifiSearchRequest(input: ClawifiSearchInput): ClawifiHttpRequest {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": CLIENT_LABEL,
    "X-Clawifi-Client": CLIENT_LABEL,
  };
  if (input.apiKey) {
    const body: Record<string, unknown> = { query: input.query, max_results: input.count };
    if (input.timeRange) body.time_range = input.timeRange;
    if (input.includeDomains?.length) body.include_domains = input.includeDomains;
    if (input.excludeDomains?.length) body.exclude_domains = input.excludeDomains;
    if (input.country) body.country = input.country;
    if (input.language) body.language = input.language;
    headers.Authorization = `Bearer ${input.apiKey}`;
    return {
      mode: "keyed",
      url: `${CLAWIFI_API_BASE_URL}/search/free`,
      init: { method: "POST", headers, body: JSON.stringify(body) },
    };
  }
  // The hosted MCP endpoint is stateless and answers JSON, so one tools/call request is enough (no initialize).
  // The streamable-HTTP transport wants both media types in Accept.
  headers.Accept = "application/json, text/event-stream";
  return {
    mode: "keyless",
    url: `${CLAWIFI_API_BASE_URL}/mcp`,
    init: {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "search_free", arguments: { query: input.query } },
      }),
    },
  };
}

export async function parseClawifiSearchResponse(
  mode: ClawifiSearchMode,
  response: Response,
  count: number,
): Promise<ClawifiSearchOutcome> {
  const text = await readBodyLimited(response);
  const payload = parseJson(text);
  return mode === "keyed"
    ? parseKeyedResponse(response, payload, count)
    : parseKeylessResponse(response, payload, count);
}

function parseKeyedResponse(response: Response, payload: unknown, count: number): ClawifiSearchOutcome {
  const mode = "keyed" as const;
  if (!response.ok) {
    const detail = restErrorMessage(payload);
    const retryAfterSeconds =
      parseRetryAfter(response.headers.get("retry-after")) ?? restRetryAfter(payload);
    if (response.status === 401 || response.status === 403) {
      return { ok: false, mode, code: "invalid_api_key", detail };
    }
    if (response.status === 402) {
      return { ok: false, mode, code: "out_of_credits", detail };
    }
    if (response.status === 429) {
      return { ok: false, mode, code: "rate_limited", detail, retryAfterSeconds };
    }
    throw new ClawifiApiError(
      `Clawifi API error (${response.status})${detail ? `: ${detail}` : ""}`,
      response.status,
    );
  }
  if (!isRecord(payload)) {
    throw new ClawifiApiError("Clawifi API returned malformed JSON", response.status);
  }
  const charged = Number(response.headers.get("x-clawifi-credits-charged"));
  return {
    ok: true,
    mode,
    results: readResults(payload.results, count),
    cacheHit: payload.cache_hit === true,
    ...(response.headers.has("x-clawifi-credits-charged") && Number.isFinite(charged)
      ? { creditsCharged: charged }
      : {}),
  };
}

function parseKeylessResponse(response: Response, payload: unknown, count: number): ClawifiSearchOutcome {
  const mode = "keyless" as const;
  const rpcError = isRecord(payload) && isRecord(payload.error) ? payload.error : undefined;
  if (response.status === 401 || response.status === 429) {
    // 401: the address's keyless day is used up (the endpoint then asks for sign-in). 429: an edge rate limit.
    return {
      ok: false,
      mode,
      code: "keyless_limit",
      detail: clip(typeof rpcError?.message === "string" ? rpcError.message : undefined),
      retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after")),
    };
  }
  if (!response.ok) {
    throw new ClawifiApiError(`Clawifi API error (${response.status})`, response.status);
  }
  if (rpcError) {
    throw new ClawifiApiError(
      `Clawifi API error: ${clip(String(rpcError.message ?? "request refused")) ?? "request refused"}`,
      response.status,
    );
  }
  const result = isRecord(payload) && isRecord(payload.result) ? payload.result : undefined;
  if (!result) {
    throw new ClawifiApiError("Clawifi API returned malformed JSON", response.status);
  }
  if (result.isError === true) {
    const message = contentText(result.content);
    if (/limit reached/i.test(message)) {
      const retry = /retry_after=(\d+)/.exec(message);
      return {
        ok: false,
        mode,
        code: "keyless_limit",
        detail: clip(message),
        retryAfterSeconds: retry ? Number(retry[1]) : undefined,
      };
    }
    throw new ClawifiApiError(
      `Clawifi search failed: ${clip(message) ?? "no detail given"}`,
      response.status,
    );
  }
  const structured = isRecord(result.structuredContent)
    ? result.structuredContent
    : parseJson(contentText(result.content));
  if (!isRecord(structured)) {
    throw new ClawifiApiError("Clawifi API returned malformed JSON", response.status);
  }
  return {
    ok: true,
    mode,
    results: readResults(structured.results, Math.min(count, CLAWIFI_KEYLESS_MAX_RESULTS)),
    cacheHit: structured.cache_hit === true,
  };
}

function readResults(value: unknown, count: number): ClawifiSearchResult[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const results: ClawifiSearchResult[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.url !== "string" || !/^https?:\/\//i.test(entry.url)) {
      continue;
    }
    const publishedAt =
      typeof entry.published_at === "string" && entry.published_at
        ? entry.published_at
        : typeof entry.modified_at === "string" && entry.modified_at
          ? entry.modified_at
          : undefined;
    results.push({
      title: typeof entry.title === "string" ? entry.title : "",
      url: entry.url,
      snippet: typeof entry.snippet === "string" ? entry.snippet : "",
      ...(publishedAt ? { publishedAt } : {}),
    });
    if (results.length >= count) {
      break;
    }
  }
  return results;
}

function restErrorMessage(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const error = isRecord(payload.error) ? payload.error : undefined;
  const message = error?.message ?? payload.detail;
  return typeof message === "string" ? clip(message) : undefined;
}

function restRetryAfter(payload: unknown): number | undefined {
  const error = isRecord(payload) && isRecord(payload.error) ? payload.error : undefined;
  const details = error && isRecord(error.details) ? error.details : undefined;
  const value = Number(details?.retry_after);
  return details?.retry_after !== undefined && Number.isFinite(value) && value >= 0
    ? Math.ceil(value)
    : undefined;
}

/** Retry-After as whole seconds: a delay, or an HTTP date. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.ceil(Number(trimmed));
  }
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - now) / 1000));
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
    .join(" ")
    .trim();
}

function clip(value: string | undefined): string | undefined {
  const cleaned = value?.replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return undefined;
  }
  return cleaned.length > MAX_ERROR_DETAIL_CHARS
    ? `${cleaned.slice(0, MAX_ERROR_DETAIL_CHARS)}…`
    : cleaned;
}

function parseJson(text: string): unknown {
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

async function readBodyLimited(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new ClawifiApiError(
        `Clawifi API response exceeds ${MAX_RESPONSE_BYTES} bytes`,
        response.status,
      );
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
