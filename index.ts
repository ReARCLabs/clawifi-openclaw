import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createClawifiWebSearchProvider } from "./src/clawifi-web-search-provider.js";

export default definePluginEntry({
  id: "clawifi",
  name: "Clawifi",
  description: "Clawifi web search provider for OpenClaw",
  register(api) {
    api.registerWebSearchProvider(createClawifiWebSearchProvider());
  },
});
