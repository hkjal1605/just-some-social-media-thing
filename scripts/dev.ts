#!/usr/bin/env bun
// Dev runner: spawns api, workers, bot and dashboard with prefixed output (doc 01 §2).
// No dependencies. Ctrl-C kills all children.

const procs = [
  { name: "api ", color: 36, cmd: ["bun", "--watch", "apps/api/src/index.ts"] },
  { name: "wrk ", color: 33, cmd: ["bun", "--watch", "apps/workers/src/index.ts"] },
  { name: "bot ", color: 35, cmd: ["bun", "--watch", "apps/bot/src/index.ts"] },
  { name: "dash", color: 32, cmd: ["bun", "run", "--cwd", "apps/dashboard", "dev"] },
];

const children: ReturnType<typeof Bun.spawn>[] = [];

function prefix(name: string, color: number, chunk: string): string {
  return chunk
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => `\x1b[${color}m[${name}]\x1b[0m ${l}`)
    .join("\n");
}

async function pipe(name: string, color: number, stream: ReadableStream<Uint8Array>) {
  const dec = new TextDecoder();
  for await (const chunk of stream) {
    const text = prefix(name, color, dec.decode(chunk));
    if (text) console.log(text);
  }
}

for (const p of procs) {
  const child = Bun.spawn(p.cmd, { stdout: "pipe", stderr: "pipe", env: process.env });
  children.push(child);
  void pipe(p.name, p.color, child.stdout);
  void pipe(p.name, p.color, child.stderr);
  void child.exited.then((code) => console.log(prefix(p.name, p.color, `exited (${code})`)));
}

function shutdown() {
  for (const c of children) c.kill();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
