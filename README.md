# ugc

CLI for generating short, face-consistent UGC clips. Point it at a reference photo, give it a line of dialogue or action, get an 8-second vertical video.

## Setup

```bash
npm install
export GOOGLE_GENERATIVE_AI_API_KEY="..."   # https://aistudio.google.com/apikey
```

Veo runs on the Gemini API and is **not on the free tier** — the Google Cloud
project behind your key needs billing enabled. Rough cost for one 8-second clip:

| Model | Per second (720p) | 8s clip |
|---|---|---|
| `veo-3.1-fast-generate-preview` | ~$0.10 | ~$0.80 |
| `veo-3.1-generate-preview` | ~$0.40 | ~$3.20 |

Iterate on prompts with `fast`, then re-run the keeper on the full model — the
avatar's locked seed means you get the same clip, just rendered better.

Run `ugc models` to see what your key can actually reach; the ids drift between
preview and GA, and listing is free.

No build step — Node 25 runs the TypeScript directly.

## Use

Register your subject once, then generate against that name forever:

```bash
node src/cli.ts avatar add sofia ~/photos/sofia-1.jpg ~/photos/sofia-2.jpg \
    --notes "woman in her mid-20s, shoulder-length dark hair, freckles"

node src/cli.ts gen "holds up the bottle and grins: 'three days. three.'" --avatar sofia
node src/cli.ts gen "unboxes the package on her bed" --avatar sofia --n 3
node src/cli.ts batch shots.example.txt --avatar sofia
node src/cli.ts models
```

Clips land in `out/` as timestamped `.mp4` files, prefixed with the avatar name.

## Avatars

An avatar is a subject you register once. Everything that affects likeness gets
captured at `add` time and replayed on every clip after it.

```bash
ugc avatar add <name> <photo...>   # register; photos are copied into refs/<name>/
ugc avatar list                    # what's registered
ugc avatar rm <name>               # drop the avatar and its copies
```

What an avatar stores:

| Field | Set with | Why it matters |
|---|---|---|
| refs | positional photos | The reference images. This does most of the consistency work. |
| seed | `--seed`, else random | Locked at registration, so the same prompt reproduces the same clip. |
| notes | `--notes` | An identity description appended to the style prompt — it reinforces likeness in words, which helps most in `r2v`. |
| mode / model | `--mode`, `--model` | Pin a per-avatar mode or model when one suits that subject better. |

Photos are **copied** into `refs/<name>/`, not referenced in place — moving or
deleting the original later can't silently change your avatar. The registry
itself lives in `avatars.json` (gitignored, like `refs/`).

Settings resolve in this order, each overriding the last:

```
built-in defaults → ugc.config.json → avatar → CLI flags
```

So `--seed 99` still wins over the avatar's locked seed for a one-off
experiment, and `--mode r2v` overrides an avatar pinned to `i2v`.

## Keeping the face consistent

Three modes, set via `mode` in the config or `--mode`:

| Mode | How it works | Best for |
|---|---|---|
| `i2v` *(default)* | Your reference image becomes the literal first frame | Tightest identity lock. The clip opens on exactly your photo. |
| `r2v` | References passed as identity hints; model composes the shot freely | More camera and pose variety, slightly looser likeness |
| `t2v` | No reference at all | Broll, product shots, anything faceless |

Practical tips:

- **Reuse the same reference photos across every clip.** This matters more than any other setting — which is exactly what registering an avatar enforces.
- **A fixed seed makes runs reproducible** — same seed plus same prompt returns the same video, so you can change one word and see just that change. An avatar carries a locked seed for this reason. Note that a seed reproduces a *run*; it does not by itself hold a face steady across different prompts. The reference photos do that.
- **`i2v` locks hardest.** If clips drift in `r2v`, switch to `i2v`.
- **The `stylePrompt` in the config is appended to every prompt.** It carries the "selfie-style, handheld, looks into lens" framing plus an explicit instruction to match the reference face — edit it once and it applies everywhere.

## Models

Default is `veo-3.1-generate-preview` — native 8-second clips with synced audio,
which is why the default duration is 8.

```bash
node src/cli.ts models                          # what your key can reach, with rates
node src/cli.ts gen "..." --model veo-3.1-fast-generate-preview
```

Requests go straight to the Gemini API via `@ai-sdk/google`, so the model id is
Google's own — `veo-3.1-generate-preview`, not a prefixed routing string.

`personGeneration` in the config is worth knowing about: Veo refuses to render
recognisable people unless it is widened from its default. It ships as
`allow_adult`, which is what an adult UGC avatar needs. The wider `allow_all`
also permits minors and this tool has no reason to use it.

## Config

`ugc.config.json` holds the defaults shared by every avatar — the model, the framing, the output shape. Anything an avatar or a CLI flag sets overrides it.

```json
{
  "model": "veo-3.1-generate",
  "mode": "i2v",
  "refs": [],
  "duration": 8,
  "aspectRatio": "9:16",
  "resolution": "720x1280",
  "generateAudio": true,
  "personGeneration": "allow_adult",
  "outDir": "out",
  "stylePrompt": "Selfie-style UGC video, handheld phone camera..."
}
```

`refs` here is only a fallback for running without `--avatar`. Registered
avatars carry their own.

## Notes

- Generation takes minutes, not seconds. The timeout is 10 minutes per clip.
- Batch runs keep going if one clip fails; failures are reported at the end and the process exits non-zero.
- `refs/`, `out/`, and `avatars.json` are gitignored — your avatars, source photos, and renders stay local.
- Veo runs safety filters. A refusal surfaces as `NoVideoGeneratedError`; usually a softer prompt or a different reference photo clears it. Generating a real person's face from a photo is exactly what those filters watch for, so expect the occasional refusal on likeness grounds.
- Publishing clips of an identifiable person delivering ad copy is a consent question, not a technical one. Get it in writing before anything ships.
