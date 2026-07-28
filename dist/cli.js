#!/usr/bin/env node
import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import { configSources, loadConfig, parseAspectRatio, parseDuration, parseResolution, resolutionTier, DURATIONS, GLOBAL_CONFIG_PATH, RESOLUTION_TIERS, } from "./config.js";
import { closeUi, confirm, heading, note, askNumber, select, askText, } from "./ui.js";
import { generateClip, buildPrompt, checkPromptLength, explainError, } from "./generate.js";
import { addAvatar, assertValidName, getAvatar, loadAvatars, removeAvatar, photoLabel, slugifyName, AVATARS_PATH, } from "./avatars.js";
import { downloadPhoto, readAvatars } from "./paper.js";
import { authHeaders, downloadClip, listGeneratedClips } from "./files.js";
import { DATA_DIR, ensureDataDir, fromCwd, fromData } from "./paths.js";
import { Progress, estimateRenderMs } from "./progress.js";
/**
 * Loads .env so the API key doesn't have to be exported in every shell. A
 * project-local file wins over the global one, and both lose to a real
 * environment variable — process.loadEnvFile does not overwrite what is set,
 * so the first file to define a name is the one that takes effect.
 *
 * Called from main() rather than at import time: a first run may migrate an
 * older layout's .env into the data directory, and that has to happen before
 * this reads it, or the key looks missing until the next invocation.
 */
