import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import plugin from "../index.js";
import { createClawifiWebSearchProvider } from "../web-search-contract-api.js";
import { PLUGIN_VERSION } from "../src/version.js";

const read = (name: string) =>
  JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), "utf8")) as Record<string, any>;
const pkg = read("package.json");
const manifest = read("openclaw.plugin.json");

it("keeps the version constant equal to package.json", () => {
  expect(PLUGIN_VERSION).toBe(pkg.version);
});

it("declares the provider it registers", () => {
  const provider = createClawifiWebSearchProvider();
  expect(manifest.id).toBe("clawifi");
  expect(manifest.contracts.webSearchProviders).toEqual([provider.id]);
  expect(manifest.setup.providers[0].envVars).toEqual(provider.envVars);
  expect(provider.credentialPath).toBe(`plugins.entries.${manifest.id}.config.webSearch.apiKey`);
  expect(Object.keys(manifest.configSchema.properties.webSearch.properties)).toEqual(["apiKey"]);
});

it("registers exactly one web search provider through the plugin entry", () => {
  const registered: unknown[] = [];
  const entry = plugin as unknown as { id: string; register: (api: unknown) => void };
  expect(entry.id).toBe("clawifi");
  entry.register({ registerWebSearchProvider: (provider: unknown) => registered.push(provider) });
  expect(registered).toHaveLength(1);
  expect(registered[0]).toMatchObject({ id: "clawifi", requiresCredential: false });
});

it("points the package at built JavaScript and ships the manifest", () => {
  expect(pkg.openclaw.extensions).toEqual(["./dist/index.js"]);
  expect(pkg.files).toEqual(expect.arrayContaining(["dist", "openclaw.plugin.json", "README.md", "LICENSE"]));
  expect(pkg.license).toBe("MIT");
  expect(readFileSync(new URL("../LICENSE", import.meta.url), "utf8")).toContain("ReARC Labs Inc.");
});

it("has every field the host checks on a web search provider", () => {
  const provider = createClawifiWebSearchProvider() as unknown as Record<string, unknown>;
  for (const field of ["id", "label", "hint", "placeholder", "signupUrl", "credentialPath"]) {
    expect(typeof provider[field], field).toBe("string");
  }
  for (const field of ["getCredentialValue", "setCredentialValue", "createTool"]) {
    expect(typeof provider[field], field).toBe("function");
  }
  expect(provider.signupUrl).toBe(
    "https://clawifi.dev/?utm_source=openclaw&utm_medium=integration&utm_campaign=clawhub-plugin",
  );
});
