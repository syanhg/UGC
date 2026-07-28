#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import {
  loadConfig,
  parseAspectRatio,
  parseDuration,
  parseResolution,
  resolutionTier,
  DURATIONS,
  RESOLUTION_TIERS,
  type AspectRatio,
  type Config,
  type Mode,
  type Resolution,
  type ResolutionTier,
} from './config.ts';
import {
  closeUi,
  confirm,
  heading,
  note,
  askNumber,
  select,
  askText,
} from './ui.ts';
import { generateClip, buildPrompt, explainError } from './generate.ts';
import {
  addAvatar,
  getAvatar,
  loadAvatars,
  removeAvatar,
  type Avatar,
} from './avatars.ts';
import { downloadClip, listGeneratedClips } from './files.ts';
import { fromCwd, fromRoot } from './paths.ts';

// Load .env so the API key doesn't have to be exported in every shell.
// Real environment variables still win over the file.
const ENV_FILE = fromRoot('.env');
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const HELP = `
ugc — generate short, face-consistent UGC clips

USAGE
  ugc                             Interactive: pick avatar, prompt, and settings
  ugc gen "<prompt>" [flags]      Generate one clip
  ugc batch <file> [flags]        Generate one clip per non-empty line of <file>
  ugc avatar add <name> <photo...> [flags]   Register a fixed avatar
  ugc avatar list                 Show registered avatars
  ugc avatar rm <name>            Remove an avatar and its copied photos
  ugc pull                        Collect clips that rendered but failed to download
  ugc models                      List Veo models with rough per-second rates
  ugc help                        Show this

FLAGS
  --avatar <name>    Generate as a registered avatar
  --ref <path>       Reference face image (repeatable). Overrides config "refs"
  --mode <m>         i2v | r2v | t2v          (default: config, "i2v")
  --model <id>       Veo model id              (default: config)
  --duration <n>     Clip length: 4, 6, or 8   (default: config, 8)
  --aspect <w:h>     9:16 or 16:9              (default: config, "9:16")
  --resolution <r>   720p or 1080p             (default: config)
  --seed <n>         Fixed seed for reproducible output
  --notes <text>     Identity description, stored on the avatar (avatar add)
  --n <n>            Variations per prompt     (default: 1)
  --concurrency <n>  Clips to generate at once, alias -j  (default: 1)
  --no-audio         Disable generated audio
  --dry-run          Show the assembled prompt and settings; generate nothing

EXAMPLES
  ugc                                     # guided, with a cost estimate
  ugc avatar add sofia ~/photos/sofia-1.jpg --notes "mid-20s, dark hair"
  ugc gen "holds up the serum bottle: 'three days. three.'" --avatar sofia
  ugc gen "unboxes the package on her bed" --avatar sofia --n 4 -j 4
  ugc batch shots.txt --avatar sofia --resolution 1080p -j 3
`.trim();

interface Args {
  command: string;
  positional: string[];
  refs: string[];
  avatar?: string;
  mode?: Mode;
  model?: string;
  duration?: number;
  aspect?: AspectRatio;
  resolution?: Resolution;
  seed?: number;
  notes?: string;
  n: number;
  concurrency: number;
  noAudio: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    // Bare `ugc` opens the interactive session; that is the common case.
    command: argv[0] ?? 'new',
    positional: [],
    refs: [],
    n: 1,
    concurrency: 1,
    noAudio: false,
    dryRun: false,
  };

  const needsValue = (flag: string, value: string | undefined): string => {
    if (value === undefined) throw new Error(`${flag} needs a value`);
    return value;
  };

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--ref':
        // Absolute here, so it survives being resolved against the project
        // root later alongside avatar refs, which are project-relative.
        args.refs.push(fromCwd(needsValue('--ref', argv[++i])));
        break;
      case '--avatar':
        args.avatar = needsValue('--avatar', argv[++i]);
        break;
      case '--notes':
        args.notes = needsValue('--notes', argv[++i]);
        break;
      case '--mode': {
        const mode = needsValue('--mode', argv[++i]);
        if (mode !== 'i2v' && mode !== 'r2v' && mode !== 't2v') {
          throw new Error(`--mode must be i2v, r2v, or t2v (got "${mode}")`);
        }
        args.mode = mode;
        break;
      }
      case '--model':
        args.model = needsValue('--model', argv[++i]);
        break;
      case '--duration':
        args.duration = parseDuration(
          Number(needsValue('--duration', argv[++i])),
        );
        break;
      case '--resolution': {
        const value = needsValue('--resolution', argv[++i]);
        // Accept the tier names people actually say, as well as WxH.
        args.resolution =
          value in RESOLUTION_TIERS
            ? RESOLUTION_TIERS[value as ResolutionTier]
            : parseResolution(value);
        break;
      }
      case '--aspect':
        args.aspect = parseAspectRatio(needsValue('--aspect', argv[++i]));
        break;
      case '--seed':
        args.seed = Number(needsValue('--seed', argv[++i]));
        break;
      case '--n':
        args.n = Number(needsValue('--n', argv[++i]));
        break;
      case '--no-audio':
        args.noAudio = true;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--concurrency':
      case '-j':
        args.concurrency = Number(needsValue('--concurrency', argv[++i]));
        break;
      default:
        if (arg.startsWith('--')) throw new Error(`Unknown flag: ${arg}`);
        args.positional.push(arg);
    }
  }

  return args;
}