function loadEnvFiles() {
    for (const file of [fromCwd('.env'), fromData('.env')]) {
        if (existsSync(file))
            process.loadEnvFile(file);
    }
}
const HELP = `
ugc — generate short, face-consistent UGC clips

USAGE
  ugc                             Interactive: pick avatar, prompt, and settings
  ugc setup                       Store your Gemini API key and check it works
  ugc gen "<prompt>" [flags]      Generate one clip
  ugc batch <file> [flags]        Generate one clip per non-empty line of <file>
  ugc avatar add <name> <photo...> [flags]   Register a fixed avatar
  ugc avatar list                 Show registered avatars
  ugc avatar sync [--dry-run]     Pull avatars from the open Paper file
  ugc avatar rm <name>            Remove an avatar and its copied photos
  ugc pull                        Collect clips that rendered but failed to download
  ugc models                      List Veo models with rough per-second rates
  ugc where                       Show where avatars, config, and the key live
  ugc help                        Show this

FLAGS
  --avatar <name>    Generate as a registered avatar
  --ref <path>       Reference face image (repeatable). Overrides config "refs"
  --mode <m>         i2v | r2v | t2v          (default: config, "i2v")
  --model <id>       Veo model id              (default: config)
  --duration <n>     Clip length: 4, 6, or 8   (default: config, 8)
  --aspect <w:h>     9:16 or 16:9              (default: config, "9:16")
  --resolution <r>   720p or 1080p             (default: config)
  --photo <n>        Which of the avatar's photos to use (1-based)
  --seed <n>         Fixed seed for reproducible output
  --notes <text>     Identity description, stored on the avatar (avatar add)
  --n <n>            Variations per prompt     (default: 1)
  --concurrency <n>  Clips to generate at once, alias -j  (default: 1)
  --no-audio         Disable generated audio
  --dry-run          Show the assembled prompt and settings; generate nothing

EXAMPLES
  ugc setup                               # first run: paste your API key
  ugc                                     # guided, with a cost estimate
  ugc avatar add sofia ~/photos/sofia-1.jpg --notes "mid-20s, dark hair"
  ugc gen "holds up the serum bottle: 'three days. three.'" --avatar sofia
  ugc gen "unboxes the package on her bed" --avatar sofia --n 4 -j 4
  ugc batch shots.txt --avatar sofia --resolution 1080p -j 3

Avatars, config, and your key live in ~/.ugc (override with UGC_HOME).
Clips are written to ./out relative to where you run the command.
`.trim();
function parseArgs(argv) {
    const args = {
        // Bare `ugc` opens the interactive session; that is the common case.
        command: argv[0] ?? 'new',
        positional: [],
        refs: [],
        n: 1,
        concurrency: 1,
        noAudio: false,
        dryRun: false,
        force: false,
    };
    const needsValue = (flag, value) => {
        if (value === undefined)
            throw new Error(`${flag} needs a value`);
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
                args.duration = parseDuration(Number(needsValue('--duration', argv[++i])));
                break;
            case '--resolution': {
                const value = needsValue('--resolution', argv[++i]);
                // Accept the tier names people actually say, as well as WxH.
                args.resolution =
                    value in RESOLUTION_TIERS
                        ? RESOLUTION_TIERS[value]
                        : parseResolution(value);
                break;
            }
            case '--aspect':
                args.aspect = parseAspectRatio(needsValue('--aspect', argv[++i]));
                break;
            case '--seed':
                args.seed = Number(needsValue('--seed', argv[++i]));
                break;
            case '--photo':
                args.photo = Number(needsValue('--photo', argv[++i]));
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
            case '--force':
                args.force = true;
                break;
            default:
                if (arg.startsWith('--'))
                    throw new Error(`Unknown flag: ${arg}`);
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
function applyAvatar(config, avatar) {
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
function applyOverrides(config, args) {
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
async function pool(items, limit, worker) {
    let next = 0;
    const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
        while (next < items.length) {
            const index = next++;
            await worker(items[index], index);
        }
    });
    await Promise.all(runners);
}
async function runPrompts(prompts, args) {
    const avatar = args.avatar ? await getAvatar(args.avatar) : undefined;
    let config = await loadConfig();
    if (avatar)
        config = applyAvatar(config, avatar);
    config = applyOverrides(config, args);
    // Picking a photo narrows the avatar to that one reference. In i2v only the
    // first reference is used as the opening frame anyway, so without this the
    // choice of which photo to open on would be silently made for you.
    if (args.photo !== undefined) {
        const chosen = config.refs[args.photo - 1];
        if (!chosen) {
            throw new Error(`--photo ${args.photo} is out of range: ` +
                `${args.avatar ?? 'this avatar'} has ${config.refs.length} photo` +
                `${config.refs.length === 1 ? '' : 's'}`);
        }
        config = { ...config, refs: [chosen] };
    }
    // An avatar's locked seed keeps repeat runs of the same prompt identical;
    // an explicit --seed still wins for one-off experiments.
    const baseSeed = args.seed ?? avatar?.seed;
    const total = prompts.length * args.n;
    console.log(`\n${config.model} · ${config.mode} · ${config.duration}s · ${config.aspectRatio}` +
        ` · ${resolutionTier(config.resolution)}` +
        `${avatar ? ` · avatar: ${avatar.name}` : ''}` +
        `${config.mode !== 't2v' && config.refs.length ? ` · ref: ${config.refs.join(', ')}` : ''}`);
    if (args.dryRun) {
        for (const [index, prompt] of prompts.entries()) {
            console.log(`\n─── prompt ${index + 1}/${prompts.length}` +
                `${args.n > 1 ? ` · ${args.n} variations, seeds ${baseSeed ?? '?'}…` : ''} ` +
                '─'.repeat(30));
            const full = buildPrompt(prompt, config);
            console.log(`\nPROMPT SENT TO VEO:\n\n${full}\n`);
            console.log(`LENGTH: ${full.length} chars`);
            const tooLong = checkPromptLength(full);
            if (tooLong)
                console.log(`  ⚠ ${tooLong}`);
            console.log(`FIRST FRAME: ${config.mode === 'i2v'
                ? config.refs[0]
                : config.mode === 'r2v'
                    ? `(composed by the model; ${config.refs.length} identity reference${config.refs.length === 1 ? '' : 's'})`
                    : '(none — text only)'}`);
            console.log(`SEED: ${baseSeed ?? '(random each run)'}` +
                `   AUDIO: ${config.generateAudio ? 'on' : 'off'}` +
                `   PEOPLE: ${config.personGeneration}`);
        }
        console.log(`\nDry run — nothing sent, nothing charged.\n`);
        return;
    }
    // Flatten prompt x variation into one job list so the pool can interleave
    // them; a variation is just the same prompt at a different seed offset.
    const jobs = prompts.flatMap((prompt) => Array.from({ length: args.n }, (_, variation) => ({
        prompt,
        variation,
        seed: baseSeed !== undefined ? baseSeed + variation : undefined,
    })));
    const concurrency = Math.min(args.concurrency, jobs.length);
    console.log(`Generating ${total} clip${total === 1 ? '' : 's'}` +
        `${concurrency > 1 ? `, ${concurrency} at a time` : ''}...\n`);
    let failed = 0;
    let stranded = 0;
    const problems = [];
    const progress = new Progress(jobs.map((job) => `${job.prompt.slice(0, 44)}${args.n > 1 ? ` (v${job.variation + 1})` : ''}`), estimateRenderMs(config.model, config.duration));
    progress.start();
    await pool(jobs, concurrency, async (job, index) => {
        progress.began(index);
        try {
            const { file, warnings } = await generateClip({
                prompt: job.prompt,
                config,
                seed: job.seed,
                label: avatar ? `${avatar.name} ${job.prompt}` : job.prompt,
            });
            progress.finished(index, relative(process.cwd(), file));
            for (const warning of warnings) {
                problems.push(`[${index + 1}/${total}] ⚠ ${warning}`);
            }
        }
        catch (err) {
            failed++;
            const message = err instanceof Error ? err.message : String(err);
            if (/could not be downloaded/i.test(message))
                stranded++;
            progress.failed(index, message.split('\n')[0].slice(0, 60));
            // Held back until the bars stop, so a multi-line error cannot be
            // overwritten by the next redraw.
            problems.push(`[${index + 1}/${total}] FAILED\n      ${explainError(err).split('\n').join('\n      ')}`);
        }
    });
    progress.stop();
    if (problems.length)
        console.error(`\n${problems.join('\n')}\n`);
    // A clip that rendered but failed to download is finished work already paid
    // for. Collecting it should not depend on the user knowing to run `pull`.
    if (stranded) {
        console.log(`${stranded} clip${stranded === 1 ? '' : 's'} rendered but did not download — recovering...\n`);
        try {
            const recovered = await pullClips(config.outDir);
            failed -= Math.min(recovered, stranded);
        }
        catch (err) {
            console.error(`  recovery failed: ${explainError(err)}\n  Try again later with: ugc pull\n`);
        }
    }
    console.log(`\n${total - failed}/${total} succeeded${failed ? ` · ${failed} failed` : ''}` +
        ` → ${config.outDir}/\n`);
    if (failed)
        process.exitCode = 1;
}
/** Rough list rates per output second at 720p, used only for the estimate. */
const RATE_PER_SECOND = {
    'veo-3.1-fast-generate-preview': 0.1,
    'veo-3.1-generate-preview': 0.4,
};
function estimateCost(model, duration, clips) {
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
    if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
        throw new Error('No Gemini API key found. Set one up first:\n  ugc setup');
    }
    // A first run has nothing registered, and the guided session is exactly where
    // someone lands before reading about avatars. Say what is missing rather than
    // offering a picker with one useless entry in it.
    if (!avatars.length) {
        note('\n  No avatars registered yet — this clip will be text-only.\n' +
            '  For a consistent face, register one:  ugc avatar add <name> <photo.jpg>');
    }
    // Synced avatars sort first: when a design file is the source of truth, the
    // layer you just edited there is the one you are most likely to want.
    const ordered = [...avatars].sort((a, b) => Number(Boolean(b.source)) - Number(Boolean(a.source)));
    const avatarName = await select('Avatar — the face every clip is built around', [
        ...ordered.map((a) => ({
            value: a.name,
            label: a.name,
            hint: `${a.refs.length} photo${a.refs.length === 1 ? '' : 's'} · seed ${a.seed}` +
                `${a.source ? ` · ${a.source.kind}` : ' · local'}`,
        })),
        {
            value: undefined,
            label: 'none',
            hint: 'text-only, no face reference',
        },
    ], 0);
    // Which photo opens the clip is the single biggest lever on how it looks in
    // i2v, so ask rather than quietly taking the first.
    const chosen = avatarName ? registry[avatarName] : undefined;
    const photo = chosen && chosen.refs.length > 1
        ? await select(`Which photo from "${chosen.name}"?`, chosen.refs.map((ref, index) => ({
            value: index + 1,
            label: photoLabel(chosen, index),
            hint: `${basename(ref)}${index === 0 ? ' · default' : ''}`,
        })), 0)
        : undefined;
    const prompt = await askText('What happens in the clip?');
    const model = await select('Model', Object.entries(RATE_PER_SECOND).map(([id, rate]) => ({
        value: id,
        label: id,
        hint: `~$${rate.toFixed(2)}/s`,
    })), 0);
    const aspectRatio = await select('Aspect ratio', [
        { value: '9:16', label: '9:16', hint: 'vertical — TikTok, Reels, Shorts' },
        { value: '16:9', label: '16:9', hint: 'landscape — YouTube' },
    ], config.aspectRatio === '16:9' ? 1 : 0);
    const duration = await select('Duration', DURATIONS.map((seconds) => ({
        value: seconds,
        label: `${seconds}s`,
        hint: `${estimateCost(model, seconds, 1)} per clip`,
    })), DURATIONS.indexOf(config.duration) >= 0
        ? DURATIONS.indexOf(config.duration)
        : 2);
    const resolution = await select('Resolution', Object.keys(RESOLUTION_TIERS).map((tier) => ({
        value: RESOLUTION_TIERS[tier],
        label: tier,
        hint: tier === '1080p' ? 'sharper, costs more on some models' : 'standard',
    })), 0);
    const clips = await askNumber('How many clips?', { min: 1, max: 20, fallback: 1 });
    const concurrency = clips === 1
        ? 1
        : await askNumber('How many at a time?', {
            min: 1,
            max: Math.min(clips, 5),
            fallback: Math.min(clips, 3),
        });
    heading('Ready');
    console.log(`  ${clips} clip${clips === 1 ? '' : 's'} · ${model} · ${duration}s · ` +
        `${aspectRatio} · ${resolutionTier(resolution)}` +
        `${avatarName ? ` · avatar ${avatarName}` : ' · no avatar'}`);
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
        photo,
        model,
        aspect: aspectRatio,
        duration,
        n: clips,
        concurrency,
        noAudio: false,
        dryRun: false,
        force: false,
        ...(avatarName ? {} : { mode: 't2v' }),
        resolution,
    });
}
/**
 * Collects clips that rendered but never made it to disk. Google keeps them for
 * 48 hours, so a download that failed after billing is recoverable rather than
 * lost.
 */
