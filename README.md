# ugc

CLI for generating short, face-consistent UGC clips. Point it at a reference
photo, give it a line of dialogue or action, get an 8-second vertical video. Register a subject once, and every clip after it reuses the same photos, seed,
and identity description, which is what keeps the face from drifting between
takes.

```bash
ugc avatar add sofia ~/photos/sofia.jpg --notes "mid-20s, dark hair"
ugc gen "holds up the serum bottle: 'three days. three.'" --avatar sofia
```

Video generation runs on Google Veo via the Gemini API. Avatars can be created
from local photos, or pulled straight from a [Paper](https://paper.design)
design file over Paper Desktop's MCP server. See
[Syncing from Paper](#syncing-from-paper-optional).

## Install

Needs Node 22.18 or newer, on macOS or Linux.

```bash
npm install -g github:syanhg/UGC
ugc setup
```

`setup` stores your Gemini API key in `~/.ugc/.env` with `0600` permissions and
checks it against the API before you spend anything. Get a key at
[aistudio.google.com/apikey](https://aistudio.google.com/apikey).

Veo is **not on the free tier**. The Google Cloud project behind your key needs
billing enabled.

| Model | Per second (720p) | 8s clip |
|---|---|---|
| `veo-3.1-fast-generate-preview` | ~$0.10 | ~$0.80 |
| `veo-3.1-generate-preview` | ~$0.40 | ~$3.20 |


## Use

Run `ugc` with no arguments for a guided session. It walks through avatar,
prompt, model, aspect ratio, duration, and count, then shows a cost estimate
before anything is sent:

```
Ready
  4 clips · veo-3.1-fast-generate-preview · 8s · 9:16 · 720p · avatar sofia
  Estimated cost: ~$3.20
Generate? [y/N]
```

Every answer maps to a flag, so anything you do interactively can be scripted:

```bash
ugc gen "unboxes the package on her bed" --avatar sofia --n 4 -j 4
ugc batch shots.example.txt --avatar sofia --resolution 1080p -j 3
```

Clips land in `./out` relative to where you ran the command.

| Flag | Values | Notes |
|---|---|---|
| `--duration` | 4, 6, 8 | Veo accepts nothing else |
| `--aspect` | `9:16`, `16:9` | vertical or landscape |
| `--resolution` | `720p`, `1080p` | |
| `--n` | any | variations at consecutive seeds |
| `--concurrency` / `-j` | 1 to 5 | how many render at once |
| `--photo` | 1-based | which of the avatar's photos to open on |
| `--seed` | any | overrides the avatar's locked seed |
| `--dry-run` | | print the assembled prompt, send nothing |

A clip takes minutes, almost all of it waiting on Google's queue, so `-j 4`
runs a batch roughly four times faster. Past 5 you trade waiting for
rate-limit errors. One failure doesn't stop the others, and the exit code is
non-zero if any failed.

## Avatars

```bash
ugc avatar add <name> <photo...>   # photos are copied into ~/.ugc/refs/<name>/
ugc avatar list
ugc avatar sync                    # pull avatars from Paper (see below)
ugc avatar rm <name>
```

An avatar stores the reference photos, a locked seed, and an optional `--notes`
identity description that gets appended to the style prompt. Photos are copied
rather than referenced, so moving the original later can't change your avatar.

### Syncing from Paper (optional)

`ugc avatar sync` sources avatars from [Paper](https://paper.design), so you can
keep faces in a design file and pull them in instead of managing photos by hand.

It talks to **Paper Desktop's built-in MCP server**, which runs on
`http://127.0.0.1:29979/mcp` while a file is open. There is nothing to install
or configure: open a file in Paper Desktop and run the command. Override the
address with `PAPER_MCP_URL` if yours differs.

```bash
ugc avatar sync --dry-run   # show what would be pulled, download nothing
ugc avatar sync
```

One top-level layer becomes one avatar, named after that layer. Every image in
its subtree becomes one of that avatar's reference photos, so grouping several
photos of one person into a frame gives that avatar several refs. Re-syncing
replaces an avatar's photos while keeping its original seed. Local-only avatars
are reported but never deleted.

Every other part of `ugc` works without Paper. It is only a source for photos.

Settings resolve in this order, each overriding the last:

```
defaults -> ~/.ugc/config.json -> ./ugc.config.json -> avatar -> CLI flags
```

`ugc where` prints where everything lives. Nothing is written next to the
installed code, so the tool works the same from any directory.

## Keeping the face consistent

| Mode | How it works | Best for |
|---|---|---|
| `i2v` *(default)* | Your reference image becomes the literal first frame | Tightest identity lock |
| `r2v` | References passed as identity hints | More camera and pose variety, looser likeness |
| `t2v` | No reference at all | Broll, product shots, anything faceless |

Reusing the same reference photos matters more than any other setting, which is
what registering an avatar enforces. If clips drift in `r2v`, switch to `i2v`. A
seed reproduces a *run*; it does not by itself hold a face steady across
different prompts. The reference photos do that.

## Responsible use

This tool animates a photograph of a real person into a video of them speaking
to camera. That is useful for making your own ads, and it is also how a
convincing deepfake is made. Before you publish anything:

- **Get written consent from the person whose face you are using.** In most jurisdictions this is a legal question, not a courtesy.
- **Never use a photo of a minor.** The tool refuses Veo's `allow_all` setting outright, and that is not a limitation to work around.
- **Disclose synthetic media where required.** Most ad platforms now require AI-generated depictions of people to be labelled.
- **Don't depict real people saying things they did not say**, especially anything that could read as news, endorsement, or testimony.

Google applies its own safety filters on top of this. A refusal surfaces as
`NoVideoGeneratedError`.

## Security

Your API key is stored at `~/.ugc/.env` mode `0600`, sent as a header rather
than a URL parameter, and stripped from error messages before printing.

The only remote service contacted is Google's Gemini API: no telemetry, no
analytics, no intermediary. `ugc avatar sync` additionally talks to Paper's MCP
server on localhost and fetches the image URLs it returns, restricted to
`http` and `https`. Avatars live outside the repo so they can't be committed by
accident.

Details and reporting instructions are in [SECURITY.md](SECURITY.md).

## Development

```bash
npm run ugc -- gen "..." --dry-run   # runs straight from src/, no build
npm run build
npm run typecheck
npm test
```

Node runs the TypeScript in `src/` directly, but it refuses to strip types under
`node_modules`, so the published `bin` points at compiled `dist/`. `npm install`
builds it for you via the `prepare` hook.

Tests cover path confinement, avatar-name validation, the `allow_all` refusal,
and API-key redaction.

## License

MIT, see [LICENSE](LICENSE).
