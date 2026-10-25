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
//   runner.sh      this job's own copy of the runner (never rewritten)
//   exec.pl        output copier: size-capped log, timeout, exit code
//   command.sh     env loader prelude + the user's command
//   env.sh         --env exports; the job reads and deletes it as it starts,
//                  so values live only in the job's process environment
//   output.log     combined stdout/stderr; output.log.1 after a rotation
//   log-base       bytes written before the current output.log (cursors)
//   exit           exit code, written atomically when the command ends
//   pgid           process group of the command, written by exec.pl
//   stop-requested marker written by stop() before killing
//
// Detached jobs are recognised without trusting a stored PID (PIDs get
// reused): a process belongs to the job when its command line is exactly one
// of this job's own launch lines (runner.sh, exec.pl, command.sh in the job
// directory), when it descends from such a process, or when it is in the
// command's process group and started no earlier than the job. macOS hides
// other processes' environments, so an environment marker cannot be used.
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Job, JobState } from "./contract.js";

const run = promisify(execFile);

export const DEFAULT_LOG_MAX_BYTES = 50 * 1024 * 1024;

export interface StartInput {
  name: string;
  command: string;
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number | null;
  /** Rotate output.log to output.log.1 past this size; 0 = unlimited. */
  logMaxBytes?: number;
  threadId: string | null;
  /** BB_* context variables (thread id, thread storage, ...). */
  bbEnv?: Record<string, string>;
  /** Idempotency key: a second start with the same key returns the first job. */
  key?: string | null;
  /** Absolute path of a KEY=VALUE file on this machine, loaded by the job. */
  envFile?: string | null;
  /** systemd resource limits; they require systemd mode. */
  memoryMax?: string | null;
  cpuQuota?: string | null;
  tasksMax?: number | null;
  /** Fail instead of falling back to detached mode. */
  requireSystemd?: boolean;
  /** Internal: sha256 of the key, marked in the job directory. */
  keyHash?: string;
}

