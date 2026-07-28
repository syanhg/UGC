import { experimental_generateVideo as generateVideo, NoVideoGeneratedError } from 'ai';
import { google } from '@ai-sdk/google';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, basename, isAbsolute } from 'node:path';
import { fromCwd, fromData } from "./paths.js";
import { MEDIA_TYPES } from "./config.js";
import { fetchWithRetry } from "./files.js";
/**
 * Reference images become data URLs so the same local face file can be reused
 * across every clip without uploading it somewhere first.
 */
async function loadRef(path) {
    if (/^https?:\/\//.test(path))
        return path;
    // Avatar refs are stored relative to the data directory; --ref is made
    // absolute by the CLI, so resolving it against cwd leaves it unchanged.
    const abs = isAbsolute(path) ? path : fromData(path);
    if (!existsSync(abs)) {
        throw new Error(`Reference image not found: ${path}\n` +
            `Register an avatar instead:  ugc avatar add <name> <photo.jpg>\n` +
            `Or point "refs" in ugc.config.json at a photo that exists.`);
    }
    const ext = extname(abs).toLowerCase();
    const mediaType = MEDIA_TYPES[ext];
    if (!mediaType) {
        throw new Error(`Unsupported reference image type "${ext}" (use jpg, png, or webp)`);
    }
    return `data:${mediaType};base64,${(await readFile(abs)).toString('base64')}`;
}
function slugify(text) {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 48) || 'clip';
}
/**
 * Veo uploads the finished clip to the Files API and hands back a URL for the
 * SDK to fetch. That fetch 503s often enough to matter, and by then the clip is
 * already rendered and billed — so retry rather than lose it. Files stay
 * retrievable for 48 hours, so a total failure here is recoverable by hand.
 */
async function downloadWithRetry({ url, abortSignal, }) {
    try {
        const res = await fetchWithRetry(url.toString(), { signal: abortSignal });
        return {
            data: new Uint8Array(await res.arrayBuffer()),
            mediaType: res.headers.get('content-type') ?? undefined,
        };
    }
    catch (err) {
        throw new Error(`The clip rendered but could not be downloaded: ` +
            `${err instanceof Error ? err.message : String(err)}\n` +
            `It stays on Google's Files API for 48 hours — recover it with "ugc pull".`);
    }
}
/**
 * The text Veo actually receives: the line you typed, then the shared style
 * block, which by this point already has the avatar's identity notes folded
 * into it. Exported so `--dry-run` can show the real thing rather than a
 * reconstruction that might drift from what is sent.
 */
export function buildPrompt(prompt, config) {
    return config.stylePrompt ? `${prompt}\n\n${config.stylePrompt}` : prompt;
}
/**
 * Veo reports inputTokenLimit 480. Tokens are roughly four characters, so this
 * is a deliberately loose ceiling — the point is to catch a runaway prompt
 * locally rather than after a round trip, not to count exactly.
 */
