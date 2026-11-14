# Claude Code instructions

@AGENTS.md

## Working in this repository with Claude Code

- Node.js 22 or later. Install dependencies with `npm ci`.
- `npm run check` (TypeScript and Vitest) and `npm run build` are required for substantive code changes. `npm run build:extension` produces the loadable Chrome extension in `build/extension/`.
- `npm run dev` serves Preview. Chromium and Playwright are available in cloud sessions for the browser workflows in `docs/test-guide.md`.
- The files under `docs/release-*-qa.md`, `docs/specialist-audit.md`, `docs/regression-audit.md`, and similar are dated QA records from an earlier toolchain. Where they mention a "Sites" build helper or `.openai/`, the equivalent here is the npm scripts above. Do not treat them as the current state; check the code.
- The product contains no model calls. "MCP" in this codebase means Arena's MCP server, which the viewer backend consumes on behalf of a signed-in user. An assistant's own Arena MCP connection does not give the app credentials and must not be used to stand in for one.
- Never read or commit a private provider module or `.env` file. `server/provider.example.mjs` is intentionally unconfigured.
