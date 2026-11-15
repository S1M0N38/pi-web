# pi-web

> Heavily inspired by the popular [pi-web-access](https://github.com/nicobailon/pi-web-access)

Minimal web access for Pi: search, fetch pages, page stored content, and check claims. If web is not the best way to get some data, it hands off to specialized CLI tools.

*How many tokens pi-web add to context?* **~1k**

## Install

```bash
pi install git:github.com/S1M0N38/pi-web
```

The extension fails at load without a config file. Create `$PI_CODING_AGENT_DIR/web.json` (default: `~/.pi/agent/web.json`):

```json
{
  "providers": ["duckduckgo"],
  "answerModel": "provider/model:reasoning-lvl"
}
```

`providers` and `answerModel` are always required. DuckDuckGo needs no API key, so this is the smallest working config. See [Configuration](#configuration) for keys and provider order.

```bash
chmod 600 "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/web.json"
```

### Uninstall

```bash
pi remove git:github.com/S1M0N38/pi-web
rm "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/web.json"
```

## Usage

`pi-web` exposes exactly four tools. The model calls them; the network-facing ones return their result inline and store it under a `responseId`.

- **`web_search`** — searches one or more queries through the ordered provider chain and stores ranked results.
- **`fetch_content`** — fetches URLs as readable Markdown, raw text, PDF text, or a grounded answer.
- **`source_check`** — searches for a claim, optionally fetches results, classifies sources, extracts passages, and stores an evidence artifact. It reports `unclear` or `missing-evidence`; it never declares a verdict.
- **`get_search_content`** — pages a stored search, fetch, or research artifact by `responseId` with `offset` and `limit`, so the model can read more without fetching again.

The store is in-memory and LRU-bounded; it is not written to disk and does not survive the Pi process.

## Configuration

```json
{
  "providers": ["brave", "tavily", "exa", "duckduckgo"],
  "braveApiKey": "brv-...",
  "tavilyApiKey": "$TAVILY_API_KEY",
  "exaApiKey": "!security find-generic-password -s exa -w",
  "answerModel": "provider/model:reasoning-lvl"
}
```

- `providers` is ordered fallback. Only rate limits fall through to the next provider.
- API keys can be literal strings, `$ENV_VAR` or `!cmd`. Only keys for listed providers are required. Credentials resolve lazily, on first use.
- `answerModel` is a Pi model reference and uses Pi's existing model authentication. It is required even if you never use `mode: "answer"`.
- Unknown keys are rejected, so a typo fails loudly instead of being ignored.
- [Brave](https://brave.com/search/api/), [Tavily](https://tavily.com/), [Exa](https://exa.ai/) offer free usage/credits. DuckDuckGo needs no API key.
- Missing or invalid config fails at extension load.

## Optional CLIs

These CLIs are optional but strongly recommended. They are only needed when a handoff targets them:

- [`gh`](https://github.com/cli/cli) and [`git`](https://github.com/git/git) — GitHub repositories and Gists
- [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) — YouTube
- [`opencli`](https://github.com/jackwener/OpenCLI) — login-gated sites such as Reddit, X, and many others (truly crazy)

`fetch_content` never clones or downloads these itself: it returns a `HANDOFF → <tool>` result with commands to run, and the model calls the native tool.

## Contributing

- [CONTRIBUTING.md](CONTRIBUTING.md)
- [ARCHITECTURE.md](ARCHITECTURE.md)
- [AGENTS.md](AGENTS.md)