/**
 * Folds a registered avatar into the config. Sits between the config file and
 * the CLI flags: an avatar overrides the defaults, an explicit flag overrides
 * the avatar. Notes append to the global style prompt rather than replacing it,
 * so the shared "selfie-style, looks into lens" framing survives.
 */
function applyAvatar(config: Config, avatar: Avatar): Config {
  return {
    ...config,
    refs: avatar.refs,
    ...(avatar.mode ? { mode: avatar.mode } : {}),
    ...(avatar.model ? { model: avatar.model } : {}),
    ...(avatar.notes
      ? { stylePrompt: `${config.stylePrompt} ${avatar.notes}`.trim() }
      : {}),
  };
}

function applyOverrides(config: Config, args: Args): Config {
  return {
    ...config,
    ...(args.refs.length ? { refs: args.refs } : {}),
    ...(args.mode ? { mode: args.mode } : {}),
    ...(args.model ? { model: args.model } : {}),
    ...(args.duration ? { duration: args.duration } : {}),
    ...(args.aspect ? { aspectRatio: args.aspect } : {}),
    ...(args.resolution ? { resolution: args.resolution } : {}),
    ...(args.noAudio ? { generateAudio: false } : {}),
  };
}

/**
 * Runs jobs with a fixed number in flight. Generation is minutes of waiting on
 * a remote queue, so serialising a batch wastes almost all of the wall time —
 * but an unbounded fan-out just trades that for rate-limit errors.
 */
async function pool<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;

  const runners = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (next < items.length) {
        const index = next++;
        await worker(items[index], index);
      }
    },
  );

  await Promise.all(runners);
}

