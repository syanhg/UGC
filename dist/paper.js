import { MEDIA_TYPES } from "./config.js";
/**
 * Paper Desktop runs a local MCP server while a file is open. It is on the
 * loopback interface with no authentication, so the CLI can talk to it
 * directly — no token, no account, no rate limit.
 */
const PAPER_URL = process.env.PAPER_MCP_URL ?? 'http://127.0.0.1:29979/mcp';
const HEADERS = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
};
let session;
function unreachable(err) {
    return new Error(`Cannot reach Paper at ${PAPER_URL}.\n` +
        `Paper Desktop must be running with a file open — it starts the server ` +
        `automatically.\n${err instanceof Error ? err.message : String(err)}`);
}
/** Responses come back as SSE frames or plain JSON depending on the call. */
function parseBody(text) {
    const frame = text.split('\n').find((line) => line.startsWith('data: '));
    return JSON.parse(frame ? frame.slice(6) : text);
}
async function rpc(method, params) {
    let res;
    try {
        res = await fetch(PAPER_URL, {
            method: 'POST',
            headers: { ...HEADERS, ...(session ? { 'mcp-session-id': session } : {}) },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: Math.floor(Math.random() * 1e6),
                method,
                params,
            }),
        });
    }
    catch (err) {
        throw unreachable(err);
    }
    if (!res.ok)
        throw new Error(`Paper returned ${res.status} ${res.statusText}`);
    session ??= res.headers.get('mcp-session-id') ?? undefined;
    const text = await res.text();
    return text.trim() ? parseBody(text) : undefined;
}
let connected = false;
async function connect() {
    if (connected)
        return;
    await rpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'ugc', version: '1' },
    });
    // The server expects this notification before it will service tool calls.
    await fetch(PAPER_URL, {
        method: 'POST',
        headers: { ...HEADERS, ...(session ? { 'mcp-session-id': session } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    }).catch(() => undefined);
    connected = true;
}
async function callTool(name, args = {}) {
    await connect();
    const out = await rpc('tools/call', { name, arguments: args });
    if (out?.error) {
        throw new Error(`Paper ${name} failed: ${out.error.message ?? 'unknown'}`);
    }
    const text = (out?.result?.content ?? [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
    return JSON.parse(text);
}
async function descendants(nodeId, depth = 0) {
    // Avatar layers are shallow; the bound stops a runaway walk on a file that
    // also holds unrelated design work.
    if (depth > 4)
        return [];
    const { children } = await callTool('get_children', {
        nodeId,
    });
    const nested = await Promise.all(children
        .filter((c) => c.childCount > 0)
        .map((c) => descendants(c.id, depth + 1)));
    return [...children, ...nested.flat()];
}
const IMAGE_URL = /url\((?:"|')?([^"')]+)/;
/**
 * One top-level layer is one avatar, named after that layer. Every image found
 * in its subtree becomes one of its reference photos, so a bare rectangle
 * gives one photo and a frame grouping several gives several.
 */
export async function readAvatars() {
    const info = await callTool('get_basic_info');
    const { children: tops } = await callTool('get_children', { nodeId: info.rootNodeId });
    const avatars = [];
    for (const top of tops) {
        const nodes = [top, ...(top.childCount > 0 ? await descendants(top.id) : [])];
        // Computed styles expose the image fill as a backgroundImage url, and can
        // be asked for many nodes at once — far cheaper than pulling image bytes
        // just to discover whether a node has any.
        const { styles } = await callTool('get_computed_styles', { nodeIds: nodes.map((n) => n.id) });
        const photos = nodes
            .map((node) => {
            const url = IMAGE_URL.exec(styles[node.id]?.backgroundImage ?? '')?.[1];
            return url ? { nodeId: node.id, label: node.name, url } : undefined;
        })
            .filter((p) => p !== undefined);
        if (photos.length) {
            avatars.push({ name: top.name, nodeId: top.id, photos });
        }
    }
    return { fileName: info.fileName, pageName: info.pageName, avatars };
}
const EXTENSIONS = Object.fromEntries(Object.entries(MEDIA_TYPES).map(([ext, mime]) => [mime, ext]));
/**
 * Fetches the original uploaded asset rather than a re-encode. Paper's
 * get_fill_image returns JPEG regardless of what was uploaded, and a
 * recompressed reference photo is a weaker identity anchor.
 */
export async function downloadPhoto(photo) {
    // The URL comes out of a design file's style data, so it is only as
    // trustworthy as that file. Restrict it to http(s) before fetching: a
    // `file:` or `data:` fill would otherwise read local files into an avatar.
    let url;
    try {
        url = new URL(photo.url);
    }
    catch {
        throw new Error(`${photo.label}: image fill is not a valid URL`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new Error(`${photo.label}: refusing to fetch a "${url.protocol}" image fill ` +
            `— only http and https are allowed`);
    }
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) {
        throw new Error(`${photo.label}: ${res.status} ${res.statusText}`);
    }
    const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim();
    const ext = EXTENSIONS[mime];
    if (!ext) {
        throw new Error(`${photo.label}: unsupported image type "${mime || 'unknown'}" ` +
            `— Veo takes jpg, png, or webp`);
    }
    return { data: new Uint8Array(await res.arrayBuffer()), ext };
}
//# sourceMappingURL=paper.js.map