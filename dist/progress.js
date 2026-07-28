import { stdout } from 'node:process';
/**
 * Live progress for renders that report no progress of their own.
 *
 * Veo is poll-until-done: there is no percentage to read, so the bar is driven
 * by elapsed time against a typical render and deliberately stops short of
 * full. Real elapsed seconds are always shown next to it, so the honest number
 * is the one you can act on and the bar is only a sense of movement.
 */
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const WIDTH = 24;
const CAP = 0.92;
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';
const HIDE = '\x1b[?25l';
const SHOW = '\x1b[?25h';
export class Progress {
    jobs;
    timer;
    frame = 0;
    painted = 0;
    /** Falls back to plain lines when piped, so logs stay readable. */
    live;
    estimateMs;
    // Fields are assigned explicitly rather than declared as constructor
    // parameter properties: Node runs this TypeScript by stripping types, and
    // parameter properties need a real transform, so they fail at runtime.
    constructor(labels, estimateMs) {
        this.jobs = labels.map((label) => ({ label, state: 'waiting' }));
        this.estimateMs = estimateMs;
        this.live = Boolean(stdout.isTTY);
    }
    start() {
        if (!this.live)
            return;
        stdout.write(HIDE);
        this.timer = setInterval(() => this.render(), 100);
        // Unref so a stray interval can never hold the process open.
        this.timer.unref?.();
    }
    began(index) {
        this.jobs[index].state = 'running';
        this.jobs[index].startedAt = Date.now();
        if (!this.live)
            console.log(`[${index + 1}/${this.jobs.length}] ${this.jobs[index].label}`);
    }
    finished(index, detail) {
        this.jobs[index].state = 'done';
        this.jobs[index].endedAt = Date.now();
        this.jobs[index].detail = detail;
        if (!this.live) {
            console.log(`[${index + 1}/${this.jobs.length}] done in ` +
                `${Math.round(this.elapsed(this.jobs[index]) / 1000)}s → ${detail}`);
        }
    }
    failed(index, detail) {
        this.jobs[index].state = 'failed';
        this.jobs[index].endedAt = Date.now();
        this.jobs[index].detail = detail;
        if (!this.live)
            console.log(`[${index + 1}/${this.jobs.length}] FAILED`);
    }
    /** Stops the animation and leaves the final state on screen. */
    stop() {
        if (!this.live)
            return;
        clearInterval(this.timer);
        this.render();
        stdout.write(SHOW);
    }
    elapsed(job) {
        if (!job.startedAt)
            return 0;
        return (job.endedAt ?? Date.now()) - job.startedAt;
    }
    bar(job) {
        const ratio = job.state === 'done' || job.state === 'failed'
            ? 1
            : Math.min(this.elapsed(job) / this.estimateMs, CAP);
        const filled = Math.round(ratio * WIDTH);
        const colour = job.state === 'failed' ? RED : job.state === 'done' ? GREEN : '';
        return `${colour}${'█'.repeat(filled)}${DIM}${'░'.repeat(WIDTH - filled)}${RESET}`;
    }
    line(job, index) {
        const seconds = Math.floor(this.elapsed(job) / 1000);
        const clock = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
        const tag = `${index + 1}/${this.jobs.length}`;
        if (job.state === 'waiting') {
            return `  ${DIM}${tag}  ${'░'.repeat(WIDTH)}  queued${RESET}`;
        }
        const mark = job.state === 'running'
            ? FRAMES[this.frame % FRAMES.length]
            : job.state === 'done'
                ? `${GREEN}✓${RESET}`
                : `${RED}✗${RESET}`;
        const detail = job.detail ? `  ${DIM}${job.detail}${RESET}` : '';
        return `  ${DIM}${tag}${RESET} ${mark} ${this.bar(job)}  ${clock}${detail}`;
    }
    render() {
        if (!this.live)
            return;
        this.frame++;
        // Redraw in place: jump back over what was painted last tick, then
        // rewrite every line. Clearing each line avoids leftovers when a line
        // gets shorter.
        const out = this.painted ? `\x1b[${this.painted}A` : '';
        const body = this.jobs
            .map((job, index) => `\x1b[2K${this.line(job, index)}`)
            .join('\n');
        stdout.write(`${out}${body}\n`);
        this.painted = this.jobs.length;
    }
}
/**
 * A rough expectation of how long one clip takes, used only to pace the bar.
 * Longer clips and the higher-quality model take proportionally longer.
 */
export function estimateRenderMs(model, duration) {
    const perSecond = /fast/.test(model) ? 9_000 : 18_000;
    return Math.max(30_000, perSecond * duration);
}
//# sourceMappingURL=progress.js.map