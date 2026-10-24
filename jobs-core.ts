// Durable background jobs on one machine. Plain Node so it runs both inside
// the bb host worker and under `node --test`.
//
// Why this exists: commands an agent starts from its Bash tool belong to the
// agent's process tree and, on Linux, to the bb-app.service cgroup. The tree
// is torn down when the provider process exits, and the whole cgroup is
// killed when bb-app stops (KillMode=control-group). A job here runs as its
// own transient `systemd-run --user` unit (separate cgroup), or — where no
// user systemd exists (macOS) — as a detached session leader.
//
// On-disk layout, one directory per job under <root>/jobs/<id>/ (mode 0700):
//   meta.json      static facts written at start
//   command.sh     env exports + the user's command
//   output.log     combined stdout/stderr (append)
//   exit           exit code, written atomically by the runner when done
//   stop-requested marker written by stop() before killing
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Job, JobState } from "./contract.js";

const run = promisify(execFile);

export interface StartInput {
  name: string;
  command: string;
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number | null;
  threadId: string | null;
}

interface JobMeta {
  id: string;
  name: string;
  command: string;
  cwd: string;
  mode: "systemd" | "detached";
  unit: string | null;
  pid: number | null;
  createdAt: string;
  timeoutSec: number | null;
  threadId: string | null;
}

// Host variables a job inherits. Everything else comes from --env, so a job
// does not pick up bb's or node's internals.
const INHERITED_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TZ",
  "SSH_AUTH_SOCK",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
];

const RUNNER = `#!/usr/bin/env bash
# bb-plugin-jobs runner. $1 = job directory.
dir="$1"
log="$dir/output.log"
finish() {
  echo "$1" >"$dir/exit.tmp" && mv -f "$dir/exit.tmp" "$dir/exit"
  exit "$1"
}
cd -- "$(cat "$dir/cwd")" 2>>"$log" || { echo "[jobs] cannot cd into $(cat "$dir/cwd")" >>"$log"; finish 127; }
echo "[jobs] started $(date -u +%Y-%m-%dT%H:%M:%SZ) pid $$ in $PWD" >>"$log"
t="$(cat "$dir/timeout" 2>/dev/null)"
if [ -z "$t" ]; then
  bash "$dir/command.sh" >>"$log" 2>&1 </dev/null
  code=$?
else
  # Portable timeout (macOS has no coreutils timeout): run the command in its
  # own process group and let a watchdog signal that group.
  command -v perl >/dev/null 2>&1 || { echo "[jobs] --timeout needs perl on this machine" >>"$log"; finish 125; }
  perl -e 'setpgrp(0, 0); exec @ARGV or die "exec: $!"' bash "$dir/command.sh" >>"$log" 2>&1 </dev/null &
  cpid=$!
  (
    sleep "$t" & s=$!
    trap 'kill "$s" 2>/dev/null; exit 0' TERM
    wait "$s"
    : >"$dir/timed-out"
    echo "[jobs] timed out after \${t}s, sending SIGTERM" >>"$log"
    kill -TERM -"$cpid" 2>/dev/null
    sleep 15 & s=$!
    wait "$s"
    kill -KILL -"$cpid" 2>/dev/null
  ) &
  wpid=$!
  wait "$cpid"
  code=$?
  kill -TERM "$wpid" 2>/dev/null
  [ -f "$dir/timed-out" ] && code=124
fi
echo "[jobs] exited $code at $(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$log"
finish "$code"
`;

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function slug(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || "job";
}

function userEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (!env.XDG_RUNTIME_DIR && typeof process.getuid === "function") {
    const dir = `/run/user/${process.getuid()}`;
    if (existsSync(dir)) env.XDG_RUNTIME_DIR = dir;
  }
  return env;
}

export class JobManager {
  private systemd: Promise<boolean> | null = null;

  constructor(
    private readonly root: string,
    private readonly options: { forceDetached?: boolean } = {},
  ) {}

  private jobsDir(): string {
    return path.join(this.root, "jobs");
  }
  private dir(id: string): string {
    return path.join(this.jobsDir(), id);
  }

  /** User systemd is usable when `systemctl --user` answers. */
  hasSystemd(): Promise<boolean> {
    if (this.options.forceDetached || process.platform !== "linux") {
      return Promise.resolve(false);
    }
    this.systemd ??= run("systemctl", ["--user", "show-environment"], {
      env: userEnv(),
      timeout: 5000,
    }).then(
      () => true,
      () => false,
    );
    return this.systemd;
  }

