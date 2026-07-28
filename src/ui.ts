import { createInterface, type Interface } from 'node:readline';
import { stdin, stdout } from 'node:process';

let rl: Interface | undefined;
let buffered: string[] = [];
let waiting:
  | { resolve: (line: string) => void; reject: (err: Error) => void }
  | undefined;
let closed = false;

const EOF = () =>
  new Error(
    'Input ended before every question was answered — nothing was generated.',
  );

/**
 * Lines are buffered as they arrive rather than read on demand. Piped input
 * delivers every line at once, and readline drops any that land while no
 * question is pending — which silently truncates a scripted run. Buffering
 * makes typing and piping behave identically.
 */
function io(): Interface {
  if (rl) return rl;

  rl = createInterface({ input: stdin });
  rl.on('line', (line) => {
    if (waiting) {
      const { resolve } = waiting;
      waiting = undefined;
      resolve(line);
    } else {
      buffered.push(line);
    }
  });
  rl.on('close', () => {
    closed = true;
    // Fail rather than hang, and rather than quietly answering the rest of
    // the questions with defaults — those defaults would spend money.
    waiting?.reject(EOF());
    waiting = undefined;
  });

  return rl;
}

function ask(question: string): Promise<string> {
  io();
  stdout.write(question);

  const next = buffered.shift();
  if (next !== undefined) {
    // Echo it, so a piped run reads like a transcript of a typed one.
    if (!stdin.isTTY) stdout.write(`${next}\n`);
    return Promise.resolve(next);
  }
  if (closed) return Promise.reject(EOF());

  return new Promise((resolve, reject) => {
    waiting = { resolve, reject };
  });
}

export function closeUi(): void {
  rl?.close();
  rl = undefined;
  buffered = [];
  waiting = undefined;
  closed = false;
}

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

export function heading(text: string): void {
  console.log(`\n${BOLD}${text}${RESET}`);
}

export function note(text: string): void {
  console.log(`${DIM}${text}${RESET}`);
}

export interface Choice<T> {
  value: T;
  label: string;
  hint?: string;
}

/**
 * A numbered picker. Deliberately not a cursor-driven menu: this has to stay
 * readable when output is piped or the terminal is dumb, and a number is
 * unambiguous in a way arrow keys are not.
 */
export async function select<T>(
  question: string,
  choices: Choice<T>[],
  defaultIndex = 0,
): Promise<T> {
  heading(question);

  const width = Math.max(...choices.map((c) => c.label.length));
  for (const [index, choice] of choices.entries()) {
    const marker = index === defaultIndex ? '·' : ' ';
    console.log(
      `  ${marker} ${index + 1}) ${choice.label.padEnd(width)}` +
        (choice.hint ? `  ${DIM}${choice.hint}${RESET}` : ''),
    );
  }

  for (;;) {
    const answer = (
      await ask(`  > [${defaultIndex + 1}] `)
    ).trim();
    if (!answer) return choices[defaultIndex].value;

    const picked = Number(answer);
    if (Number.isInteger(picked) && picked >= 1 && picked <= choices.length) {
      return choices[picked - 1].value;
    }
    note(`  Enter a number from 1 to ${choices.length}.`);
  }
}

export async function askText(
  question: string,
  { required = true }: { required?: boolean } = {},
): Promise<string> {
  heading(question);

  for (;;) {
    const answer = (await ask('  > ')).trim();
    if (answer || !required) return answer;
    note('  Say something — this is the line the clip is built around.');
  }
}

export async function askNumber(
  question: string,
  { min, max, fallback }: { min: number; max: number; fallback: number },
): Promise<number> {
  heading(question);

  for (;;) {
    const answer = (await ask(`  > [${fallback}] `)).trim();
    if (!answer) return fallback;

    const value = Number(answer);
    if (Number.isInteger(value) && value >= min && value <= max) return value;
    note(`  Enter a whole number from ${min} to ${max}.`);
  }
}

export async function confirm(question: string): Promise<boolean> {
  const answer = (await ask(`\n${question} [y/N] `)).trim();
  return /^y(es)?$/i.test(answer);
}