export function keyHash(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** What a repeated start with the same key must match. */
export function requestFingerprint(input: StartInput): string {
  const env = Object.entries(input.env ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${createHash("sha256").update(v).digest("hex")}`);
  return createHash("sha256")
    .update(
      JSON.stringify({
        command: input.command,
        cwd: input.cwd,
        env,
        envFile: input.envFile ?? null,
        timeoutSec: input.timeoutSec ?? null,
        memoryMax: input.memoryMax ?? null,
        cpuQuota: input.cpuQuota ?? null,
        tasksMax: input.tasksMax ?? null,
        requireSystemd: input.requireSystemd ?? false,
      }),
    )
    .digest("hex");
}

type Claim = {
  state: "pending" | "done";
  pid: number;
  jobId: string | null;
  fingerprint: string | null;
};

async function readClaim(file: string): Promise<Claim | null> {
  const raw = await readFile(file, "utf8").catch(() => null);
  if (raw === null) return null;
  const text = raw.trim();
  if (!text) return { state: "pending", pid: -1, jobId: null, fingerprint: null };
  if (!text.startsWith("{")) return { state: "done", pid: -1, jobId: text, fingerprint: null }; // 0.5.0/0.5.1
  return JSON.parse(text) as Claim;
}

async function writeClaim(file: string, claim: Claim): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(claim), { mode: 0o600 });
  await rename(tmp, file);
}

function pidAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export const MEMORY_MAX_PATTERN = /^(\d+[KMGT]?|\d{1,3}%)$/i;
export const CPU_QUOTA_PATTERN = /^\d{1,5}%$/;
export const KEY_PATTERN = /^[\x21-\x7e]{1,200}$/;

/**
 * Bash that loads KEY=VALUE lines from a file into the job's environment
 * without executing it: blank lines and # comments are skipped, an optional
 * "export " prefix and one pair of surrounding quotes are removed, and
 * invalid names are ignored. A missing file ends the job with code 126.
 */
export function envFileLoader(file: string): string {
  return [
    "__bbjobs_load_env() {",
    "  local line key val",
    "  while IFS= read -r line || [ -n \"$line\" ]; do",
    "    line=\"${line%$'\\r'}\"",
    "    case \"$line\" in ''|'#'*) continue ;; esac",
    "    line=\"${line#export }\"",
    "    key=\"${line%%=*}\"; val=\"${line#*=}\"",
    "    [ \"$key\" = \"$line\" ] && continue",
    "    case \"$key\" in [A-Za-z_]*) ;; *) continue ;; esac",
    "    case \"$key\" in *[!A-Za-z0-9_]*) continue ;; esac",
    "    case \"$val\" in \\\"*\\\"|\\'*\\') val=\"${val:1:${#val}-2}\" ;; esac",
    "    export \"$key=$val\"",
    "  done < \"$1\"",
    "}",
    `__bbjobs_load_env ${shellQuote(file)} || { echo "[jobs] cannot read --env-file ${file.replace(/[^\w./-]/g, "?")}" >&2; exit 126; }`,
    "unset -f __bbjobs_load_env",
    "",
  ].join("\n");
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
  logMaxBytes?: number;
  threadId: string | null;
  /** 2 for jobs started by 0.2.0+ (process ownership by launch lines). */
  format?: number;
  /** requestFingerprint of a keyed start (0.5.2+). */
  keyFingerprint?: string;
}

export type LogsResult = {
  job: Job;
  text: string;
  truncated: boolean;
  cursor: number;
  skippedBytes: number;
};

export type ReadyResult = {
  outcome: "ready" | "exited" | "timeout";
  waitedMs: number;
  detail: string;
  job: Job;
};

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
  rm -f -- "$dir/env.sh"
  echo "$1" >"$dir/exit.tmp" && mv -f "$dir/exit.tmp" "$dir/exit"
  exit "$1"
}
export BBJOBS_ENV_FILE="$dir/env.sh"
cd -- "$(cat "$dir/cwd")" 2>>"$log" || { echo "[jobs] cannot cd into $(cat "$dir/cwd")" >>"$log"; finish 127; }
echo "[jobs] started $(date -u +%Y-%m-%dT%H:%M:%SZ) pid $$ in $PWD" >>"$log"
t="$(cat "$dir/timeout" 2>/dev/null)"
max="$(cat "$dir/log-max" 2>/dev/null)"
if command -v perl >/dev/null 2>&1; then
  exec perl "$dir/exec.pl" "$dir" "\${max:-0}" "\${t:-0}" bash "$dir/command.sh"
fi
[ -n "$t" ] && { echo "[jobs] --timeout needs perl on this machine" >>"$log"; finish 125; }
echo "[jobs] perl not found: the output log is not size-limited" >>"$log"
bash "$dir/command.sh" >>"$log" 2>&1 </dev/null
code=$?
echo "[jobs] exited $code at $(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$log"
finish "$code"
`;

// Runs the command in its own process group with stdout/stderr on a pipe,
// copies the pipe into output.log (rotating to output.log.1 at the cap),
// signals the group on timeout and records the exit code as soon as the
// command ends. It keeps copying until every writer closes the pipe, so a
// daemon the command left behind does not die of SIGPIPE.
const EXEC_PL = String.raw`use strict;
use warnings;
use POSIX ();
umask(077);
my ($dir, $max, $timeout, @cmd) = @ARGV;
my $log = "$dir/output.log";
my $fh;
sub reopen { open($fh, '>>', $log) or die "cannot open $log: $!"; my $o = select($fh); $| = 1; select($o); }
sub stamp { POSIX::strftime('%Y-%m-%dT%H:%M:%SZ', gmtime) }
my $atlinestart = 1;
sub note { print $fh "\n" unless $atlinestart; print $fh "[jobs] $_[0]\n"; $atlinestart = 1; }
sub put {
  print $fh $_[0];
  $atlinestart = substr($_[0], -1) eq "\n";
  if ($max > 0 && tell($fh) >= $max) {
    close $fh;
    # log-base = bytes written before output.log; readers map cursors with it.
    my $base = 0;
    if (open(my $b, '<', "$dir/log-base")) { $base = int(<$b> // 0); close $b; }
    $base += -s $log;
    if (open(my $b, '>', "$dir/log-base.tmp")) { print $b "$base\n"; close $b; }
    rename $log, "$log.1";
    rename "$dir/log-base.tmp", "$dir/log-base";
    reopen();
    $atlinestart = 1;
    note("log reached $max bytes, previous part moved to output.log.1 at " . stamp());
  }
}
sub finish {
  my $code = shift;
  note("exited $code at " . stamp());
  unlink "$dir/env.sh";
  open(my $e, '>', "$dir/exit.tmp") or return;
  print $e "$code\n";
  close $e;
  rename "$dir/exit.tmp", "$dir/exit";
}
reopen();
pipe(my $r, my $w) or die "pipe: $!";
my $pid = fork();
die "fork: $!" unless defined $pid;
if ($pid == 0) {
  close $r;
  setpgrp(0, 0);
  open(STDIN, '<', '/dev/null');
  open(STDOUT, '>&', $w);
  open(STDERR, '>&', $w);
  close $w;
  exec(@cmd) or do { print STDERR "exec failed: $!\n"; POSIX::_exit(127); };
}
close $w;
if (open(my $g, '>', "$dir/pgid")) { print $g "$pid\n"; close $g; }
my $deadline = $timeout > 0 ? time() + $timeout : 0;
my ($killat, $timedout, $code, $eof) = (0, 0, undef, 0);
my $rin = '';
vec($rin, fileno($r), 1) = 1;
for (;;) {
  if (!defined $code) {
    if (waitpid($pid, POSIX::WNOHANG()) == $pid) {
      $code = POSIX::WIFEXITED($?) ? POSIX::WEXITSTATUS($?) : 128 + POSIX::WTERMSIG($?);
      $code = 124 if $timedout;
      # Everything the command wrote before exiting is already in the pipe:
      # log it before the exit line. Do not wait for leftover children.
      while (!$eof) {
        my $ready = select(my $rout = $rin, undef, undef, 0);
        last unless $ready > 0;
        my $got = sysread($r, my $buf, 65536);
        if ($got) { put($buf) } else { $eof = 1 }
      }
      finish($code);
    } elsif ($deadline && !$timedout && time() >= $deadline) {
      $timedout = 1;
      note("timed out after " . $timeout . "s, sending SIGTERM");
      kill 'TERM', -$pid;
      $killat = time() + 15;
    } elsif ($killat && time() >= $killat) {
      kill 'KILL', -$pid;
      $killat = 0;
    }
  }
  last if $eof && defined $code;
  if (!$eof) {
    my $n = select(my $rout = $rin, undef, undef, 0.5);
    if ($n > 0) {
      my $got = sysread($r, my $buf, 65536);
      if ($got) { put($buf) } else { $eof = 1 }
    }
  } else {
    select(undef, undef, undef, 0.1);
  }
}
exit $code;
`;

// First lines of every command.sh: load the --env values in the job's own
// shell and delete the file before the user's command runs.
const ENV_PRELUDE = `if [ -n "\${BBJOBS_ENV_FILE:-}" ] && [ -f "$BBJOBS_ENV_FILE" ]; then . "$BBJOBS_ENV_FILE"; rm -f -- "$BBJOBS_ENV_FILE"; fi
unset BBJOBS_ENV_FILE
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
  archiveDir(): string {
    return path.join(this.root, "archive");
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

  /**
   * start() plus warnings about the machine that the caller should see. With
   * a key, a job already started under that key is returned instead
   * (`reused`), so a retry after a lost answer never starts a second job.
   */
  async startWithChecks(
    input: StartInput,
  ): Promise<Job & { warnings: string[]; reused: boolean }> {
    let job: Job;
    let reused = false;
    if (input.key) {
      // Starts with one key run one after another in this process; there is
      // no timeout after which a pending start is assumed dead.
      const hash = keyHash(input.key);
      const previous = this.keyLocks.get(hash) ?? Promise.resolve();
      const mine = previous.then(() => this.startKeyed(input, hash));
      const tail = mine.catch(() => undefined);
      this.keyLocks.set(hash, tail);
      try {
        ({ job, reused } = await mine);
      } finally {
        if (this.keyLocks.get(hash) === tail) this.keyLocks.delete(hash);
      }
    } else {
      job = await this.start(input);
    }
    const warnings: string[] = [];
    if (job.mode === "systemd") {
      const linger = await lingerEnabled();
      if (linger === false) {
        const user = process.env.USER ?? "$USER";
        warnings.push(
          `loginctl reports Linger=no for ${user}: systemd stops this user's jobs when the last login session ends. Run once on this machine: sudo loginctl enable-linger ${user}`,
        );
      }
    }
    return { ...job, warnings, reused };
  }

  private readonly keyLocks = new Map<string, Promise<unknown>>();

  private claimPath(hash: string): string {
    return path.join(this.root, "keys", hash);
  }

  /**
   * One keyed start, run while holding this process's lock for the key.
   *
   * keys/<sha256 of key> holds {state, pid, jobId, fingerprint}:
   * - none: claim it ("pending" with our pid), start, then record "done".
   * - "done" and the job still exists: reuse it if the request matches
   *   (key_conflict otherwise); a pruned job frees the key.
   * - "pending" by another live process: key_busy (never taken over).
   * - "pending" by a dead process, or by this process outside the lock (a
   *   start that failed half-way): look for the job directory marked with
   *   the key. None: nothing was started, claim again. With meta.json: adopt
   *   it. Without meta.json: key_unknown; `release-key` after inspection.
   */
  private async startKeyed(
    input: StartInput,
    hash: string,
  ): Promise<{ job: Job; reused: boolean }> {
    await mkdir(path.join(this.root, "keys"), { recursive: true, mode: 0o700 });
    const file = this.claimPath(hash);
    const fingerprint = requestFingerprint(input);
    const claim = await readClaim(file);
    if (claim) {
      if (claim.state === "done" && claim.jobId) {
        if (existsSync(path.join(this.dir(claim.jobId), "meta.json"))) {
          return { job: await this.reuse(claim.jobId, claim.fingerprint, fingerprint, input.key!), reused: true };
        }
        // That job was pruned: the key is free again.
      } else if (claim.state === "pending") {
        if (claim.pid !== process.pid && pidAlive(claim.pid)) {
          throw new Error(
            `key_busy: a start with --key ${input.key} is in progress in process ${claim.pid}; try again later`,
          );
        }
        const found = await this.findKeyedJob(hash);
        if (found?.hasMeta) {
          await writeClaim(file, { state: "done", pid: process.pid, jobId: found.id, fingerprint: claim.fingerprint });
          return { job: await this.reuse(found.id, claim.fingerprint, fingerprint, input.key!), reused: true };
        }
        if (found) {
          throw new Error(
            `key_unknown: a start with --key ${input.key} stopped half-way and left ${this.dir(found.id)} without meta.json; check whether its command ran, then run bb jobs release-key`,
          );
        }
        // No job directory: that start never got as far as running anything.
      }
    }
    const pending: Claim = { state: "pending", pid: process.pid, jobId: null, fingerprint };
    if (claim) {
      await writeClaim(file, pending); // checked above: free to take
    } else {
      // No claim yet: create it atomically, in case another process races us.
      try {
        const handle = await open(file, "wx", 0o600);
        await handle.writeFile(JSON.stringify(pending));
        await handle.close();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        throw new Error(
          `key_busy: another process claimed --key ${input.key} at the same moment; try again`,
        );
      }
    }
    let job: Job;
    try {
      job = await this.start({ ...input, keyHash: hash });
    } catch (error) {
      // If start() created a job directory, the claim stays pending and the
      // next attempt reconciles it from that directory.
      if (!(await this.findKeyedJob(hash))) await rm(file, { force: true });
      throw error;
    }
    await writeClaim(file, { state: "done", pid: process.pid, jobId: job.id, fingerprint });
    return { job, reused: false };
  }

  private async reuse(
    jobId: string,
    recorded: string | null,
    fingerprint: string,
    key: string,
  ): Promise<Job> {
    // The job's own record wins over the claim file.
    const meta = await this.readMeta(jobId);
    const expected = meta.keyFingerprint ?? recorded;
    if (expected && expected !== fingerprint) {
      throw new Error(
        `key_conflict: --key ${key} was used for a different request (command, directory, environment, env file, limits or timeout) by job ${jobId}; use a new key`,
      );
    }
    return this.get(jobId);
  }

  /** The job directory whose `key` marker holds this key hash, if any. */
  private async findKeyedJob(hash: string): Promise<{ id: string; hasMeta: boolean } | null> {
    for (const id of await readdir(this.jobsDir()).catch(() => [] as string[])) {
      const marker = await readFile(path.join(this.dir(id), "key"), "utf8").catch(() => null);
      if (marker?.trim() === hash) {
        return { id, hasMeta: existsSync(path.join(this.dir(id), "meta.json")) };
      }
    }
    return null;
  }

  /**
   * Free a key after a human checked a key_unknown/key_busy state: the claim
   * file is renamed, never deleted.
   */
  async releaseKey(key: string): Promise<{ released: boolean; state: string; backup: string | null }> {
    const file = this.claimPath(keyHash(key));
    const claim = await readClaim(file);
    if (!claim) return { released: false, state: "none", backup: null };
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
    const backup = `${file}.bak-${stamp}`;
    await rename(file, backup);
    return { released: true, state: claim.state, backup };
  }

  async start(input: StartInput): Promise<Job> {
    if (process.platform === "win32") {
      throw new Error(
        "bb jobs needs a POSIX machine (Linux or macOS; WSL works). Native Windows is not supported.",
      );
    }
    await mkdir(this.jobsDir(), { recursive: true, mode: 0o700 });
    const cwdStat = await stat(input.cwd).catch(() => null);
    if (!cwdStat?.isDirectory()) {
      throw new Error(`working directory does not exist: ${input.cwd}`);
    }
    if (input.envFile) {
      if (!path.isAbsolute(input.envFile)) {
        throw new Error(`--env-file must be an absolute path on the job's machine: ${input.envFile}`);
      }
      const envStat = await stat(input.envFile).catch(() => null);
      if (!envStat?.isFile()) throw new Error(`--env-file not found: ${input.envFile}`);
      if (envStat.mode & 0o077) {
        throw new Error(
          `--env-file ${input.envFile} is readable or writable by other users (mode ${(envStat.mode & 0o777).toString(8)}); run chmod 600 on it. The job was not started`,
        );
      }
    }
    if (input.memoryMax && !MEMORY_MAX_PATTERN.test(input.memoryMax)) {
      throw new Error(`bad --memory-max ${input.memoryMax}: use bytes with K/M/G/T, or a percentage`);
    }
    if (input.cpuQuota && !CPU_QUOTA_PATTERN.test(input.cpuQuota)) {
      throw new Error(`bad --cpu-quota ${input.cpuQuota}: use a percentage such as 150%`);
    }
    const limits = [
      input.memoryMax ? `MemoryMax=${input.memoryMax}` : null,
      input.cpuQuota ? `CPUQuota=${input.cpuQuota}` : null,
      input.tasksMax ? `TasksMax=${input.tasksMax}` : null,
    ].filter((l): l is string => l !== null);
    if ((limits.length || input.requireSystemd) && !(await this.hasSystemd())) {
      throw new Error(
        limits.length
          ? "--memory-max, --cpu-quota and --tasks-max need user systemd, which this machine does not have; the job was not started"
          : "user systemd is not available on this machine and --require-systemd forbids detached mode; the job was not started",
      );
    }
    const id = `${slug(input.name)}-${randomBytes(3).toString("hex")}`;
    const logMaxBytes = input.logMaxBytes ?? DEFAULT_LOG_MAX_BYTES;
    const dir = this.dir(id);
    await mkdir(dir, { mode: 0o700 });
    // Written before anything can run, so a keyed start that dies half-way
    // can be found again (see startKeyed).
    if (input.keyHash) await writeFile(path.join(dir, "key"), input.keyHash, { mode: 0o600 });
    // Per-job copies: bash reads a script while it runs, so a shared runner
    // rewritten by a later start could corrupt jobs already running.
    const runner = path.join(dir, "runner.sh");
    await writeFile(runner, RUNNER, { mode: 0o700 });
    await writeFile(path.join(dir, "exec.pl"), EXEC_PL, { mode: 0o600 });
    const envFile = path.join(dir, "env.sh");
    const exports = Object.entries(input.env)
      .map(([key, value]) => `export ${key}=${shellQuote(value)}\n`)
      .join("");
    if (exports) await writeFile(envFile, exports, { mode: 0o600 });
    await writeFile(
      path.join(dir, "command.sh"),
      `${ENV_PRELUDE}${input.envFile ? envFileLoader(input.envFile) : ""}${input.command}\n`,
      { mode: 0o600 },
    );
    await writeFile(path.join(dir, "cwd"), input.cwd);
    if (input.timeoutSec !== null) {
      await writeFile(path.join(dir, "timeout"), String(input.timeoutSec));
    }
    await writeFile(path.join(dir, "log-max"), String(logMaxBytes));
    await writeFile(path.join(dir, "output.log"), "", { mode: 0o600 });

    const base = userEnv();
    const inherited: Record<string, string> = {};
    for (const key of INHERITED_ENV) {
      const value = base[key];
      if (value) inherited[key] = value;
    }
    for (const [key, value] of Object.entries(input.bbEnv ?? {})) {
      if (/^BB_[A-Z_]+$/.test(key)) inherited[key] = value;
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
        ...limits.map((l) => `--property=${l}`),
        ...Object.entries(inherited).map(([k, v]) => `--setenv=${k}=${v}`),
        "--",
        "/bin/bash",
        runner,
        dir,
      ];
      try {
        await run("systemd-run", args, { env: base, timeout: 15000 });
      } catch (error) {
        await rm(envFile, { force: true });
        throw new Error(`systemd-run failed: ${errorText(error)}`);
      }
      pid = await this.unitMainPid(unit);
    } else {
      mode = "detached";
      // detached: true makes the child a session + process-group leader, so
      // it outlives this worker.
      const child = spawn("/bin/bash", [runner, dir], {
        cwd: input.cwd,
        detached: true,
        stdio: "ignore",
        env: inherited,
      });
      pid = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("spawn", () => resolve(child.pid ?? -1));
      }).catch(async (error: unknown) => {
        await rm(envFile, { force: true });
        throw error;
      });
      child.unref();
      // Until the fork has exec'd bash, ps shows it as node and the job
      // would read as "lost". Wait briefly until it is recognisable.
      const deadline = Date.now() + 3000;
      while (
        Date.now() < deadline &&
        !existsSync(path.join(dir, "exit")) &&
        (await ownedProcesses(dir, { createdAt: new Date().toISOString() })).size === 0
      ) {
        await sleep(50);
      }
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
      logMaxBytes,
      threadId: input.threadId,
      format: 2,
      ...(input.keyHash ? { keyFingerprint: requestFingerprint(input) } : {}),
    };
    await writeFile(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2), {
      mode: 0o600,
    });
    return this.get(id);
  }

  /** Newest first; with `threadId`, only jobs started from that thread. */
  async list(limit: number, threadId: string | null = null): Promise<Job[]> {
    const metas = (await this.readAllMeta()).filter(
      (m) => threadId === null || m.threadId === threadId,
    );
    metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return Promise.all(metas.slice(0, limit).map((m) => this.describe(m)));
  }

  async get(id: string): Promise<Job> {
    return this.describe(await this.readMeta(id));
  }

  /**
   * Without `since`: the last `maxBytes` of output. With `since` (a cursor
   * from an earlier call): up to `maxBytes` of output after it, ending on a
   * line boundary while the job runs. `cursor` is where the next call should
   * continue; it counts bytes from the job's start, across log rotations.
   * Output is cleaned of terminal escape codes unless `raw`.
   */
  async logs(
    id: string,
    maxBytes: number,
    options: { since?: number | null; raw?: boolean } = {},
  ): Promise<LogsResult> {
    const job = await this.get(id);
    const dir = path.dirname(job.logPath);
    const base = Number.parseInt(
      await readFile(path.join(dir, "log-base"), "utf8").catch(() => "0"),
      10,
    ) || 0;
    const currentSize = (await stat(job.logPath).catch(() => null))?.size ?? 0;
    const previousSize = (await stat(`${job.logPath}.1`).catch(() => null))?.size ?? 0;
    const end = base + currentSize;
    const finish = (text: string, truncated: boolean, cursor: number, skippedBytes = 0) => ({
      job,
      text: options.raw ? text : cleanTerminalText(text),
      truncated,
      cursor,
      skippedBytes,
    });

    if (options.since === undefined || options.since === null) {
      const current = await readTail(job.logPath, maxBytes);
      let text = current.text;
      let truncated = current.clipped;
      // After a rotation the newest part may be short; fill from output.log.1.
      if (!truncated && current.bytes < maxBytes) {
        const previous = await readTail(`${job.logPath}.1`, maxBytes - current.bytes).catch(
          () => null,
        );
        if (previous && previous.bytes > 0) {
          text = previous.text + text;
          truncated = previous.clipped;
        }
      }
      return finish(text, truncated, end);
    }

    const previousStart = base - previousSize;
    let since = Math.min(Math.max(0, options.since), end);
    let skippedBytes = 0;
    if (since < previousStart) {
      // That output was rotated away for good.
      skippedBytes = previousStart - since;
      since = previousStart;
    }
    const chunks: Buffer[] = [];
    let want = maxBytes;
    if (since < base) {
      const part = await readRange(`${job.logPath}.1`, since - previousStart, want);
      chunks.push(part);
      want -= part.length;
    }
    if (want > 0) {
      const from = Math.max(0, since - base);
      const part = await readRange(job.logPath, from, want);
      chunks.push(part);
    }
    let buffer = Buffer.concat(chunks);
    const atEnd = since + buffer.length >= end;
    if (!atEnd || job.state === "running") {
      // Return whole lines only; the rest comes with the next call.
      const lastNewline = buffer.lastIndexOf(0x0a);
      if (lastNewline >= 0) buffer = buffer.subarray(0, lastNewline + 1);
      else if (atEnd) buffer = buffer.subarray(0, 0); // unfinished line: wait
      // else: one line longer than maxBytes; return it in pieces
    }
    return finish(buffer.toString("utf8"), !atEnd, since + buffer.length, skippedBytes);
  }

  async stop(id: string): Promise<Job> {
    const meta = await this.readMeta(id);
    const dir = this.dir(id);
    if (!(await this.isAlive(meta))) return this.describe(meta);
    await writeFile(path.join(dir, "stop-requested"), new Date().toISOString());
    const logFile = path.join(dir, "output.log");
    const newline = (await endsWithNewline(logFile)) ? "" : "\n";
    await appendFile(
      logFile,
      `${newline}[jobs] stop requested at ${new Date().toISOString()}\n`,
    );
    if (meta.mode === "systemd" && meta.unit) {
      // Stops every process in the unit's cgroup: SIGTERM, then SIGKILL
      // after TimeoutStopSec. Blocks until the unit is down.
      await run("systemctl", ["--user", "stop", meta.unit], {
        env: userEnv(),
        timeout: 30000,
      }).catch(() => undefined);
    } else {
      await this.signalDetached(meta, "SIGTERM");
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && (await this.isAlive(meta))) {
        await sleep(250);
      }
      if (await this.isAlive(meta)) await this.signalDetached(meta, "SIGKILL");
    }
    return this.describe(meta);
  }

  /**
   * Wait until the job answers on `url` (2xx after redirects) or prints a
   * line matching `logPattern`. Stops early when the job ends.
   */
  async ready(
    id: string,
    check: { url: string | null; logPattern: string | null },
    timeoutMs: number,
  ): Promise<ReadyResult> {
    const pattern = check.logPattern ? new RegExp(check.logPattern, "m") : null;
    const started = Date.now();
    let lastProblem = "no check passed yet";
    for (;;) {
      const waitedMs = Date.now() - started;
      if (check.url) {
        try {
          const res = await fetch(check.url, {
            signal: AbortSignal.timeout(3000),
            redirect: "follow",
          });
          await res.body?.cancel();
          if (res.ok) {
            return { outcome: "ready", waitedMs, detail: `${check.url} answered ${res.status}`, job: await this.get(id) };
          }
          lastProblem = `${check.url} answered ${res.status}`;
        } catch (error) {
          lastProblem = `${check.url}: ${errorText(error)}`;
        }
      }
      if (pattern) {
        const { text } = await this.logs(id, 256 * 1024); // escape codes removed
        const match = text.match(pattern);
        if (match) {
          const line = text.slice(0, match.index! + match[0].length).split("\n").pop()!;
          return { outcome: "ready", waitedMs, detail: `log matched: ${line.slice(0, 200)}`, job: await this.get(id) };
        }
        if (!check.url) lastProblem = `no log line matches /${check.logPattern}/`;
      }
      const job = await this.get(id);
      if (job.state !== "running") {
        return { outcome: "exited", waitedMs, detail: `job ${job.state} before it was ready (${lastProblem})`, job };
      }
      if (waitedMs >= timeoutMs) {
        return { outcome: "timeout", waitedMs, detail: lastProblem, job };
      }
      await sleep(Math.min(1000, Math.max(0, timeoutMs - waitedMs)));
    }
  }

  /**
   * Move finished jobs older than `olderThanMs` to <root>/archive/, or delete
   * them with `remove`. Running jobs are never touched.
   */
  async prune(
    olderThanMs: number,
    options: { remove: boolean; dryRun: boolean },
  ): Promise<{ pruned: { id: string; bytes: number }[]; archiveDir: string }> {
    const cutoff = Date.now() - olderThanMs;
    const pruned: { id: string; bytes: number }[] = [];
    for (const meta of await this.readAllMeta()) {
      const job = await this.describe(meta);
      if (job.state === "running") continue;
      const ended = Date.parse(job.finishedAt ?? job.createdAt);
      if (ended > cutoff) continue;
      const dir = this.dir(meta.id);
      const bytes = await dirSize(dir);
      if (!options.dryRun) {
        if (options.remove) {
          await rm(dir, { recursive: true, force: true });
        } else {
          await mkdir(this.archiveDir(), { recursive: true, mode: 0o700 });
          await rename(dir, path.join(this.archiveDir(), meta.id));
        }
      }
      pruned.push({ id: meta.id, bytes });
    }
    return { pruned, archiveDir: this.archiveDir() };
  }

  private async readAllMeta(): Promise<JobMeta[]> {
    const names = await readdir(this.jobsDir()).catch(() => [] as string[]);
    const metas: JobMeta[] = [];
    for (const name of names) {
      const meta = await this.readMeta(name).catch(() => null);
      if (meta) metas.push(meta);
    }
    return metas;
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
    if (meta.format === 2) {
      return (await ownedProcesses(this.dir(meta.id), meta)).size > 0;
    }
    return meta.pid !== null && legacyGroupAlive(meta.pid);
  }

  /** Signal only processes that provably belong to the job. */
  private async signalDetached(
    meta: JobMeta,
    signal: NodeJS.Signals,
  ): Promise<void> {
    if (meta.format !== 2) {
      // 0.1.x job: best effort on its recorded group.
      if (meta.pid && legacyGroupAlive(meta.pid)) {
        try {
          process.kill(-meta.pid, signal);
        } catch {}
      }
      return;
    }
    for (const pid of await ownedProcesses(this.dir(meta.id), meta)) {
      try {
        process.kill(pid, signal);
      } catch {}
    }
  }

  private async describe(meta: JobMeta): Promise<Job> {
    const dir = this.dir(meta.id);
    const readExit = async () => {
      const raw = await readFile(path.join(dir, "exit"), "utf8").catch(() => null);
      const code = raw === null ? null : Number.parseInt(raw, 10);
      return code !== null && Number.isFinite(code) ? code : null;
    };
    let exitCode = await readExit();
    // The job can write its exit code and end between the read above and the
    // process check below; read again before calling it lost.
    const alive = exitCode === null && (await this.isAlive(meta));
    if (exitCode === null && !alive) exitCode = await readExit();
    const stopRequested = existsSync(path.join(dir, "stop-requested"));
    let state: JobState;
    let finishedAt: string | null = null;
    if (exitCode !== null) {
      state = stopRequested ? "stopped" : "exited";
      finishedAt = (await stat(path.join(dir, "exit"))).mtime.toISOString();
    } else if (alive) {
      state = "running";
    } else {
      state = stopRequested ? "stopped" : "lost";
      const log = await stat(path.join(dir, "output.log")).catch(() => null);
      finishedAt = log ? log.mtime.toISOString() : null;
    }
    // A job killed before it read its --env file must not leave it behind.
    if (state !== "running") await rm(path.join(dir, "env.sh"), { force: true });
    return {
      id: meta.id,
      name: meta.name,
      command: meta.command,
      cwd: meta.cwd,
      mode: meta.mode,
      unit: meta.unit,
      pid: meta.pid,
      state,
      exitCode,
      createdAt: meta.createdAt,
      finishedAt,
      timeoutSec: meta.timeoutSec,
      logMaxBytes: meta.logMaxBytes ?? null,
      threadId: meta.threadId,
      logPath: path.join(dir, "output.log"),
    };
  }
}

