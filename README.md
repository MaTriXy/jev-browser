# jev-browser

[![CI](https://github.com/jkudish/jev-browser/actions/workflows/ci.yml/badge.svg)](https://github.com/jkudish/jev-browser/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

jev-browser gives agents one MCP tool, `jev_navigate`: pass a task and a start URL, and a [Jev](https://docs.typesafe.ai)-driven agent navigates a real headless browser until the goal is met or a safety gate fires. It returns the final page, the full step trace with confidences, console and network errors captured along the way, token usage with estimated cost, and a screenshot.

Jev makes the decisions (typed Choices over the page's actions, with probabilities and confidence); code owns the loop (budgets, recovery, stop gates). Free-form typing goes through a small model of your choice, because Jev does not generate strings. A typical run finishes in seconds for well under a cent.

## Install

Requires Node.js 20 or newer, a TypeSafe API key from [console.typesafe.ai/settings/keys](https://console.typesafe.ai/settings/keys), and optionally a key for any typing provider. Playwright's Chromium downloads automatically on install; set `JEV_BROWSER_SKIP_BROWSER_DOWNLOAD=1` to opt out.

Amp:

```bash
amp mcp add jev-browser -- npx -y github:jkudish/jev-browser
```

Claude Code:

```bash
claude mcp add jev-browser -- npx -y github:jkudish/jev-browser
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.jev-browser]
command = "npx"
args = ["-y", "github:jkudish/jev-browser"]
```

OpenCode (`opencode.json`):

```json
{
  "mcp": {
    "jev-browser": {
      "type": "local",
      "command": ["npx", "-y", "github:jkudish/jev-browser"],
      "environment": { "TYPESAFE_API_KEY": "ts_..." }
    }
  }
}
```

Any other MCP client:

```json
{
  "mcpServers": {
    "jev-browser": {
      "command": "npx",
      "args": ["-y", "github:jkudish/jev-browser"],
      "env": { "TYPESAFE_API_KEY": "ts_..." }
    }
  }
}
```

Some MCP clients filter the environment before spawning servers, which silently drops `TYPESAFE_API_KEY`. If the server reports a missing key, pass it explicitly as shown above.

## The tool

```jsonc
// arguments
{
  "task": "Search Wikipedia for the espresso-based drink called Ristretto and stop when you are on that article",
  "start_url": "https://en.wikipedia.org/wiki/Main_Page"
}
```

```jsonc
// live result, abridged
{
  "status": "done",
  "final_url": "https://en.wikipedia.org/wiki/Ristretto",
  "elapsed_ms": 5894,
  "steps": [
    { "step": 1, "action": "click_e2", "detail": "a \"Search Wikipedia [f]\" -> /wiki/Special:Search", "confidence": 1.0 },
    { "step": 2, "action": "type_e1", "detail": "typed \"Ristretto\" via openrouter", "confidence": 0.99 },
    { "step": 3, "action": "done", "detail": "agent declared done", "confidence": 1.0 }
  ],
  "usage": { "jev_calls": 3, "input_tokens": 45810, "est_cost_usd": 0.0021 }
}
```

The full result also carries `final_title`, the page payload in your chosen `format`, per-step `goal_done` and `stuck` probabilities, captured console/page/network errors, and the final screenshot as an image block.

Parameters: `max_steps` (default 24), `max_seconds` (default 180), `allow_typing` (default true), `format` (`text` 8k chars default, `markdown` 16k, `html` 1MB, `aria` 16k), `max_chars` (override the cap), `screenshot` (`final`, default, or `none`).

## How it decides

Each step is one Jev call with three questions over the same state: an action Choice over the page's interactive elements plus scroll/back/done, a goal Noul, and a stuck Noul ([fan-out pattern](https://docs.typesafe.ai/patterns/fan-out.md)). Elements come from the DOM directly, not the accessibility tree, because accessibility trees under-report inputs; the agent found DuckDuckGo's search box only after this switch. Actions: click, type, select a native dropdown (a second Choice picks the option), scroll, back, done.

Stop conditions, in code: the agent chooses `done`, goal probability > 0.85, stuck probability > 0.85, the step budget, or the time budget. A repeated action with no effect switches to the next-best option from the Choice distribution. There is deliberately no low-confidence override: split probability across several similar elements is usually several acceptable alternatives, not uncertainty.

Statuses: `done` (agent chose to stop), `goal_achieved` (the goal watcher fired), `stuck`, `max_steps`, `timeout`, `error`. `done` and `goal_achieved` are two independent judgments; agreement between them is what a trustworthy finish looks like, and the trace shows both at every step.

## Limits

- Up to 240 elements per step; Jev's Choice supports 255 options. Beyond that the list is truncated and the state says so, which can hide the needed element on very dense pages. Two-stage selection is planned.
- Password and file inputs are never offered. Hover-revealed menus, keyboard actions (Escape, Enter on unstaged fields), multi-field form sequencing, shadow DOM, and iframes are out of scope for v0.1.
- Thresholds (0.85 goal, 0.85 stuck, budgets) are starting points measured on Wikipedia and DuckDuckGo tasks. Tune them for your sites.
- Jev is calibrated, not infallible. Treat the trace as evidence, not proof.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | none | Required. |
| `JEV_BROWSER_MODEL` | `jev-latest` | Pin a Jev version. |
| `JEV_BROWSER_TYPE_PROVIDER` | auto | `openai`, `openrouter`, `anthropic`, `google`; auto-detected from key shape when unset. |
| `JEV_BROWSER_TYPE_MODEL` | per provider | Override the typing model (`gpt-5.6-luna`, `openai/gpt-5.6-luna`, ...). |
| `JEV_BROWSER_TYPE_BASE_URL` | none | Use any OpenAI-compatible endpoint (Ollama, LM Studio, vLLM); wins over provider detection. Pair with `JEV_BROWSER_TYPE_API_KEY` if needed. |
| `JEV_BROWSER_HEADED` | unset | Set to `1` to watch the browser. |
| `JEV_BROWSER_SKIP_BROWSER_DOWNLOAD` | unset | Set to `1` to skip the Chromium postinstall. |

Without any typing-provider key, typing falls back to a keyword heuristic and says so in the trace (`via keyword-heuristic`); expect worse queries.

## Development

```bash
npm install
npm run build
npm test            # unit tests, offline
npm run test:e2e    # live navigation tests; requires TYPESAFE_API_KEY
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