const PROMPT_CHAR_LIMIT = 480 * 4;
export function checkPromptLength(fullPrompt) {
    if (fullPrompt.length <= PROMPT_CHAR_LIMIT)
        return undefined;
    return (`Prompt is ${fullPrompt.length} characters, over Veo's ~${PROMPT_CHAR_LIMIT} limit. ` +
        `Shorten the line, or trim "stylePrompt" in ugc.config.json` +
        `${' — avatar notes are appended to it too'}.`);
}
export async function generateClip({ prompt, config, seed, label, }) {
    const fullPrompt = buildPrompt(prompt, config);
    const tooLong = checkPromptLength(fullPrompt);
    if (tooLong)
        throw new Error(tooLong);
    // t2v ignores references entirely, so don't touch the filesystem for them —
    // a stale "refs" entry in the config shouldn't fail a text-only clip.
    const refs = config.mode === 't2v'
        ? []
        : await Promise.all(config.refs.map(loadRef));
    if (config.mode !== 't2v' && refs.length === 0) {
        throw new Error(`Mode "${config.mode}" needs at least one reference image. ` +
            `Add one to "refs" in ugc.config.json, or set mode to "t2v".`);
    }
    // i2v pins the face as the opening frame; r2v passes refs as identity
    // references so the model can move the subject freely and still match.
    const referenceArgs = config.mode === 'i2v'
        ? { prompt: { image: refs[0], text: fullPrompt } }
        : config.mode === 'r2v'
            ? { prompt: fullPrompt, inputReferences: refs }
            : { prompt: fullPrompt };
    const { video, warnings } = await generateVideo({
        model: google.video(config.model),
        ...referenceArgs,
        duration: config.duration,
        aspectRatio: config.aspectRatio,
        ...(config.resolution ? { resolution: config.resolution } : {}),
        generateAudio: config.generateAudio,
        ...(seed !== undefined ? { seed } : {}),
        abortSignal: AbortSignal.timeout(10 * 60_000),
        download: downloadWithRetry,
        providerOptions: {
            google: {
                // Video jobs are queued server-side; give them room to finish.
                pollTimeoutMs: 10 * 60_000,
                // Veo refuses to render people unless this is set. "allow_adult" is
                // the setting a UGC avatar needs; the wider "allow_all" also permits
                // minors, which nothing here should ever be doing.
                personGeneration: config.personGeneration,
            },
        },
    });
    // Clips land where you ran the command, not next to the install.
    await mkdir(fromCwd(config.outDir), { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const name = `${stamp}_${slugify(label ?? prompt)}.mp4`;
    const file = fromCwd(config.outDir, name);
    await writeFile(file, video.uint8Array);
    return {
        file,
        warnings: warnings.map((w) => 'message' in w && w.message
            ? String(w.message)
            : `${w.type}: ${'setting' in w ? String(w.setting) : 'unsupported'}`),
    };
}
/**
 * Last line of defence before anything reaches a terminal, a log file, or a
 * pasted bug report. Requests here send the key as a header rather than a query
 * parameter, but the SDK, a proxy, or a future call site can still put it in a
 * URL — so strip the key out of every string on its way to being printed,
 * whatever shape it arrives in.
 */
export function redact(message) {
    const key = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    return (message
        // key=... and x-goog-api-key: ... , however they were spelled.
        .replace(/([?&](?:key|api_?key)=)[^&\s"']+/gi, '$1<redacted>')
        .replace(/((?:x-goog-api-key|authorization|bearer)["'\s:=]+)[^\s"',}]+/gi, '$1<redacted>')
        // The literal value, in case it appeared somewhere unanticipated.
        .replaceAll(key && key.length > 8 ? key : '\0<no key set>\0', '<redacted>')
        // Google keys have a fixed, recognisable shape; catch a stray one even if
        // it is not the key this process is running with.
        .replace(/AIza[0-9A-Za-z_-]{20,}/g, '<redacted>'));
}
/** Errors nest their real cause; the message alone often says nothing useful. */
function fullMessage(err) {
    const parts = [];
    for (let current = err, depth = 0; current && depth < 4; depth++) {
        parts.push(current instanceof Error ? current.message : String(current));
        current = current instanceof Error ? current.cause : undefined;
    }
    return redact(parts.filter(Boolean).join(': '));
}
export function explainError(err) {
    if (NoVideoGeneratedError.isInstance(err)) {
        return (`The model accepted the request but returned no video.\n` +
            `Cause: ${err.cause ? redact(String(err.cause)) : 'unknown'}\n` +
            `This is usually a safety filter — try softening the prompt or using a different reference photo.`);
    }
    const message = fullMessage(err);
    if (/api key|unauthor|401|403/i.test(message)) {
        return (`Auth failed: ${message}\n\n` +
            `Set your Gemini API key:\n  ugc setup\n` +
            `or:  export GOOGLE_GENERATIVE_AI_API_KEY="..."\n` +
            `Get one at https://aistudio.google.com/apikey`);
    }
    // Paper failures travel through the same reporting path, so they must be
    // matched before the Veo branches — a 429 from Paper is not a Veo billing
    // problem, and saying so sends you to fix the wrong thing.
    if (/paper/i.test(message))
        return message;
    if (/billing|quota|resource_exhausted|free tier/i.test(message)) {
        return (`${message}\n\n` +
            `Veo is not on the Gemini free tier. Enable billing on the Google Cloud ` +
            `project behind your key, or try a cheaper model:\n` +
            `  --model veo-3.1-fast-generate-preview`);
    }
    if (/timeout|aborted/i.test(message)) {
        return `Generation timed out after 10 minutes: ${message}\nThe job may still be running provider-side. Try a shorter duration or the "-fast" variant of your model.`;
    }
    return message;
}
export { basename };
//# sourceMappingURL=generate.js.map