/**
 * Is this `ps` command line one of the job's own processes? The interpreter
 * may show up under its full or versioned path (macOS can re-execute
 * /usr/bin/perl as perl5.x); the job's own files must match exactly.
 */
export function isLaunchLine(command: string, dir: string): boolean {
  const escaped = dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    new RegExp(`^\\S*bash ${escaped}/runner\\.sh ${escaped}$`),
    new RegExp(`^\\S*bash ${escaped}/command\\.sh$`),
    new RegExp(`^\\S*perl[\\d.]* ${escaped}/exec\\.pl `),
  ].some((pattern) => pattern.test(command));
}

/**
 * PIDs that belong to the job: its own launch lines and everything descending
 * from them; plus members of the command's process group that started no
 * earlier than the job, but only while that group's leader is the job's own
 * process or gone (children left behind after the command exited). A live
 * leader that is not ours means the group id was reused by a stranger.
 */
async function ownedProcesses(
  dir: string,
  meta: Pick<JobMeta, "createdAt">,
): Promise<Set<number>> {

  const pgidRaw = await readFile(path.join(dir, "pgid"), "utf8").catch(() => "");
  const commandGroup = Number.parseInt(pgidRaw, 10);
  // lstart has 1 s resolution; allow for it.
  const jobStart = Date.parse(meta.createdAt) - 2000;
  const out = await run("ps", ["-A", "-ww", "-o", "pid=,ppid=,pgid=,lstart=,command="], {
    timeout: 5000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C", LANG: "C" },
  }).catch(() => null);
  const owned = new Set<number>();
  if (!out) return owned;
  const children = new Map<number, number[]>();
  const seen = new Set<number>();
  const groupMembers: number[] = [];
  for (const line of out.stdout.split("\n")) {
    // lstart is five fields: "Sat Oct 24 14:11:33 2026"
    const m = line.match(
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s(.*)$/,
    );
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const pgid = Number(m[3]);
    const started = Date.parse(m[4]!);
    const command = m[5]!.trim();
    if (pid === process.pid) continue;
    seen.add(pid);
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
    if (isLaunchLine(command, dir)) {
      owned.add(pid);
    } else if (
      Number.isFinite(commandGroup) &&
      pgid === commandGroup &&
      Number.isFinite(started) &&
      started >= jobStart
    ) {
      groupMembers.push(pid);
    }
  }
  const addDescendants = () => {
    const queue = [...owned];
    while (queue.length) {
      for (const child of children.get(queue.pop()!) ?? []) {
        if (!owned.has(child)) {
          owned.add(child);
          queue.push(child);
        }
      }
    }
  };
  addDescendants();
  if (groupMembers.length && (owned.has(commandGroup) || !seen.has(commandGroup))) {
    for (const pid of groupMembers) owned.add(pid);
    addDescendants();
  }
  return owned;
}

