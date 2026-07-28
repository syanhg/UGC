# Security

## Reporting a vulnerability

Please report security issues privately via
[GitHub's private vulnerability reporting](https://github.com/syanhg/UGC/security/advisories/new)
rather than opening a public issue. Include what you found, how to reproduce it,
and what an attacker could do with it. Expect a first response within a week.

## What this tool touches

`ugc` is a local CLI. It has no server, no telemetry, and no account system.
Understanding what it can reach is most of the threat model:

- **Network.** Google's Gemini API (`generativelanguage.googleapis.com`) for generation and downloads. `ugc avatar sync` additionally talks to Paper Desktop's MCP server on `127.0.0.1`, and fetches image URLs that server hands back — restricted to `http`/`https` so a design file cannot point it at `file:` or `data:`.
- **Filesystem.** Reads reference photos you pass in. Writes clips to `./out`, and the avatar library, config, and API key to `~/.ugc` (or `$UGC_HOME`).
- **Credentials.** One Gemini API key.

## How the API key is handled

- Stored in `~/.ugc/.env`, created `0600` inside a `0700` directory.
- Sent as an `x-goog-api-key` **header**, never as a `?key=` query parameter — query strings leak into proxy logs, crash reports, and quoted error messages.
- Stripped from every error message before printing, including nested `cause` chains, by `redact()` in `src/generate.ts`. This covers query-parameter, header, bearer, and bare-value forms, plus anything matching Google's key shape.

If you think a key has leaked, revoke it at
[aistudio.google.com/apikey](https://aistudio.google.com/apikey). It is billable.

## Untrusted input

Two inputs are not fully under your control, and both are bounds-checked:

- **`avatars.json`** is a hand-editable file whose keys are used to build paths that get recursively deleted. Names are validated against `^[a-z0-9][a-z0-9_-]*$` and resolved paths are confined to the data directory before any delete.
- **Design-file layer names and image fills** from `ugc avatar sync` are slugified into avatar names and validated the same way; image URLs are scheme-restricted.

## Generated content

`personGeneration` accepts only `allow_adult` and `dont_allow`. Veo's wider
`allow_all` setting permits generating minors, and this tool refuses to pass it
through — see `assertPersonGeneration` in `src/config.ts`. Please do not send
patches that add it back.

See the Responsible use section of the [README](README.md#responsible-use) for
the consent and disclosure expectations that come with generating a real
person's likeness.
