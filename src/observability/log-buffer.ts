/** In-process capture of pino lines so demos can inspect them without a child process. */
const chunks: string[] = [];

export function pushLogLine(chunk: string): void {
  chunks.push(chunk);
}

export function takeLogLines(): string[] {
  const out = chunks.join('').split('\n');
  chunks.length = 0;
  if (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

export function peekLogLines(): string[] {
  const out = chunks.join('').split('\n');
  if (out.length && out[out.length - 1] === '') out.pop();
  return out;
}
