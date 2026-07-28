#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import {
  loadConfig,
  parseAspectRatio,
  type AspectRatio,
  type Config,
  type Mode,
} from './config.ts';
import { generateClip, explainError } from './generate.ts';
import {
  addAvatar,
  getAvatar,
  loadAvatars,
  removeAvatar,
  type Avatar,
} from './avatars.ts';

// Load .env so the gateway key doesn't have to be exported in every shell.
// Real environment variables still win over the file.
const ENV_FILE = resolve(process.cwd(), '.env');
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const HELP = `
ugc — generate short, face-consistent UGC clips

USAGE
  ugc gen "<prompt>" [flags]      Generate one clip
  ugc batch <file> [flags]        Generate one clip per non-empty line of <file>
  ugc avatar add <name> <photo...> [flags]   Register a fixed avatar
  ugc avatar list                 Show registered avatars
  ugc avatar rm <name>            Remove an avatar and its copied photos
  ugc models                      List video models available on the gateway
  ugc help                        Show this

FLAGS
  --avatar <name>    Generate as a registered avatar
  --ref <path>       Reference face image (repeatable). Overrides config "refs"
  --mode <m>         i2v | r2v | t2v          (default: config, "i2v")
  --model <id>       Gateway model id          (default: config)
  --duration <n>     Clip length in seconds    (default: config, 8)
  --aspect <w:h>     Aspect ratio              (default: config, "9:16")
  --seed <n>         Fixed seed for reproducible output
  --notes <text>     Identity description, stored on the avatar (avatar add)
  --n <n>            Variations per prompt     (default: 1)
  --no-audio         Disable generated audio

EXAMPLES
  ugc avatar add sofia ~/photos/sofia-1.jpg ~/photos/sofia-2.jpg \\
      --notes "woman in her mid-20s, shoulder-length dark hair, freckles"
  ugc gen "holds up the serum bottle: 'three days. three.'" --avatar sofia
  ugc gen "unboxes the package on her bed" --avatar sofia --n 3
  ugc batch shots.txt --avatar sofia
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
  seed?: number;
  notes?: string;
  n: number;
  noAudio: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: argv[0] ?? 'help',
    positional: [],
    refs: [],
    n: 1,
    noAudio: false,
  };

  const needsValue = (flag: string, value: string | undefined): string => {
    if (value === undefined) throw new Error(`${flag} needs a value`);
    return value;
  };

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--ref':
        args.refs.push(needsValue('--ref', argv[++i]));
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
        args.duration = Number(needsValue('--duration', argv[++i]));
        break;
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
    ...(args.noAudio ? { generateAudio: false } : {}),
  };
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
      `${avatar ? ` · avatar: ${avatar.name}` : ''}` +
      `${config.mode !== 't2v' && config.refs.length ? ` · ref: ${config.refs.join(', ')}` : ''}`,
  );
  console.log(`Generating ${total} clip${total === 1 ? '' : 's'}...\n`);

  let done = 0;
  let failed = 0;

  for (const prompt of prompts) {
    for (let variation = 0; variation < args.n; variation++) {
      const index = ++done;
      const suffix = args.n > 1 ? ` (${variation + 1}/${args.n})` : '';
      const seed = baseSeed !== undefined ? baseSeed + variation : undefined;

      process.stdout.write(`[${index}/${total}] ${prompt.slice(0, 60)}${suffix} ... `);
      const started = Date.now();

      try {
        const { file, warnings } = await generateClip({
          prompt,
          config,
          seed,
          label: avatar ? `${avatar.name} ${prompt}` : prompt,
        });
        const secs = ((Date.now() - started) / 1000).toFixed(0);
        console.log(`done in ${secs}s → ${relative(process.cwd(), file)}`);
        for (const warning of warnings) console.log(`      ⚠ ${warning}`);
      } catch (err) {
        failed++;
        console.log('FAILED');
        console.error(`      ${explainError(err).split('\n').join('\n      ')}\n`);
      }
    }
  }

  console.log(
    `\n${total - failed}/${total} succeeded${failed ? ` · ${failed} failed` : ''}` +
      ` → ${config.outDir}/\n`,
  );

  if (failed) process.exitCode = 1;
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

async function listModels() {
  const res = await fetch('https://ai-gateway.vercel.sh/v1/models');
  if (!res.ok) throw new Error(`Gateway returned ${res.status}`);

  const { data } = (await res.json()) as { data: { id: string }[] };
  const pattern = /veo|kling|wan|seedance|ray|sora|grok-imagine-video|video/i;

  console.log('\nVideo models on the gateway:\n');
  for (const { id } of data.filter((m) => pattern.test(m.id))) {
    console.log(`  ${id}`);
  }
  console.log('\nUse one with --model, or set "model" in ugc.config.json\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case 'gen': {
      const prompt = args.positional.join(' ').trim();
      if (!prompt) throw new Error('gen needs a prompt: ugc gen "<prompt>"');
      await runPrompts([prompt], args);
      break;
    }

    case 'batch': {
      const file = args.positional[0];
      if (!file) throw new Error('batch needs a file: ugc batch shots.txt');

      const lines = (await readFile(resolve(process.cwd(), file), 'utf8'))
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

main().catch((err) => {
  console.error(`\n${explainError(err)}\n`);
  process.exitCode = 1;
});
