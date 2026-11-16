// v1.18.0 (Nov 15, 2026): the six services added in hidden sample mode.
// Feed addresses and component names were read from the live official feeds
// on Nov 15, 2026 (in a browser): data.x.ai/status/summary.json (Cursor parts
// have ids starting "cursor-"), status.claude.com/api/v2/summary.json
// ("Claude Code"), status.openai.com/api/v2/components.json (the Codex parts;
// summary.json stops at 25 parts and leaves them out), status.windsurf.com
// (Atlassian Statuspage), status.elevenlabs.io (incident.io: page-wide status
// only, no parts) and status.runwayml.com (Atlassian Statuspage, "Public API").
// The API checks for Cursor, Windsurf, ElevenLabs and Runway are UNVERIFIED
// candidates: the samples decide whether they are kept.
import { json, statuspage } from "./helpers.js";

export const NEW_SERVICES = {
  cursor: {
    feed: "https://data.x.ai/status/summary.json", // shared with Grok / xAI
    probe: "https://api2.cursor.sh",
  },
  "claude-code": {
    feed: "https://status.claude.com/api/v2/summary.json", // shared with Claude
    probe: "https://api.anthropic.com/v1/models", // shared with Claude
  },
  codex: {
    feed: "https://status.openai.com/api/v2/components.json",
    probe: "https://api.openai.com/v1/models", // shared with OpenAI
  },
  windsurf: {
    feed: "https://status.windsurf.com/api/v2/summary.json",
    probe: "https://server.codeium.com",
  },
  elevenlabs: {
    feed: "https://status.elevenlabs.io/api/v2/summary.json",
    probe: "https://api.elevenlabs.io/v1/models",
  },
  runway: {
    feed: "https://status.runwayml.com/api/v2/summary.json",
    probe: "https://api.dev.runwayml.com/v1/organization",
  },
};

// v1.19.0: only Windsurf is still hidden; its routes. The other five are in
// helpers.js (URLS and healthyRoutes).
export function newRoutes() {
  return {
    [NEW_SERVICES.windsurf.feed]: () => json({
      ...statuspage("none"),
      components: [{ name: "Cascade", status: "operational" }, { name: "Windsurf Tab", status: "operational" }],
    }),
    [NEW_SERVICES.windsurf.probe]: () => new Response("fault filter abort", { status: 404 }),
  };
}
