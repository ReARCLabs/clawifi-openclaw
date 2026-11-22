import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  createWebSearchProviderContractFields,
  mergeScopedSearchConfig,
  resolveProviderWebSearchPluginConfig,
} from "openclaw/plugin-sdk/provider-web-search-config-contract";
import { CLAWIFI_SIGNUP_URL, CLAWIFI_TIME_RANGES } from "./clawifi-client.js";

type WebSearchProviderPlugin = Parameters<OpenClawPluginApi["registerWebSearchProvider"]>[0];

export const CLAWIFI_PLUGIN_ID = "clawifi";
export const CLAWIFI_CREDENTIAL_PATH = "plugins.entries.clawifi.config.webSearch.apiKey";
export const CLAWIFI_ENV_VARS = ["CLAWIFI_API_KEY"];

// The network code loads on the first search, not at plugin registration.
let runtimePromise: Promise<typeof import("./clawifi-web-search-provider.runtime.js")> | undefined;
function loadRuntime() {
  runtimePromise ??= import("./clawifi-web-search-provider.runtime.js");
  return runtimePromise;
}

const ClawifiSearchSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query string (at most 500 characters)." },
    count: {
      type: "integer",
      description: "Number of results to return (1-10). Without an API key at most 3 come back.",
      minimum: 1,
      maximum: 10,
    },
    freshness: {
      type: "string",
      enum: [...CLAWIFI_TIME_RANGES],
      description: 'Only recent results: "day", "week", "month" or "year". Needs an API key.',
    },
    include_domains: {
      type: "array",
      items: { type: "string" },
      description: 'Only results from these domains, e.g. ["docs.python.org"]. Needs an API key.',
    },
    exclude_domains: {
      type: "array",
      items: { type: "string" },
      description: "Drop results from these domains. Needs an API key.",
    },
    country: {
      type: "string",
      description: 'Two-letter country code (ISO 3166-1), e.g. "us". Needs an API key.',
    },
    language: {
      type: "string",
      description: 'Two-letter language code (ISO 639-1), e.g. "en". Needs an API key.',
    },
  },
  required: ["query"],
  additionalProperties: false,
} satisfies Record<string, unknown>;

export function createClawifiWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: CLAWIFI_PLUGIN_ID,
    label: "Clawifi",
    hint: "Web search across several engines · works without a key · a free key adds filters",
    onboardingScopes: ["text-inference"],
    // Search runs without a key (rate limited), so setup must not ask for one.
    requiresCredential: false,
    credentialLabel: "Clawifi API key (optional)",
    envVars: [...CLAWIFI_ENV_VARS],
    placeholder: "clawifi_live_...",
    signupUrl: CLAWIFI_SIGNUP_URL,
    docsUrl: "https://clawifi.dev/docs/search",
    autoDetectOrder: 90,
    credentialPath: CLAWIFI_CREDENTIAL_PATH,
    // Scoped credential: only this plugin's own key is read. The shared tools.web.search.apiKey may belong to
    // another provider and is never sent to Clawifi.
    ...createWebSearchProviderContractFields({
      credentialPath: CLAWIFI_CREDENTIAL_PATH,
      searchCredential: { type: "scoped", scopeId: CLAWIFI_PLUGIN_ID },
      configuredCredential: { pluginId: CLAWIFI_PLUGIN_ID },
      selectionPluginId: CLAWIFI_PLUGIN_ID,
    }),
    createTool: (ctx) => ({
      description:
        "Search the web with Clawifi (several engines as one). Returns titles, URLs and snippets, with a date when " +
        "the engine gives one. Without an API key: at most 3 results and no filters. With a key: up to 10 results, " +
        "freshness, domain, country and language filters.",
      parameters: ClawifiSearchSchema,
      execute: async (args, context) => {
        context?.signal?.throwIfAborted();
        const { executeClawifiSearch } = await loadRuntime();
        const searchConfig = mergeScopedSearchConfig(
          ctx.searchConfig,
          CLAWIFI_PLUGIN_ID,
          resolveProviderWebSearchPluginConfig(ctx.config, CLAWIFI_PLUGIN_ID),
        );
        return await executeClawifiSearch(args, searchConfig, context?.signal);
      },
    }),
  };
}
