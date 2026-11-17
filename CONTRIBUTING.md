# Contributing

## Development

Point pi at this checkout instead of pushing to GitHub for every edit. `/source` is not
built in — it comes from [pi-source](https://github.com/S1M0N38/pi-source):

```sh
pi install git:github.com/S1M0N38/pi-source
```

Then, in a session started in this repository:

```
/source local     # install this checkout, remove the git entry, reload
/source github    # back to the published clone
/source           # report what is installed now
```

Only one entry can exist: pi keys a git package by repository URL and a local package
by resolved absolute path, so both together load the extension twice.

<details>
<summary>Manual equivalent</summary>

```sh
pi remove git:github.com/S1M0N38/pi-web
pi install ~/Code/github.com/S1M0N38/pi-web
```

</details>

Then:

```sh
npm install         # pi never installs dependencies for a local checkout
npm run typecheck   # tsc --noEmit over index.ts, src/, test/
npm test            # offline: stubbed fetch, temp PI_CODING_AGENT_DIR
```

`/reload` in a session picks up edits. Commit with conventional messages (`feat:`,
`fix:`, `docs:`, `chore:`).

## Notes

- The local entry in `settings.json` is relative to the agent dir: machine-local, never
  commit or copy it between machines.
- Real configuration lives at `$PI_CODING_AGENT_DIR/web.json`; tests never read it.
- `pi -e ./pi-web` skips the settings change for one run, but the git package must still
  be removed — same identity rule.

## Architecture

Internals live in [ARCHITECTURE.md](ARCHITECTURE.md): module layout, fetch routing,
provider fallback, storage bounds, SSRF rules, handoff table.