  async start(input: StartInput): Promise<Job> {
    await mkdir(this.jobsDir(), { recursive: true, mode: 0o700 });
    const cwdStat = await stat(input.cwd).catch(() => null);
    if (!cwdStat?.isDirectory()) {
      throw new Error(`working directory does not exist: ${input.cwd}`);
    }
    const runner = path.join(this.root, "runner.sh");
    await writeFile(runner, RUNNER, { mode: 0o700 });

    const id = `${slug(input.name)}-${randomBytes(3).toString("hex")}`;
    const dir = this.dir(id);
    await mkdir(dir, { mode: 0o700 });
    const exports = Object.entries(input.env)
      .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
      .join("\n");
    await writeFile(
      path.join(dir, "command.sh"),
      `${exports}${exports ? "\n" : ""}${input.command}\n`,
      { mode: 0o600 },
    );
    await writeFile(path.join(dir, "cwd"), input.cwd);
    if (input.timeoutSec !== null) {
      await writeFile(path.join(dir, "timeout"), String(input.timeoutSec));
    }
    await writeFile(path.join(dir, "output.log"), "", { mode: 0o600 });

    const base = userEnv();
    const inherited: Record<string, string> = {};
    for (const key of INHERITED_ENV) {
      const value = base[key];
      if (value) inherited[key] = value;
    }

    let mode: JobMeta["mode"];
    let unit: string | null = null;
    let pid: number | null = null;
    if (await this.hasSystemd()) {
      mode = "systemd";
      unit = `bbjob-${id}`;
      const args = [
        "--user",
        `--unit=${unit}`,
        "--collect",
        "--quiet",
        "--property=KillMode=control-group",
        "--property=TimeoutStopSec=15",
        ...Object.entries(inherited).map(([k, v]) => `--setenv=${k}=${v}`),
        "--",
        "/bin/bash",
        runner,
        dir,
      ];
      try {
        await run("systemd-run", args, { env: base, timeout: 15000 });
      } catch (error) {
        throw new Error(`systemd-run failed: ${errorText(error)}`);
      }
      pid = await this.unitMainPid(unit);
    } else {
      mode = "detached";
      // detached: true makes the child a session + process-group leader, so
      // it outlives this worker and can be stopped as one group.
      const child = spawn("/bin/bash", [runner, dir], {
        cwd: input.cwd,
        detached: true,
        stdio: "ignore",
        env: inherited,
      });
      pid = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("spawn", () => resolve(child.pid ?? -1));
      });
      child.unref();
    }

    const meta: JobMeta = {
      id,
      name: input.name,
      command: input.command,
      cwd: input.cwd,
      mode,
      unit,
      pid,
      createdAt: new Date().toISOString(),
      timeoutSec: input.timeoutSec,
      threadId: input.threadId,
    };
    await writeFile(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
    return this.get(id);
  }

  async list(limit: number): Promise<Job[]> {
    const names = await readdir(this.jobsDir()).catch(() => [] as string[]);
    const metas: JobMeta[] = [];
    for (const name of names) {
      const meta = await this.readMeta(name).catch(() => null);
      if (meta) metas.push(meta);
    }
    metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return Promise.all(metas.slice(0, limit).map((m) => this.describe(m)));
  }

  async get(id: string): Promise<Job> {
    return this.describe(await this.readMeta(id));
  }

  async logs(
    id: string,
    maxBytes: number,
  ): Promise<{ job: Job; text: string; truncated: boolean }> {
    const job = await this.get(id);
    const handle = await open(job.logPath, "r");
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - maxBytes);
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      let text = buffer.toString("utf8");
      // Drop a partial first line (and a split UTF-8 char) when clipped.
      if (start > 0) text = text.slice(text.indexOf("\n") + 1);
      return { job, text, truncated: start > 0 };
    } finally {
      await handle.close();
    }
  }

  async stop(id: string): Promise<Job> {
    const meta = await this.readMeta(id);
    const dir = this.dir(id);
    if (!(await this.isAlive(meta))) return this.describe(meta);
    await writeFile(path.join(dir, "stop-requested"), new Date().toISOString());
    await appendFile(
      path.join(dir, "output.log"),
      `[jobs] stop requested at ${new Date().toISOString()}\n`,
    );
    if (meta.mode === "systemd" && meta.unit) {
      // Stops every process in the unit's cgroup: SIGTERM, then SIGKILL
      // after TimeoutStopSec. Blocks until the unit is down.
      await run("systemctl", ["--user", "stop", meta.unit], {
        env: userEnv(),
        timeout: 30000,
      }).catch(() => undefined);
    } else if (meta.pid) {
      await killTree(meta.pid, "SIGTERM");
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && (await this.isAlive(meta))) {
        await sleep(250);
      }
      if (await this.isAlive(meta)) await killTree(meta.pid, "SIGKILL");
    }
    return this.describe(meta);
  }

  private async readMeta(id: string): Promise<JobMeta> {
    const file = path.join(this.dir(id), "meta.json");
    try {
      return JSON.parse(await readFile(file, "utf8")) as JobMeta;
    } catch {
      throw new Error(`no job with id ${id} on this machine`);
    }
  }

  private async unitMainPid(unit: string): Promise<number | null> {
    const out = await run(
      "systemctl",
      ["--user", "show", "-p", "MainPID", "--value", unit],
      { env: userEnv(), timeout: 5000 },
    ).catch(() => null);
    const pid = Number.parseInt(out?.stdout.trim() ?? "", 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  }

  private async isAlive(meta: JobMeta): Promise<boolean> {
    if (meta.mode === "systemd" && meta.unit) {
      const out = await run(
        "systemctl",
        ["--user", "show", "-p", "ActiveState", "--value", meta.unit],
        { env: userEnv(), timeout: 5000 },
      ).catch(() => null);
      const state = out?.stdout.trim() ?? "";
      return ["active", "activating", "deactivating", "reloading"].includes(
        state,
      );
    }
    return meta.pid !== null && groupAlive(meta.pid);
  }

  private async describe(meta: JobMeta): Promise<Job> {
    const dir = this.dir(meta.id);
    const exitRaw = await readFile(path.join(dir, "exit"), "utf8").catch(
      () => null,
    );
    const exitCode = exitRaw === null ? null : Number.parseInt(exitRaw, 10);
    const stopRequested = existsSync(path.join(dir, "stop-requested"));
    let state: JobState;
    let finishedAt: string | null = null;
    if (exitCode !== null && Number.isFinite(exitCode)) {
      state = stopRequested ? "stopped" : "exited";
      finishedAt = (await stat(path.join(dir, "exit"))).mtime.toISOString();
    } else if (await this.isAlive(meta)) {
      state = "running";
    } else {
      state = stopRequested ? "stopped" : "lost";
    }
    return {
      id: meta.id,
      name: meta.name,
      command: meta.command,
      cwd: meta.cwd,
      mode: meta.mode,
      unit: meta.unit,
      pid: meta.pid,
      state,
      exitCode: exitCode !== null && Number.isFinite(exitCode) ? exitCode : null,
      createdAt: meta.createdAt,
      finishedAt,
      timeoutSec: meta.timeoutSec,
      threadId: meta.threadId,
      logPath: path.join(dir, "output.log"),
    };
  }
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Signal the job's process group and every descendant of its leader.
 * Descendants matter because the --timeout wrapper and some daemons move themselves into
 * their own process group.
 */
async function killTree(pid: number, signal: NodeJS.Signals): Promise<void> {
  const targets = new Set<number>([pid]);
  const out = await run("ps", ["-A", "-o", "pid=,ppid="], {
    timeout: 5000,
  }).catch(() => null);
  if (out) {
    const children = new Map<number, number[]>();
    for (const line of out.stdout.split("\n")) {
      const [p, pp] = line.trim().split(/\s+/).map(Number);
      if (!p || pp === undefined) continue;
      children.set(pp, [...(children.get(pp) ?? []), p]);
    }
    const queue = [pid];
    while (queue.length) {
      for (const child of children.get(queue.pop()!) ?? []) {
        if (!targets.has(child)) {
          targets.add(child);
          queue.push(child);
        }
      }
    }
  }
  try {
    process.kill(-pid, signal);
  } catch {}
  for (const target of targets) {
    try {
      process.kill(target, signal);
    } catch {}
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(error: unknown): string {
  const e = error as { stderr?: string; message?: string };
  return (e.stderr || e.message || String(error)).trim();
}