async function runPrompts(prompts: string[], args: Args) {
  const avatar = args.avatar ? await getAvatar(args.avatar) : undefined;

  let config = await loadConfig();
  if (avatar) config = applyAvatar(config, avatar);
  config = applyOverrides(config, args);

  // An avatar's locked seed keeps repeat runs of the same prompt identical;
  // an explicit --seed still wins for one-off experiments.
  const baseSeed = args.seed ?? avatar?.seed;

  const total = prompts.length * args.n;
  console.log(
    `\n${config.model} · ${config.mode} · ${config.duration}s · ${config.aspectRatio}` +
      ` · ${resolutionTier(config.resolution)}` +
      `${avatar ? ` · avatar: ${avatar.name}` : ''}` +
      `${config.mode !== 't2v' && config.refs.length ? ` · ref: ${config.refs.join(', ')}` : ''}`,
  );

  if (args.dryRun) {
    for (const [index, prompt] of prompts.entries()) {
      console.log(
        `\n─── prompt ${index + 1}/${prompts.length}` +
          `${args.n > 1 ? ` · ${args.n} variations, seeds ${baseSeed ?? '?'}…` : ''} ` +
          '─'.repeat(30),
      );
      console.log(`\nPROMPT SENT TO VEO:\n\n${buildPrompt(prompt, config)}\n`);
      console.log(
        `FIRST FRAME: ${
          config.mode === 'i2v'
            ? config.refs[0]
            : config.mode === 'r2v'
              ? `(composed by the model; ${config.refs.length} identity reference${config.refs.length === 1 ? '' : 's'})`
              : '(none — text only)'
        }`,
      );
      console.log(
        `SEED: ${baseSeed ?? '(random each run)'}` +
          `   AUDIO: ${config.generateAudio ? 'on' : 'off'}` +
          `   PEOPLE: ${config.personGeneration}`,
      );
    }
    console.log(`\nDry run — nothing sent, nothing charged.\n`);
    return;
  }
  // Flatten prompt x variation into one job list so the pool can interleave
  // them; a variation is just the same prompt at a different seed offset.
  const jobs = prompts.flatMap((prompt) =>
    Array.from({ length: args.n }, (_, variation) => ({
      prompt,
      variation,
      seed: baseSeed !== undefined ? baseSeed + variation : undefined,
    })),
  );

  const concurrency = Math.min(args.concurrency, jobs.length);
  console.log(
    `Generating ${total} clip${total === 1 ? '' : 's'}` +
      `${concurrency > 1 ? `, ${concurrency} at a time` : ''}...\n`,
  );

  let failed = 0;

  await pool(jobs, concurrency, async (job, index) => {
    const tag = `[${index + 1}/${total}]`;
    const suffix = args.n > 1 ? ` (v${job.variation + 1})` : '';

    // Concurrent jobs finish out of order, so each line has to name its own
    // job rather than relying on position.
    console.log(`${tag} start${suffix} · ${job.prompt.slice(0, 56)}`);
    const started = Date.now();

    try {
      const { file, warnings } = await generateClip({
        prompt: job.prompt,
        config,
        seed: job.seed,
        label: avatar ? `${avatar.name} ${job.prompt}` : job.prompt,
      });
      const secs = ((Date.now() - started) / 1000).toFixed(0);
      console.log(`${tag} done in ${secs}s → ${relative(process.cwd(), file)}`);
      for (const warning of warnings) console.log(`${tag}   ⚠ ${warning}`);
    } catch (err) {
      failed++;
      console.error(
        `${tag} FAILED\n      ${explainError(err).split('\n').join('\n      ')}\n`,
      );
    }
  });

  console.log(
    `\n${total - failed}/${total} succeeded${failed ? ` · ${failed} failed` : ''}` +
      ` → ${config.outDir}/\n`,
  );

  if (failed) process.exitCode = 1;
}

/** Rough list rates per output second at 720p, used only for the estimate. */
const RATE_PER_SECOND: Record<string, number> = {
  'veo-3.1-fast-generate-preview': 0.1,
  'veo-3.1-generate-preview': 0.4,
};

function estimateCost(model: string, duration: number, clips: number): string {
  const rate = RATE_PER_SECOND[model];
  return rate === undefined
    ? 'unknown — check Google pricing for this model'
    : `~$${(rate * duration * clips).toFixed(2)}`;
}

/**
 * Walks through one generation interactively. Everything it collects maps onto
 * the same flags `gen` takes, so anything set here can be scripted later.
 */