/** true/false from loginctl; null when it cannot tell (no logind, error). */
async function lingerEnabled(): Promise<boolean | null> {
  const user = typeof process.getuid === "function" ? String(process.getuid()) : null;
  if (!user) return null;
  const out = await run("loginctl", ["show-user", user, "-p", "Linger", "--value"], {
    timeout: 5000,
  }).catch(() => null);
  const value = out?.stdout.trim();
  return value === "yes" ? true : value === "no" ? false : null;
}

async function endsWithNewline(file: string): Promise<boolean> {
  const handle = await open(file, "r").catch(() => null);
  if (!handle) return true;
  try {
    const { size } = await handle.stat();
    if (size === 0) return true;
    const buf = Buffer.alloc(1);
    await handle.read(buf, 0, 1, size - 1);
    return buf[0] === 0x0a;
  } finally {
    await handle.close();
  }
}

function legacyGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// CSI (colours, cursor moves), OSC (titles, hyperlinks) and other ESC sequences.
const ANSI_PATTERN =
  /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/**
 * Text as a terminal would show it: no escape codes, and for lines redrawn
 * with carriage returns (progress bars) only the last version of the line.
 */
export function cleanTerminalText(text: string): string {
  return text
    .replace(ANSI_PATTERN, "")
    .split("\n")
    .map((line) => {
      const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
      const parts = trimmed.split("\r");
      for (let i = parts.length - 1; i >= 0; i--) if (parts[i] !== "") return parts[i];
      return "";
    })
    .join("\n");
}

async function readRange(file: string, from: number, maxBytes: number): Promise<Buffer> {
  const handle = await open(file, "r").catch(() => null);
  if (!handle) return Buffer.alloc(0);
  try {
    const { size } = await handle.stat();
    const length = Math.max(0, Math.min(maxBytes, size - from));
    const buffer = Buffer.alloc(length);
    if (length > 0) await handle.read(buffer, 0, length, from);
    return buffer;
  } finally {
    await handle.close();
  }
}

async function readTail(
  file: string,
  maxBytes: number,
): Promise<{ text: string; bytes: number; clipped: boolean }> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.toString("utf8");
    // Drop a partial first line (and a split UTF-8 char) when clipped.
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return { text, bytes: buffer.length, clipped: start > 0 };
  } finally {
    await handle.close();
  }
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const s = await stat(path.join(dir, name)).catch(() => null);
    if (s?.isFile()) total += s.size;
  }
  return total;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(error: unknown): string {
  const e = error as { stderr?: string; message?: string; cause?: { message?: string } };
  return (e.stderr || e.cause?.message || e.message || String(error)).trim();
}
