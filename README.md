# ugc

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

CLI for generating short, face-consistent UGC clips. Point it at a reference
photo, give it a line of dialogue or action, get an 8-second vertical video. Register a subject once, and every clip after it reuses the same photos, seed,
and identity description, which is what keeps the face from drifting between
takes.

```bash
ugc avatar add sofia ./sofia.png --notes "mid-20s, dark hair"
ugc gen "holds up the serum bottle: 'three days. three.'" --avatar sofia
```

Use an AI-generated face as your avatar rather than a real person's. See
[Responsible use](#responsible-use).

Video generation runs on Google Veo via the Gemini API. Avatars can be created
from local photos, or pulled straight from a [Paper](https://paper.design)
design file over Paper Desktop's MCP server. See
[Syncing from Paper](#syncing-from-paper-optional).

## Install

Needs Node 22.18 or newer, on macOS or Linux.

```bash
npm install -g https://github.com/syanhg/UGC/archive/refs/heads/main.tar.gz
ugc setup
```

Or from a clone, if you plan to change anything:

```bash
git clone https://github.com/syanhg/UGC.git && cd UGC
npm install && npm link
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
runs a batch roughly four times faster. 

Past 5 you trade waiting for rate-limit errors. 

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

Settings resolve in this order, each overriding the last:

```
defaults -> ~/.ugc/config.json -> ./ugc.config.json -> avatar -> CLI flags
```

`ugc where` prints where everything lives.

### Syncing from Paper (optional)

`ugc avatar sync` pulls avatars from [Paper](https://paper.design) instead of
managing photos by hand. It talks to **Paper Desktop's built-in MCP server** on
`http://127.0.0.1:29979/mcp` while a file is open, so there is nothing to
install or configure. Override the address with `PAPER_MCP_URL`.

```bash
ugc avatar sync --dry-run   # show what would be pulled, download nothing
ugc avatar sync
```

One top-level layer becomes one avatar, named after that layer, and every image
in its subtree becomes one of its reference photos. Re-syncing keeps the
original seed. Local-only avatars are never deleted.

## Keeping the face consistent

| Mode | How it works | Best for |
|---|---|---|
| `i2v` *(default)* | Your reference image becomes the literal first frame | Tightest identity lock |
| `r2v` | References passed as identity hints | More camera and pose variety, looser likeness |
| `t2v` | No reference at all | Broll, product shots, anything faceless |

Reusing the same reference photos matters more than any other setting, which is
what an avatar enforces. If clips drift in `r2v`, switch to `i2v`. A seed
reproduces a *run*; the reference photos are what hold a face steady.

## Responsible use

**Do not use a real person's face. Use an AI-generated character.**

Generate a face with ChatGPT, Midjourney, or similar and register that as your
avatar. This is the only intended way to use this tool. Animating a real
person's photo into them speaking to camera is how a deepfake is made, and no
amount of good intent changes what the output is or who it can hurt. A
synthetic face costs you nothing, carries no consent or likeness problem, and
is usually cleaner and better lit anyway.

Follow Google's
[Generative AI Prohibited Use Policy](https://policies.google.com/terms/generative-ai/use-policy)
and label synthetic media where your platform requires it.

## License

MIT, see [LICENSE](LICENSE).
