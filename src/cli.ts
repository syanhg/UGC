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

// Load .env so the gateway key doesn't have to be exported in every shell.
// Real environment variables still win over the file.
const ENV_FILE = resolve(process.cwd(), '.env');
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const HELP = `
ugc — generate short, face-consistent UGC clips

USAGE
  ugc gen "<prompt>" [flags]      Generate one clip
  ugc batch <file> [flags]        Generate one clip per non-empty line of <file>
  ugc models                      List video models available on the gateway
  ugc help                        Show this

FLAGS
  --ref <path>       Reference face image (repeatable). Overrides config "refs"
  --mode <m>         i2v | r2v | t2v          (default: config, "i2v")
  --model <id>       Gateway model id          (default: config)
  --duration <n>     Clip length in seconds    (default: config, 8)
  --aspect <w:h>     Aspect ratio              (default: config, "9:16")
  --seed <n>         Fixed seed for reproducible output
  --n <n>            Variations per prompt     (default: 1)
  --no-audio         Disable generated audio

EXAMPLES
  ugc gen "holds up the serum bottle and grins: 'three days. three.'"
  ugc gen "unboxes the package on her bed" --seed 42 --n 3
  ugc batch shots.txt --mode r2v
`.trim();

interface Args {
  command: string;
  positional: string[];
  refs: string[];
  mode?: Mode;
  model?: string;
  duration?: number;
  aspect?: AspectRatio;
  seed?: number;
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
  const config = applyOverrides(await loadConfig(), args);

  const total = prompts.length * args.n;
  console.log(
    `\n${config.model} · ${config.mode} · ${config.duration}s · ${config.aspectRatio}` +
      `${config.mode !== 't2v' && config.refs.length ? ` · ref: ${config.refs.join(', ')}` : ''}`,
  );
  console.log(`Generating ${total} clip${total === 1 ? '' : 's'}...\n`);

  let done = 0;
  let failed = 0;

  for (const prompt of prompts) {
    for (let variation = 0; variation < args.n; variation++) {
      const index = ++done;
      const suffix = args.n > 1 ? ` (${variation + 1}/${args.n})` : '';
      const seed =
        args.seed !== undefined ? args.seed + variation : undefined;

      process.stdout.write(`[${index}/${total}] ${prompt.slice(0, 60)}${suffix} ... `);
      const started = Date.now();

      try {
        const { file, warnings } = await generateClip({
          prompt,
          config,
          seed,
          label: prompt,
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
