// openclaw 2026.11.6 ships these two plugin-sdk subpaths without type declarations.
// Only what this plugin uses is declared; signatures follow the OpenClaw source
// (src/agents/tools/web-search-provider-common.ts, src/plugin-sdk/provider-web-search-contract-fields.ts).

declare module "openclaw/plugin-sdk/provider-web-search-config-contract" {
  export function createWebSearchProviderContractFields(options: {
    credentialPath: string;
    searchCredential: { type: "scoped"; scopeId: string } | { type: "top-level" } | { type: "none" };
    configuredCredential?: { pluginId: string; field?: string };
    selectionPluginId?: string;
  }): {
    inactiveSecretPaths?: string[];
    getCredentialValue: (searchConfig?: Record<string, unknown>) => unknown;
    setCredentialValue: (searchConfigTarget: Record<string, unknown>, value: unknown) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    applySelectionConfig?: (config: any) => any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getConfiguredCredentialValue?: (config?: any) => unknown;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setConfiguredCredentialValue?: (configTarget: any, value: unknown) => void;
  };
  export function mergeScopedSearchConfig(
    searchConfig: Record<string, unknown> | undefined,
    key: string,
    pluginConfig: Record<string, unknown> | undefined,
    options?: { mirrorApiKeyToTopLevel?: boolean },
  ): Record<string, unknown> | undefined;
  export function resolveProviderWebSearchPluginConfig(
    config: unknown,
    pluginId: string,
  ): Record<string, unknown> | undefined;
}

declare module "openclaw/plugin-sdk/provider-web-search" {
  export const DEFAULT_SEARCH_COUNT: number;
  export const MAX_SEARCH_COUNT: number;
  export function buildSearchCacheKey(parts: Array<string | number | boolean | undefined>): string;
  export function readCachedSearchPayload(
    cacheKey: string,
    ttlMs?: number,
  ): Record<string, unknown> | undefined;
  export function writeCachedSearchPayload(
    cacheKey: string,
    payload: Record<string, unknown>,
    ttlMs: number,
  ): void;
  export function readConfiguredSecretString(value: unknown, path: string): string | undefined;
  export function readProviderEnvValue(envVars: string[]): string | undefined;
  export function readStringParam(
    params: Record<string, unknown>,
    key: string,
    options: { required: true },
  ): string;
  export function readStringParam(
    params: Record<string, unknown>,
    key: string,
    options?: { required?: boolean },
  ): string | undefined;
  export function resolveSearchCacheTtlMs(searchConfig?: Record<string, unknown>): number;
  export function resolveSearchCount(value: unknown, fallback: number): number;
  export function resolveSearchTimeoutSeconds(searchConfig?: Record<string, unknown>): number;
  export function resolveSiteName(url: string | undefined): string | undefined;
  export function withTrustedWebSearchEndpoint<T>(
    params: { url: string; timeoutSeconds: number; init: RequestInit; signal?: AbortSignal },
    run: (response: Response) => Promise<T>,
  ): Promise<T>;
  export function wrapWebContent(content: string, source?: "web_search" | "web_fetch"): string;
}