async function runInteractive() {
  const config = await loadConfig();
  const registry = await loadAvatars();
  const avatars = Object.values(registry);

  console.log('\n\x1b[1mugc\x1b[0m — face-consistent UGC clips');

  const avatarName = await select<string | undefined>(
    'Avatar',
    [
      ...avatars.map((a) => ({
        value: a.name as string | undefined,
        label: a.name,
        hint: `${a.refs.length} ref${a.refs.length === 1 ? '' : 's'} · seed ${a.seed}`,
      })),
      {
        value: undefined,
        label: 'none',
        hint: 'text-only, no face reference',
      },
    ],
    0,
  );

  if (!avatars.length && avatarName) {
    throw new Error('No avatars registered — run: ugc avatar add <name> <photo>');
  }

  const prompt = await askText('What happens in the clip?');

  const model = await select(
    'Model',
    Object.entries(RATE_PER_SECOND).map(([id, rate]) => ({
      value: id,
      label: id,
      hint: `~$${rate.toFixed(2)}/s`,
    })),
    0,
  );

  const aspectRatio = await select(
    'Aspect ratio',
    [
      { value: '9:16' as const, label: '9:16', hint: 'vertical — TikTok, Reels, Shorts' },
      { value: '16:9' as const, label: '16:9', hint: 'landscape — YouTube' },
    ],
    config.aspectRatio === '16:9' ? 1 : 0,
  );

  const duration = await select(
    'Duration',
    DURATIONS.map((seconds) => ({
      value: seconds,
      label: `${seconds}s`,
      hint: `${estimateCost(model, seconds, 1)} per clip`,
    })),
    DURATIONS.indexOf(config.duration as (typeof DURATIONS)[number]) >= 0
      ? DURATIONS.indexOf(config.duration as (typeof DURATIONS)[number])
      : 2,
  );

  const resolution = await select(
    'Resolution',
    (Object.keys(RESOLUTION_TIERS) as ResolutionTier[]).map((tier) => ({
      value: RESOLUTION_TIERS[tier],
      label: tier,
      hint: tier === '1080p' ? 'sharper, costs more on some models' : 'standard',
    })),
    0,
  );

  const clips = await askNumber('How many clips?', { min: 1, max: 20, fallback: 1 });

  const concurrency =
    clips === 1
      ? 1
      : await askNumber('How many at a time?', {
          min: 1,
          max: Math.min(clips, 5),
          fallback: Math.min(clips, 3),
        });

  heading('Ready');
  console.log(
    `  ${clips} clip${clips === 1 ? '' : 's'} · ${model} · ${duration}s · ` +
      `${aspectRatio} · ${resolutionTier(resolution)}` +
      `${avatarName ? ` · avatar ${avatarName}` : ' · no avatar'}`,
  );
  console.log(`  Estimated cost: \x1b[1m${estimateCost(model, duration, clips)}\x1b[0m`);
  note('  You are only charged for clips that generate successfully.');

  if (!(await confirm('Generate?'))) {
    console.log('\nCancelled — nothing sent.\n');
    return;
  }

  closeUi();

  await runPrompts([prompt], {
    command: 'gen',
    positional: [],
    refs: [],
    avatar: avatarName,
    model,
    aspect: aspectRatio,
    duration,
    n: clips,
    concurrency,
    noAudio: false,
    dryRun: false,
    ...(avatarName ? {} : { mode: 't2v' as const }),
    resolution,
  });
}

/**
 * Collects clips that rendered but never made it to disk. Google keeps them for
 * 48 hours, so a download that failed after billing is recoverable rather than
 * lost.
 */
