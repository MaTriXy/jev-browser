# Changelog

## 0.1.0

Initial release, published to npm as `@jkudish/jev-browser` (the unscoped `jev-browser` name belongs to another project).

- `jev_navigate` MCP tool: task plus start URL in, final page plus step trace, captured console and network errors, usage and estimated cost, and a final screenshot out.
- One primary Jev call per step: an action Choice over up to 240 page elements plus scroll, back, and done; a goal judgment; a stuck judgment. A select action adds one second-stage Choice for its option.
- Stop gates run before action execution: agent `done`, goal probability, stuck probability, step budget (24), time budget (180 s), caller cancellation.
- Typing cascade through the Vercel AI SDK: OpenAI, OpenRouter, Anthropic, Google, or any OpenAI-compatible endpoint, with a keyword fallback that is labeled in the trace.
- CLI (`jev-browser run`) and library import (`dist/navigate.js`) alongside the MCP server.
- Page payload formats: text, markdown, html, aria snapshot, with per-format caps and truncation flags.

No versioning policy has been declared yet; treat 0.x APIs as unstable.