async function pullClips(outDir) {
    const clips = await listGeneratedClips();
    let pulled = 0;
    for (const clip of clips) {
        const expires = new Date(clip.expirationTime).toLocaleString();
        try {
            const { path, skipped } = await downloadClip(clip, outDir);
            const label = relative(process.cwd(), path);
            if (skipped) {
                console.log(`  · ${label} (already local)`);
            }
            else {
                pulled++;
                console.log(`  ✓ ${label}  · expires ${expires}`);
            }
        }
        catch (err) {
            console.log(`  ✗ ${clip.name} — ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    return pulled;
}
async function runPull(args) {
    const config = applyOverrides(await loadConfig(), args);
    const clips = await listGeneratedClips();
    if (!clips.length) {
        console.log('\nNo clips waiting on the Files API.\n');
        return;
    }
    console.log(`\n${clips.length} clip${clips.length === 1 ? '' : 's'} on the Files API:\n`);
    const pulled = await pullClips(config.outDir);
    console.log(`\n${pulled} new clip${pulled === 1 ? '' : 's'} → ${config.outDir}/\n`);
}
/**
 * Pulls avatars from the open Paper file. Paper is the source of truth for
 * photos; the local registry stays the runtime cache, so generation remains
 * fast and works offline once a sync has happened.
 */
async function runAvatarSync(args) {
    const { fileName, pageName, avatars } = await readAvatars();
    console.log(`\nPaper: ${fileName} · page "${pageName}"`);
    if (!avatars.length) {
        console.log('\nNo layers with images found on that page.\n' +
            'Each avatar is one top-level layer; the layer name becomes the avatar name.\n' +
            'Group several photos of one person into a frame to give that avatar several refs.\n');
        return;
    }
    const existing = await loadAvatars();
    const scratch = fromData('.paper-sync');
    ensureDataDir();
    await mkdir(scratch, { recursive: true });
    let changed = 0;
    try {
        for (const found of avatars) {
            const name = slugifyName(found.name);
            const known = existing[name];
            // Paper layer names allow anything; avatar names do not.
            if (name !== found.name) {
                note(`  layer "${found.name}" → avatar "${name}"`);
            }
            try {
                assertValidName(name);
            }
            catch {
                console.log(`  ✗ ${found.name} — cannot become a valid avatar name`);
                continue;
            }
            if (args.dryRun) {
                console.log(`  ${known ? '~' : '+'} ${name}  ${found.photos.length} photo` +
                    `${found.photos.length === 1 ? '' : 's'}` +
                    `${known ? '  (would replace)' : '  (new)'}`);
                for (const photo of found.photos)
                    console.log(`      · ${photo.label}`);
                continue;
            }
            // Download to scratch first so a failure part-way cannot leave an
            // avatar registered against photos that were never written.
            const files = [];
            for (const [index, photo] of found.photos.entries()) {
                const { data, ext } = await downloadPhoto(photo);
                const path = resolve(scratch, `${name}-${index}${ext}`);
                await writeFile(path, data);
                files.push(path);
            }
            const avatar = await addAvatar({
                name,
                sources: files,
                labels: found.photos.map((p) => p.label),
                force: true,
                source: {
                    kind: 'paper',
                    fileName,
                    nodeId: found.nodeId,
                    syncedAt: new Date().toISOString(),
                },
            });
            changed++;
            console.log(`  ${known ? '✓' : '+'} ${name}  ${avatar.refs.length} photo` +
                `${avatar.refs.length === 1 ? '' : 's'}  seed ${avatar.seed}` +
                `${known ? '' : '  (new)'}`);
        }
    }
    finally {
        await rm(scratch, { recursive: true, force: true });
    }
    // Local-only avatars are reported, never deleted — Paper is the source for
    // what it knows about, not an authority to remove work it never had.
    const fromPaper = new Set(avatars.map((a) => slugifyName(a.name)));
    const localOnly = Object.keys(existing).filter((n) => !fromPaper.has(n));
    if (localOnly.length) {
        console.log(`\n  local-only, left untouched: ${localOnly.join(', ')}`);
    }
    console.log(args.dryRun
        ? '\nDry run — nothing downloaded or changed.\n'
        : `\n${changed} avatar${changed === 1 ? '' : 's'} synced from Paper.\n`);
}
async function runAvatarCommand(args) {
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
                force: args.force,
            });
            console.log(`\n✓ avatar "${avatar.name}" — ${avatar.refs.length} ref` +
                `${avatar.refs.length === 1 ? '' : 's'}, seed ${avatar.seed} (locked)`);
            for (const ref of avatar.refs)
                console.log(`    ${ref}`);
            if (avatar.notes)
                console.log(`    notes: ${avatar.notes}`);
            console.log(`\nGenerate with it:\n  ugc gen "<prompt>" --avatar ${avatar.name}\n`);
            break;
        }
        case 'list': {
            const registry = await loadAvatars();
            const avatars = Object.values(registry);
            if (!avatars.length) {
                console.log('\nNo avatars yet.\n  ugc avatar add <name> <photo.jpg>\n');
                break;
            }
            console.log('');
            for (const avatar of avatars) {
                const width = Math.max(...avatars.map((a) => a.name.length));
                console.log(`  ${avatar.name.padEnd(width)}  ${avatar.refs.length} ref` +
                    `${avatar.refs.length === 1 ? ' ' : 's'}  ${avatar.mode ?? 'i2v'}  seed ${avatar.seed}` +
                    `${avatar.model ? `  ${avatar.model}` : ''}`);
                if (avatar.notes)
                    console.log(`  ${' '.repeat(width)}  ${avatar.notes}`);
                if (avatar.source) {
                    console.log(`  ${' '.repeat(width)}  ${avatar.source.kind}: ${avatar.source.fileName}` +
                        ` · synced ${avatar.source.syncedAt.slice(0, 10)}`);
                }
            }
            console.log('');
            break;
        }
        case 'sync':
            await runAvatarSync(args);
            break;
        case 'rm':
        case 'remove': {
            const name = rest[0];
            if (!name)
                throw new Error('ugc avatar rm <name>');
            const avatar = await removeAvatar(name);
            console.log(`\n✓ removed avatar "${avatar.name}" and its copied photos\n`);
            break;
        }
        default:
            throw new Error(`Unknown avatar command "${action ?? ''}". Use add, list, or rm.`);
    }
}
// Approximate list rates per output second at 720p, for sizing a run before you
// make it. Google's pricing page is the authority, and which ids a key can
// actually reach varies — hence the live listing below rather than this table.
const MODEL_NOTES = {
    'veo-3.1-generate-preview': 'best quality, native audio · ~$0.40/s',
    'veo-3.1-fast-generate-preview': 'faster and cheaper · ~$0.10/s',
};
/**
 * Asks the API which video models this key can actually reach. Listing is free,
 * and the ids drift between preview and GA often enough that a hardcoded table
 * goes stale and costs you a failed generation to discover.
 */
async function listModels() {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: authHeaders() });
    if (!res.ok) {
        throw new Error(`Model listing failed: ${res.status} ${res.statusText}`);
    }
    const { models } = (await res.json());
    const ids = models
        .map((m) => m.name.replace(/^models\//, ''))
        .filter((id) => /veo/i.test(id))
        .sort();
    if (!ids.length) {
        console.log('\nNo Veo models available to this key.\n' +
            'Veo needs billing enabled on the key\'s Google Cloud project.\n');
        return;
    }
    const width = Math.max(...ids.map((id) => id.length));
    console.log('\nVeo models available to your key:\n');
    for (const id of ids) {
        console.log(`  ${id.padEnd(width)}  ${MODEL_NOTES[id] ?? ''}`.trimEnd());
    }
    console.log('\nAn 8s clip costs roughly 8x the per-second rate.' +
        '\nUse one with --model, or set "model" in ugc.config.json\n');
}
const ENV_PATH = fromData('.env');
/**
 * Stores the API key in the data directory so it does not have to be exported
 * in every shell. Written 0600: it is a billable credential, and a key that
 * leaks is somebody else's video generation on your card.
 */
async function runSetup() {
    heading('ugc setup');
    console.log(`  Config and avatars live in ${DATA_DIR}\n`);
    if (process.env.GOOGLE_GENERATIVE_AI_API_KEY && !existsSync(ENV_PATH)) {
        note('  A key is already set in your environment; this will not change that.');
    }
    console.log('  Get a Gemini API key at https://aistudio.google.com/apikey\n' +
        '  Veo is not on the free tier — the key\'s Google Cloud project needs\n' +
        '  billing enabled.\n');
    const key = (await askText('Paste your Gemini API key')).trim();
    // Fail on something that cannot possibly be a key rather than storing it and
    // surfacing a confusing 403 on the first paid call.
    if (key.length < 20 || /\s/.test(key)) {
        throw new Error('That does not look like an API key — nothing was saved.');
    }
    ensureDataDir();
    // Preserve any other variables already in the file; only the key is replaced.
    const existing = existsSync(ENV_PATH) ? await readFile(ENV_PATH, 'utf8') : '';
    const withoutKey = existing
        .split('\n')
        .filter((line) => !/^\s*GOOGLE_GENERATIVE_AI_API_KEY\s*=/.test(line))
        .join('\n')
        .trim();
    await writeFile(ENV_PATH, `${withoutKey ? `${withoutKey}\n` : ''}GOOGLE_GENERATIVE_AI_API_KEY=${key}\n`, { mode: 0o600 });
    await chmod(ENV_PATH, 0o600);
    console.log(`\n  ✓ saved to ${ENV_PATH} (readable only by you)`);
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = key;
    console.log('\n  Checking the key...');
    try {
        await listModels();
    }
    catch (err) {
        console.error(`\n  ✗ ${explainError(err)}\n`);
        process.exitCode = 1;
        return;
    }
    console.log('Next:\n' +
        '  ugc avatar add <name> <photo.jpg>   register a face\n' +
        '  ugc                                 generate a clip\n');
}
/** Where everything lives. The first thing worth knowing when something is missing. */
async function runWhere() {
    const registry = await loadAvatars();
    const count = Object.keys(registry).length;
    const sources = configSources();
    console.log(`\n  data dir    ${DATA_DIR}${process.env.UGC_HOME ? '  (UGC_HOME)' : ''}`);
    console.log(`  avatars     ${AVATARS_PATH}` +
        `  ${existsSync(AVATARS_PATH) ? `(${count} registered)` : '(none yet)'}`);
    console.log(`  photos      ${fromData('refs')}`);
    console.log(`  api key     ${process.env.GOOGLE_GENERATIVE_AI_API_KEY
        ? existsSync(ENV_PATH)
            ? ENV_PATH
            : 'set in the environment'
        : 'not set — run: ugc setup'}`);
    console.log(`  config      ${sources.length ? sources.join('\n              ') : `${GLOBAL_CONFIG_PATH}  (not created; using defaults)`}`);
    console.log(`  output      ${fromCwd('out')}  (relative to where you run ugc)\n`);
}
/**
 * Earlier versions kept avatars beside the source, which only worked for the
 * one person who cloned the repo. Copy — never move — that library into the
 * data directory the first time the new layout is used, so an existing setup
 * keeps working and the originals stay put if anything goes wrong.
 */
async function migrateLegacyLibrary(command) {
    // Nothing that only prints text should quietly move files around first.
    if (['help', '--help', '-h'].includes(command))
        return;
    const legacyRoot = resolve(import.meta.dirname, '..');
    const legacyAvatars = resolve(legacyRoot, 'avatars.json');
    if (existsSync(AVATARS_PATH) || !existsSync(legacyAvatars))
        return;
    ensureDataDir();
    await cp(legacyAvatars, AVATARS_PATH);
    const legacyRefs = resolve(legacyRoot, 'refs');
    if (existsSync(legacyRefs)) {
        await cp(legacyRefs, fromData('refs'), { recursive: true });
    }
    const legacyEnv = resolve(legacyRoot, '.env');
    if (existsSync(legacyEnv) && !existsSync(ENV_PATH)) {
        await cp(legacyEnv, ENV_PATH);
        await chmod(ENV_PATH, 0o600);
    }
    console.log(`\nMoved your avatar library to ${DATA_DIR} so it works from anywhere.\n` +
        `The originals under ${legacyRoot} were left untouched and can be deleted.\n`);
}
async function main() {
    const args = parseArgs(process.argv.slice(2));
    await migrateLegacyLibrary(args.command);
    loadEnvFiles();
    switch (args.command) {
        case 'new':
            await runInteractive();
            break;
        case 'gen': {
            const prompt = args.positional.join(' ').trim();
            if (!prompt)
                throw new Error('gen needs a prompt: ugc gen "<prompt>"');
            await runPrompts([prompt], args);
            break;
        }
        case 'batch': {
            const file = args.positional[0];
            if (!file)
                throw new Error('batch needs a file: ugc batch shots.txt');
            const lines = (await readFile(fromCwd(file), 'utf8'))
                .split('\n')
                .map((line) => line.trim())
                .filter((line) => line && !line.startsWith('#'));
            if (!lines.length)
                throw new Error(`No prompts found in ${file}`);
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
        case 'setup':
            await runSetup();
            break;
        case 'where':
            await runWhere();
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
//# sourceMappingURL=cli.js.map