// Backups offered on each history page ("If X is down: switch to a backup").
// Every base_url was checked against the provider's own docs on Nov 8, 2026
// (links below). Re-check before changing anything here; a test pins them.
// Model names are NOT filled in on purpose: they change often, so the code
// says PICK_FROM_LIST and links to the provider's current model list.
// `status` = the board's service id for live status, or null if not monitored.
// No referral links here (planned later, marked rel="sponsored" when added).

export const BACKUPS = [
  {
    id: "openrouter",
    name: "OpenRouter",
    status: null,
    base_url: "https://openrouter.ai/api/v1",
    env: "OPENROUTER_API_KEY",
    docs: "https://openrouter.ai/docs/quickstart",
    models: "https://openrouter.ai/models",
    note: "One key for many companies' models. Pick a model from a different company than the one that is down.",
  },
  {
    id: "groq",
    name: "Groq",
    status: "groq",
    base_url: "https://api.groq.com/openai/v1",
    env: "GROQ_API_KEY",
    docs: "https://console.groq.com/docs/openai",
    models: "https://console.groq.com/docs/models",
    note: "",
  },
  {
    id: "gemini",
    name: "Gemini",
    status: "gemini",
    base_url: "https://generativelanguage.googleapis.com/v1beta/openai/",
    env: "GEMINI_API_KEY",
    docs: "https://ai.google.dev/gemini-api/docs/openai",
    models: "https://ai.google.dev/gemini-api/docs/openai",
    note: "Google's OpenAI-compatible mode for the Gemini API.",
  },
  {
    id: "openai",
    name: "OpenAI",
    status: "openai",
    base_url: "https://api.openai.com/v1",
    env: "OPENAI_API_KEY",
    docs: "https://platform.openai.com/docs/libraries",
    models: "https://platform.openai.com/docs/libraries",
    note: "",
  },
  {
    id: "claude",
    name: "Claude",
    status: "claude",
    base_url: "https://api.anthropic.com/v1/",
    env: "ANTHROPIC_API_KEY",
    docs: "https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk",
    models: "https://platform.claude.com/docs/en/about-claude/models/overview",
    note: "Anthropic describes its OpenAI-compatible mode as mainly for testing; for long-term production use, its own SDK is recommended.",
  },
  {
    id: "xai",
    name: "xAI (Grok)",
    status: "xai",
    base_url: "https://api.x.ai/v1",
    env: "XAI_API_KEY",
    docs: "https://docs.x.ai/docs/guides/chat",
    models: "https://docs.x.ai/docs/guides/chat",
    note: "",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    status: "deepseek",
    base_url: "https://api.deepseek.com",
    env: "DEEPSEEK_API_KEY",
    docs: "https://api-docs.deepseek.com/",
    models: "https://api-docs.deepseek.com/",
    note: "",
  },
];

// The first four backups that aren't the service itself, in the order above.
export function backupsFor(serviceId) {
  return BACKUPS.filter((b) => b.id !== serviceId).slice(0, 4);
}

export function pythonSnippet(b) {
  return [
    "import os",
    "from openai import OpenAI",
    "",
    "client = OpenAI(",
    '    base_url="' + b.base_url + '",',
    '    api_key=os.environ["' + b.env + '"],',
    ")",
    "reply = client.chat.completions.create(",
    '    model="PICK_FROM_LIST",  # see ' + b.name + "'s current model list",
    '    messages=[{"role": "user", "content": "Hello"}],',
    ")",
    "print(reply.choices[0].message.content)",
  ].join("\n");
}

export function jsSnippet(b) {
  return [
    'import OpenAI from "openai";',
    "",
    "const client = new OpenAI({",
    '  baseURL: "' + b.base_url + '",',
    "  apiKey: process.env." + b.env + ",",
    "});",
    "const reply = await client.chat.completions.create({",
    '  model: "PICK_FROM_LIST", // see ' + b.name + "'s current model list",
    '  messages: [{ role: "user", content: "Hello" }],',
    "});",
    "console.log(reply.choices[0].message.content);",
  ].join("\n");
}
