# @clawifi/openclaw-search

[Clawifi](https://clawifi.dev/?utm_source=openclaw&utm_medium=integration&utm_campaign=clawhub-plugin) web search provider plugin for [OpenClaw](https://docs.openclaw.ai/tools/web). It registers `clawifi` as a `web_search` provider next to the built-in ones. Clawifi searches several engines as one and returns titles, URLs and snippets, with a date when the engine gives one.

This is a third-party plugin, distributed through ClawHub and npm. It is not part of OpenClaw core.

## Install

```bash
openclaw plugins install clawhub:clawifi/openclaw-search
# or from npm
openclaw plugins install npm:@clawifi/openclaw-search
```

OpenClaw asks you to accept the plugin's capabilities (it registers one web search provider); in a script, add `--accept-capabilities`.

Then choose Clawifi as the search provider:

```bash
openclaw configure --section web
```

or set it in the config:

```jsonc
{
  "tools": { "web": { "search": { "provider": "clawifi" } } }
}
```

Check it:

```bash
openclaw infer web search --query "OpenClaw plugin SDK" --json
```

## Works without an API key

The plugin searches with no key and no account. A free key lifts the limits.

| | Without a key | With a key |
| --- | --- | --- |
| Results per search | up to 3 | up to 10 |
| `freshness`, `include_domains`, `exclude_domains`, `country`, `language` | not applied | applied |
| Limits | 12 searches a minute, 50 a day per address | your plan's limits |
| Cost | free | 1 credit a search; 0 when nothing is found |

A free account has 1,000 credits a month and needs no card: [clawifi.dev](https://clawifi.dev/?utm_source=openclaw&utm_medium=integration&utm_campaign=clawhub-plugin).

When a search without a key asks for a filter or for more than 3 results, the search still runs and the answer says what was not applied (`ignoredFilters`, `notice`).

## Add a key

Either set the environment variable in the Gateway environment:

```bash
export CLAWIFI_API_KEY=clawifi_live_...
```

or store it in the plugin config (a SecretRef object works too):

```jsonc
{
  "plugins": {
    "entries": {
      "clawifi": {
        "config": {
          "webSearch": {
            "apiKey": "clawifi_live_..."
          }
        }
      }
    }
  }
}
```

The plugin reads only its own key. The shared `tools.web.search.apiKey` is never sent to Clawifi.

## Tool parameters

| Parameter | Type | Notes |
| --- | --- | --- |
| `query` | string | Required, at most 500 characters |
| `count` | integer | 1 to 10. Default: `tools.web.search.maxResults`, else 5 |
| `freshness` | string | `day`, `week`, `month` or `year` |
| `include_domains` | string[] | Only results from these domains (up to 20) |
| `exclude_domains` | string[] | Drop results from these domains (up to 50) |
| `country` | string | Two-letter code, e.g. `us` |
| `language` | string | Two-letter code, e.g. `en` |

OpenClaw's `tools.web.search.timeoutSeconds` and `cacheTtlMinutes` apply as for every provider.

## Errors

Problems the agent or operator can act on come back as a payload with `error`, `message` and `docs`:

| `error` | Meaning |
| --- | --- |
| `clawifi_keyless_limit` | The keyless limit for this address is reached. Wait, or add a key |
| `clawifi_invalid_api_key` | Clawifi refused the key |
| `clawifi_out_of_credits` | The account has no credits left |
| `clawifi_rate_limited` | The plan's rate limit is reached; `retryAfterSeconds` says how long to wait |
| `invalid_freshness`, `invalid_country`, `invalid_language`, `query_too_long` | A parameter was refused before any request |

Server errors are thrown, so OpenClaw reports them as a failed tool call.

## What the plugin sends

- Without a key: one `POST https://api.clawifi.dev/mcp` (the `search_free` tool) with the query.
- With a key: one `POST https://api.clawifi.dev/search/free` with the query, the filters and the key as a Bearer token.
- Both carry `User-Agent: clawifi-openclaw/<version>`. Nothing else about the machine, the user or the conversation is sent.

Result titles and snippets are wrapped as untrusted external content before the model sees them.

## Requirements

OpenClaw 2026.9.2 or later. Built and tested against 2026.11.6.

## Develop

```bash
npm install
npm run typecheck
npm test            # mocked HTTP, no network
npm run test:live   # one real keyless search
npm run build       # tsc -> dist/, the JavaScript OpenClaw loads
```

## License

MIT, ReARC Labs Inc.
