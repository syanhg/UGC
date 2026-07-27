# ugc

CLI for generating short, face-consistent UGC clips. Point it at a reference photo, give it a line of dialogue or action, get an 8-second vertical video.

## Setup

```bash
npm install
export AI_GATEWAY_API_KEY="..."   # https://vercel.com/dashboard → AI Gateway → API Keys
```

Drop a reference photo of your subject at `refs/face.jpg` (or point `refs` in `ugc.config.json` elsewhere).

No build step — Node 25 runs the TypeScript directly.

## Use

```bash
node src/cli.ts gen "holds up the bottle and grins: 'three days. three.'"
node src/cli.ts gen "unboxes the package on her bed" --seed 42 --n 3
node src/cli.ts batch shots.example.txt
node src/cli.ts models
```

Clips land in `out/` as timestamped `.mp4` files.

## Keeping the face consistent

Three modes, set via `mode` in the config or `--mode`:

| Mode | How it works | Best for |
|---|---|---|
| `i2v` *(default)* | Your reference image becomes the literal first frame | Tightest identity lock. The clip opens on exactly your photo. |
| `r2v` | References passed as identity hints; model composes the shot freely | More camera and pose variety, slightly looser likeness |
| `t2v` | No reference at all | Broll, product shots, anything faceless |

Practical tips:

- **Reuse one reference photo across every clip.** This matters more than any other setting.
- **A fixed `--seed` makes runs reproducible** — same seed plus same prompt returns the same video, so you can change one word and see just that change.
- **`i2v` locks hardest.** If clips drift in `r2v`, switch to `i2v`.
- **The `stylePrompt` in the config is appended to every prompt.** It carries the "selfie-style, handheld, looks into lens" framing plus an explicit instruction to match the reference face — edit it once and it applies everywhere.

## Models

Default is `google/veo-3.1-generate-001` — native 8-second clips with synced audio, which is why the default duration is 8.

```bash
node src/cli.ts models                          # list what's available
node src/cli.ts gen "..." --model alibaba/wan-v2.7-r2v --mode r2v
```

Worth knowing:

- `google/veo-3.1-fast-generate-001` — same family, faster and cheaper, good for iterating on prompts
- `alibaba/wan-v2.7-r2v` — purpose-built for subject consistency; no native audio
- `klingai/kling-v3.0-i2v` — strong motion realism

Every model runs through the Vercel AI Gateway, so switching is a string change, not a rewrite.

## Config

`ugc.config.json` holds the defaults; every field has a matching CLI flag that overrides it per-run.

```json
{
  "model": "google/veo-3.1-generate-001",
  "mode": "i2v",
  "refs": ["refs/face.jpg"],
  "duration": 8,
  "aspectRatio": "9:16",
  "resolution": "720x1280",
  "generateAudio": true,
  "outDir": "out",
  "stylePrompt": "Selfie-style UGC video, handheld phone camera..."
}
```

## Notes

- Generation takes minutes, not seconds. The timeout is 10 minutes per clip.
- Batch runs keep going if one clip fails; failures are reported at the end and the process exits non-zero.
- `refs/` and `out/` are gitignored — your source photos and renders stay local.
- Video models run safety filters. A refusal surfaces as `NoVideoGeneratedError`; usually a softer prompt or a different reference photo clears it.
