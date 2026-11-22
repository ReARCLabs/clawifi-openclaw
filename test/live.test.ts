// One real keyless search through the provider. Off by default: run with `npm run test:live`.
// It spends one of the address's 50 keyless calls a day and needs no key.
import { expect, it } from "vitest";
import { createClawifiWebSearchProvider } from "../web-search-contract-api.js";

it.runIf(process.env.CLAWIFI_LIVE === "1")("returns live keyless results", async () => {
  const definition = createClawifiWebSearchProvider().createTool({ config: {} as never });
  const payload = await definition!.execute({ query: "OpenClaw web search providers", count: 3 });
  expect(payload.error, JSON.stringify(payload)).toBeUndefined();
  expect(payload).toMatchObject({ provider: "clawifi", mode: process.env.CLAWIFI_API_KEY ? "keyed" : "keyless" });
  const results = payload.results as Array<Record<string, unknown>>;
  expect(results.length).toBeGreaterThan(0);
  expect(String(results[0]?.url)).toMatch(/^https?:\/\//);
});