async function runPull(args: Args) {
  const config = applyOverrides(await loadConfig(), args);
  const clips = await listGeneratedClips();

  if (!clips.length) {
    console.log('\nNo clips waiting on the Files API.\n');
    return;
  }

  console.log(`\n${clips.length} clip${clips.length === 1 ? '' : 's'} on the Files API:\n`);

  let pulled = 0;
  for (const clip of clips) {
    const expires = new Date(clip.expirationTime).toLocaleString();
    try {
      const { path, skipped } = await downloadClip(clip, config.outDir);
      const label = relative(process.cwd(), path);
      if (skipped) {
        console.log(`  · ${label} (already local)`);
      } else {
        pulled++;
        console.log(`  ✓ ${label}  · expires ${expires}`);
      }
    } catch (err) {
      console.log(`  ✗ ${clip.name} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\n${pulled} new clip${pulled === 1 ? '' : 's'} → ${config.outDir}/\n`);
}

async function runAvatarCommand(args: Args) {
  const [action, ...rest] = args.positional;

  switch (action) {
    case 'add': {
      const [name, ...sources] = rest;
      if (!name) {
        throw new Error('ugc avatar add <name> <photo.jpg> [more.jpg ...]');
      }

      const avatar = await addAvatar({
        name,
        sources,
        seed: args.seed,
        mode: args.mode,
        model: args.model,
        notes: args.notes,
      });

      console.log(
        `\n✓ avatar "${avatar.name}" — ${avatar.refs.length} ref` +
          `${avatar.refs.length === 1 ? '' : 's'}, seed ${avatar.seed} (locked)`,
      );
      for (const ref of avatar.refs) console.log(`    ${ref}`);
      if (avatar.notes) console.log(`    notes: ${avatar.notes}`);
      console.log(`\nGenerate with it:\n  ugc gen "<prompt>" --avatar ${avatar.name}\n`);
      break;
    }

    case 'list': {
      const registry = await loadAvatars();
      const avatars = Object.values(registry);

      if (!avatars.length) {
        console.log(
          '\nNo avatars yet.\n  ugc avatar add <name> <photo.jpg>\n',
        );
        break;
      }

      console.log('');
      for (const avatar of avatars) {
        const width = Math.max(...avatars.map((a) => a.name.length));
        console.log(
          `  ${avatar.name.padEnd(width)}  ${avatar.refs.length} ref` +
            `${avatar.refs.length === 1 ? ' ' : 's'}  ${avatar.mode ?? 'i2v'}  seed ${avatar.seed}` +
            `${avatar.model ? `  ${avatar.model}` : ''}`,
        );
        if (avatar.notes) console.log(`  ${' '.repeat(width)}  ${avatar.notes}`);
      }
      console.log('');
      break;
    }

    case 'rm':
    case 'remove': {
      const name = rest[0];
      if (!name) throw new Error('ugc avatar rm <name>');

      const avatar = await removeAvatar(name);
      console.log(`\n✓ removed avatar "${avatar.name}" and its copied photos\n`);
      break;
    }

    default:
      throw new Error(
        `Unknown avatar command "${action ?? ''}". Use add, list, or rm.`,
      );
  }
}

// Approximate list rates per output second at 720p, for sizing a run before you
// make it. Google's pricing page is the authority, and which ids a key can
// actually reach varies — hence the live listing below rather than this table.
const MODEL_NOTES: Record<string, string> = {
  'veo-3.1-generate-preview': 'best quality, native audio · ~$0.40/s',
  'veo-3.1-fast-generate-preview': 'faster and cheaper · ~$0.10/s',
};

/**
 * Asks the API which video models this key can actually reach. Listing is free,
 * and the ids drift between preview and GA often enough that a hardcoded table
 * goes stale and costs you a failed generation to discover.
 */
async function listModels() {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'GOOGLE_GENERATIVE_AI_API_KEY is not set — needed to list models.\n' +
        'Get one at https://aistudio.google.com/apikey',
    );
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
  );
  if (!res.ok) {
    throw new Error(`Model listing failed: ${res.status} ${res.statusText}`);
  }

  const { models } = (await res.json()) as { models: { name: string }[] };
  const ids = models
    .map((m) => m.name.replace(/^models\//, ''))
    .filter((id) => /veo/i.test(id))
    .sort();

  if (!ids.length) {
    console.log(
      '\nNo Veo models available to this key.\n' +
        'Veo needs billing enabled on the key\'s Google Cloud project.\n',
    );
    return;
  }

  const width = Math.max(...ids.map((id) => id.length));
  console.log('\nVeo models available to your key:\n');
  for (const id of ids) {
    console.log(`  ${id.padEnd(width)}  ${MODEL_NOTES[id] ?? ''}`.trimEnd());
  }
  console.log(
    '\nAn 8s clip costs roughly 8x the per-second rate.' +
      '\nUse one with --model, or set "model" in ugc.config.json\n',
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case 'new':
      await runInteractive();
      break;

    case 'gen': {
      const prompt = args.positional.join(' ').trim();
      if (!prompt) throw new Error('gen needs a prompt: ugc gen "<prompt>"');
      await runPrompts([prompt], args);
      break;
    }

    case 'batch': {
      const file = args.positional[0];
      if (!file) throw new Error('batch needs a file: ugc batch shots.txt');

      const lines = (await readFile(fromCwd(file), 'utf8'))
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'));

      if (!lines.length) throw new Error(`No prompts found in ${file}`);
      await runPrompts(lines, args);
      break;
    }

    case 'avatar':
    case 'avatars':
      await runAvatarCommand(args);
      break;

    case 'pull':
      await runPull(args);
      break;

    case 'models':
      await listModels();
      break;

    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      break;

    default:
      console.error(`Unknown command: ${args.command}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(`\n${explainError(err)}\n`);
    process.exitCode = 1;
  })
  // An open readline handle keeps the event loop alive, so the process would
  // hang after an interactive run instead of exiting.
  .finally(closeUi);
