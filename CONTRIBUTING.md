# Contributing

## Development

Iterate on a local checkout instead of pushing to GitHub for every edit.

### 1. Switch to the local checkout

In a Pi session opened in this repo:

```
/source local
```

It installs this checkout, removes the git entry, and reloads. `/source` on its own
reports where the package currently comes from.

Only one entry can exist: pi keys a git package by repository URL and a local package
by resolved absolute path, so both together would load the extension twice.

<details>
<summary>Manual equivalent, without the project extension</summary>

```sh
pi remove git:github.com/S1M0N38/pi-web
pi install ~/Code/github.com/S1M0N38/pi-web
```

A local package loads from the resolved path without copying, so edits are live.
Remove the git entry first.

</details>

### 2. Install dependencies

```sh
npm install
```

Pi installs dependencies for npm and git packages but never touches a local
checkout, so this dependency tree is yours to maintain.

### 3. Iterate

```sh
npm run typecheck   # tsc --noEmit over index.ts, src/, test/
npm test            # node --test test/e2e.test.ts
```

The test suite is offline: it stubs `fetch`, injects a fake DNS lookup, and points
`PI_CODING_AGENT_DIR` at a temp dir, so no API key and no real config are needed.
After editing, `/reload` in a session picks up the change; tool schemas and
descriptions live in `index.ts`.

### 4. Commit and push

Conventional commit messages:

```sh
git add -A && git commit -m "feat: <what changed>" && git push
```

### 5. Switch back to the published clone

```
/source github
```

`pi update git:github.com/S1M0N38/pi-web` later, to pull changes.

<details>
<summary>Manual equivalent, without the project extension</summary>

```sh
pi remove ~/Code/github.com/S1M0N38/pi-web
pi install git:github.com/S1M0N38/pi-web
```

</details>

## Notes

- The local entry is written to `settings.json` relative to the agent dir, so it is
  machine-local by design — never commit or copy it between machines.
- Real configuration lives at `$PI_CODING_AGENT_DIR/web.json`. Tests never read it.
- `pi -e ./pi-web` tries the checkout for one invocation without touching settings,
  but the git package must still be removed for the run — same identity rule.

## Architecture

Read [ARCHITECTURE.md](ARCHITECTURE.md) before changing internals: module layout,
fetch routing, provider fallback, storage bounds, SSRF rules, handoff table.
