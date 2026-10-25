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
  link,
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
        cwd: path.resolve(input.cwd),
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

/**
 * One step in a key's history. "pending": a start is under way in process
 * `pid`; "done": it started `jobId`; "failed": it started nothing;
 * "released": freed by release-key.
 */
type Claim = {
  state: "pending" | "done" | "failed" | "released";
  pid: number;
  /** Start time of `pid` (see processStartToken); null for 0.5.x claims. */
  pidStart: string | null;
  jobId: string | null;
  fingerprint: string | null;
};

type Latest = { gen: number; claim: Claim | "corrupt" } | null;

const GEN_PATTERN = /^\d{8}$/;
// Compare-and-set rounds before giving up on a key that keeps changing.
const CLAIM_ATTEMPTS = 20;
const keepsChanging = (key: string) =>
  new Error(`key_busy: --key ${key} keeps changing under concurrent starts; try again`);

function parseClaim(raw: string): Claim | "corrupt" {
  const text = raw.trim();
  if (!text) return "corrupt";
  if (!text.startsWith("{")) {
    // 0.5.0/0.5.1: the job id alone, written once the job had started.
    return { state: "done", pid: -1, pidStart: null, jobId: text, fingerprint: null };
  }
  try {
    const claim = JSON.parse(text) as Partial<Claim>;
    if (!["pending", "done", "failed", "released"].includes(claim.state as string)) return "corrupt";
    return {
      state: claim.state!,
      pid: typeof claim.pid === "number" ? claim.pid : -1,
      pidStart: claim.pidStart ?? null,
      jobId: claim.jobId ?? null,
      fingerprint: claim.fingerprint ?? null,
    };
  } catch {
    return "corrupt";
  }
}

/**
 * A key's claims live in <root>/claims/<sha256>/ as numbered generations.
 * Every change creates the next number with link(), which fails if that
 * number exists: of several processes acting on the same generation exactly
 * one wins, and a file is never seen half-written. 0.5.x kept a single file
 * <root>/keys/<sha256>; it counts as generation 0.
 */
class ClaimLog {
  constructor(
    private readonly dir: string,
    private readonly legacyFile: string,
  ) {}

  async latest(): Promise<Latest> {
    const gens = (await readdir(this.dir).catch(() => [] as string[]))
      .filter((n) => GEN_PATTERN.test(n))
      .sort();
    const last = gens.at(-1);
    if (last) {
      const raw = await readFile(path.join(this.dir, last), "utf8").catch(() => "");
      return { gen: Number(last), claim: parseClaim(raw) };
    }
    const legacy = await readFile(this.legacyFile, "utf8").catch(() => null);
    return legacy === null ? null : { gen: 0, claim: parseClaim(legacy) };
  }

  /** Create generation `gen`; false if another process created it first. */
  async create(gen: number, claim: Claim): Promise<boolean> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = await this.writeTmp(claim);
    try {
      await link(tmp, this.genPath(gen));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    } finally {
      await rm(tmp, { force: true });
    }
  }

  /** Rewrite our own pending generation (no one else writes it). */
  async update(gen: number, claim: Claim): Promise<void> {
    await rename(await this.writeTmp(claim), this.genPath(gen));
  }

  private async writeTmp(claim: Claim): Promise<string> {
    const tmp = path.join(this.dir, `.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
    await writeFile(tmp, JSON.stringify(claim), { mode: 0o600 });
    return tmp;
  }

  genPath(gen: number): string {
    return path.join(this.dir, String(gen).padStart(8, "0"));
  }

  /** Where generation `gen` is stored (0 = the 0.5.x claim file). */
  recordPath(gen: number): string {
    return gen === 0 ? this.legacyFile : this.genPath(gen);
  }
}

/**
 * Identifies one run of a process, so a PID reused by another process is not
 * mistaken for the owner: the start time from /proc on Linux, from ps
 * elsewhere. null when it cannot be read.
 */
async function processStartToken(pid: number): Promise<string | null> {
  if (process.platform === "linux") {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => null);
    // Field 22 (starttime); the command name in field 2 may contain spaces.
    const fields = stat?.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields?.[19] ?? null;
  }
  const out = await run("ps", ["-o", "lstart=", "-p", String(pid)], {
    timeout: 5000,
    env: { ...process.env, LC_ALL: "C", LANG: "C" },
  }).catch(() => null);
  return out?.stdout.trim() || null;
}

/** Is the process that wrote this claim still running? */
async function ownerAlive(claim: Claim): Promise<boolean> {
  if (!pidAlive(claim.pid)) return false;
  if (!claim.pidStart) return true; // 0.5.2 claim: the PID is all we know
  const now = await processStartToken(claim.pid);
  return now === null || now === claim.pidStart;
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

// systemd rejects 0% CPU and kills a job at once with MemoryMax=0.
export const MEMORY_MAX_PATTERN = /^([1-9]\d*[KMGT]?|([1-9]\d?|100)%)$/i;
export const CPU_QUOTA_PATTERN = /^[1-9]\d{0,4}%$/;
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

// Keyed starts in this OS process, by root and key: every JobManager on one
// root shares them, so a pending claim of this process is never in flight
// outside the lock.
const keyLocks = new Map<string, Promise<unknown>>();

export class JobManager {
  private systemd: Promise<boolean> | null = null;

  constructor(
    private readonly root: string,
    private readonly options: {
      forceDetached?: boolean;
      /** Shell for detached jobs (tests point it at a missing file). */
      shell?: string;
    } = {},
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
    input = { ...input, cwd: path.resolve(input.cwd) };
    let job: Job;
    let reused = false;
    if (input.key) {
      // Starts with one key run one after another in this process; other
      // processes are kept out by the claim log (see startKeyed).
      const hash = keyHash(input.key);
      const lock = `${this.root}\0${hash}`;
      const previous = keyLocks.get(lock) ?? Promise.resolve();
      const mine = previous.then(() => this.startKeyed(input, hash));
      const tail = mine.catch(() => undefined);
      keyLocks.set(lock, tail);
      try {
        ({ job, reused } = await mine);
      } finally {
        if (keyLocks.get(lock) === tail) keyLocks.delete(lock);
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

  private ownStart: Promise<string | null> | null = null;

  private claims(hash: string): ClaimLog {
    return new ClaimLog(path.join(this.root, "claims", hash), path.join(this.root, "keys", hash));
  }

  private ownToken(): Promise<string | null> {
    return (this.ownStart ??= processStartToken(process.pid));
  }

  private async myClaim(state: Claim["state"], jobId: string | null, fingerprint: string | null): Promise<Claim> {
    return { state, pid: process.pid, pidStart: await this.ownToken(), jobId, fingerprint };
  }

  /** The job a "done" claim points at, if it still exists. */
  private jobOf(claim: Claim | "corrupt" | undefined): string | null {
    return claim && claim !== "corrupt" && claim.state === "done" && claim.jobId &&
      existsSync(path.join(this.dir(claim.jobId), "meta.json"))
      ? claim.jobId
      : null;
  }

  /**
   * One keyed start, run while holding this process's lock for the key.
   * The latest claim decides:
   * - none, "failed", "released", or "done" whose job was pruned: the key is
   *   free. Claim it ("pending"), start, then record "done" or "failed".
   * - "done" and the job exists: reuse it if the request matches
   *   (key_conflict otherwise).
   * - "pending" by another live process: key_busy (never taken over by time).
   * - "pending" by a dead process, or by this process outside the lock (a
   *   start that failed half-way): look at the job directory marked with the
   *   key. Started: adopt it. Never started, or none: claim again.
   *   Launched but unclear: key_unknown; `release-key` after inspection.
   * - unreadable: key_unknown.
   * Every change is a new generation that only one process can create; a
   * process that loses looks again.
   */
  private async startKeyed(
    input: StartInput,
    hash: string,
  ): Promise<{ job: Job; reused: boolean }> {
    const key = input.key!;
    const log = this.claims(hash);
    const fingerprint = requestFingerprint(input);
    for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
      const latest = await log.latest();
      const next = (latest?.gen ?? 0) + 1;
      const claim = latest?.claim;
      if (claim === "corrupt") {
        throw new Error(
          `key_unknown: the claim for --key ${key} cannot be read (${log.recordPath(latest!.gen)}); check bb jobs list --all for a job it started, then run bb jobs release-key`,
        );
      }
      const owned = this.jobOf(claim);
      if (owned) return { job: await this.reuse(owned, claim!.fingerprint, input), reused: true };
      if (claim?.state === "pending") {
        const mine = claim.pid === process.pid && claim.pidStart === (await this.ownToken());
        if (!mine && (await ownerAlive(claim))) {
          throw new Error(
            `key_busy: a start with --key ${key} is in progress in process ${claim.pid}; try again later`,
          );
        }
        const found = await this.findKeyedJob(hash);
        if (found?.status === "started") {
          if (!(await log.create(next, await this.myClaim("done", found.id, claim.fingerprint)))) continue;
          return { job: await this.reuse(found.id, claim.fingerprint, input), reused: true };
        }
        if (found?.status === "incomplete") {
          // The directory may belong to a start that claimed the key after
          // we read the claim and is launching right now: look again.
          if ((await log.latest())?.gen !== latest!.gen) continue;
          const listed = existsSync(path.join(this.dir(found.id), "meta.json"));
          throw new Error(
            `key_unknown: a start with --key ${key} stopped half-way and left ${listed ? `job ${found.id}` : this.dir(found.id)}; it may have run. Check ` +
              (listed ? `bb jobs status ${found.id}` : `that directory's output.log`) +
              (process.platform === "linux" ? ` and systemctl --user status bbjob-${found.id}` : "") +
              `, stop it if needed, then run bb jobs release-key`,
          );
        }
        // Not started, or no job directory: that start ran nothing.
      }
      const claimed = await log
        .create(next, await this.myClaim("pending", null, fingerprint))
        .catch((error: unknown) => {
          throw new Error(`start_refused: cannot record the claim for --key ${key}: ${errorText(error)}`);
        });
      if (!claimed) continue;
      let job: Job;
      try {
        job = await this.start({ ...input, keyHash: hash });
      } catch (error) {
        // Only a refusal proves that nothing ran. Any other error keeps the
        // claim pending; the next attempt reconciles it from the job
        // directory (adopts a started job, key_unknown when unclear).
        if (/^start_refused: /.test((error as Error).message)) {
          await log.update(next, await this.myClaim("failed", null, fingerprint));
        }
        throw error;
      }
      await log.update(next, await this.myClaim("done", job.id, fingerprint));
      return { job, reused: false };
    }
    throw keepsChanging(key);
  }

  private async reuse(jobId: string, recorded: string | null, input: StartInput): Promise<Job> {
    // The job's own record wins over the claim.
    const meta = await this.readMeta(jobId);
    const expected = meta.keyFingerprint ?? recorded;
    const matches = expected
      ? expected === requestFingerprint(input)
      : // 0.5.0/0.5.1 kept no fingerprint: compare what the job recorded.
        meta.command === input.command && path.resolve(meta.cwd) === input.cwd;
    if (!matches) {
      throw new Error(
        `key_conflict: --key ${input.key} was used for a different request (command, directory, environment, env file path, limits or timeout) by job ${jobId}; use a new key`,
      );
    }
    return this.get(jobId);
  }

  /**
   * The job directory whose `key` marker holds this key hash. A started job
   * wins over a half-way one, which wins over one that never started; among
   * equals, the newest.
   */
  private async findKeyedJob(
    hash: string,
  ): Promise<{ id: string; status: "started" | "incomplete" | "not-started" } | null> {
    let best: { id: string; status: "started" | "incomplete" | "not-started"; born: number } | null = null;
    const rank = { started: 3, incomplete: 2, "not-started": 1 } as const;
    for (const id of await this.markedDirs(hash)) {
      const status = await this.launchStatus(id);
      const meta = await this.readMeta(id).catch(() => null);
      const dirStat = await stat(this.dir(id)).catch(() => null);
      const born = meta ? Date.parse(meta.createdAt) : dirStat?.birthtimeMs || dirStat?.ctimeMs || 0;
      if (
        !best ||
        rank[status] > rank[best.status] ||
        (rank[status] === rank[best.status] && born > best.born)
      ) {
        best = { id, status, born };
      }
    }
    return best && { id: best.id, status: best.status };
  }

  /** Job directories marked with this key hash. */
  private async markedDirs(hash: string): Promise<string[]> {
    const ids: string[] = [];
    for (const id of await readdir(this.jobsDir()).catch(() => [] as string[])) {
      const marker = await readFile(path.join(this.dir(id), "key"), "utf8").catch(() => null);
      if (marker?.trim() === hash) ids.push(id);
    }
    return ids;
  }

  /**
   * Did this job's command start? An exit code, or meta.json without a
   * `launch` file: yes. `launch` = not-started, or launching without
   * meta.json (meta.json is written before the launch): no. `launch` =
   * launching: yes while it runs, otherwise unknown. No meta.json and no
   * `launch` (a 0.5.2 start that stopped half-way): unknown.
   */
  private async launchStatus(id: string): Promise<"started" | "incomplete" | "not-started"> {
    const dir = this.dir(id);
    if (existsSync(path.join(dir, "exit"))) return "started";
    const launch = await this.readLaunch(id);
    const meta = await this.readMeta(id).catch(() => null);
    if (launch === "not-started" || (launch === "launching" && !meta)) return "not-started";
    if (meta && launch === undefined) return "started";
    if (meta && (await this.isAlive(meta))) return "started";
    return "incomplete";
  }

  /**
   * Free a key after checking a key_unknown state, so the next start runs
   * the command again. Without `force` it is refused while the key may still
   * lead to a live or existing job: a start in progress in a live process, a
   * job the key started, or a marked job directory whose command started.
   * Nothing is deleted: a "released" generation is added to the key's
   * history, and every job directory marked with the key loses its marker
   * (renamed), so none of them is adopted later.
   */
  async releaseKey(
    key: string,
    options: { force?: boolean } = {},
  ): Promise<{ released: boolean; state: string; backup: string | null }> {
    const hash = keyHash(key);
    const log = this.claims(hash);
    for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
      const latest = await log.latest();
      if (!latest) return { released: false, state: "none", backup: null };
      const claim = latest.claim === "corrupt" ? null : latest.claim;
      const state = claim?.state ?? "unreadable";
      if (claim?.state === "failed" || claim?.state === "released") {
        return { released: false, state, backup: null };
      }
      if (!options.force) {
        const refuse = (why: string) =>
          new Error(
            `key_in_use: --key ${key} ${why}; releasing it lets the same command run again. Add --force if that is intended`,
          );
        if (claim?.state === "pending" && (await ownerAlive(claim))) {
          throw refuse(`has a start in progress in process ${claim.pid}; wait for it`);
        }
        const owned = this.jobOf(latest.claim);
        if (owned) {
          const job = await this.get(owned);
          throw refuse(`belongs to job ${job.id} (${job.state})`);
        }
        const found = await this.findKeyedJob(hash);
        if (found?.status === "started") {
          throw refuse(`started job ${found.id}, which a retry with the key returns`);
        }
      }
      if (!(await log.create(latest.gen + 1, await this.myClaim("released", null, null)))) continue;
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
      for (const id of await this.markedDirs(hash)) {
        const marker = path.join(this.dir(id), "key");
        await rename(marker, `${marker}.released-${stamp}`).catch(() => undefined);
      }
      return { released: true, state, backup: log.recordPath(latest.gen) };
    }
    throw keepsChanging(key);
  }

  /**
   * Start a job. Errors that start with "start_refused:" mean nothing ran;
   * any other error leaves it open whether the command started.
   */
  async start(input: StartInput): Promise<Job> {
    const refuse = (message: string) => new Error(`start_refused: ${message}`);
    if (process.platform === "win32") {
      throw refuse("bb jobs needs a POSIX machine (Linux or macOS; WSL works). Native Windows is not supported.");
    }
    await mkdir(this.jobsDir(), { recursive: true, mode: 0o700 });
    const cwdStat = await stat(input.cwd).catch(() => null);
    if (!cwdStat?.isDirectory()) {
      throw refuse(`working directory does not exist: ${input.cwd}`);
    }
    if (input.envFile) {
      if (!path.isAbsolute(input.envFile)) {
        throw refuse(`--env-file must be an absolute path on the job's machine: ${input.envFile}`);
      }
      const envStat = await stat(input.envFile).catch(() => null);
      if (!envStat?.isFile()) throw refuse(`--env-file not found: ${input.envFile}`);
      if (envStat.mode & 0o077) {
        throw refuse(
          `--env-file ${input.envFile} is readable or writable by other users (mode ${(envStat.mode & 0o777).toString(8)}); run chmod 600 on it. The job was not started`,
        );
      }
    }
    if (input.memoryMax && !MEMORY_MAX_PATTERN.test(input.memoryMax)) {
      throw refuse(`bad --memory-max ${input.memoryMax}: use bytes with K/M/G/T, or a percentage from 1% to 100%`);
    }
    if (input.cpuQuota && !CPU_QUOTA_PATTERN.test(input.cpuQuota)) {
      throw refuse(`bad --cpu-quota ${input.cpuQuota}: use a percentage above 0, such as 150%`);
    }
    const limits = [
      input.memoryMax ? `MemoryMax=${input.memoryMax}` : null,
      input.cpuQuota ? `CPUQuota=${input.cpuQuota}` : null,
      input.tasksMax ? `TasksMax=${input.tasksMax}` : null,
    ].filter((l): l is string => l !== null);
    const systemd = await this.hasSystemd();
    if ((limits.length || input.requireSystemd) && !systemd) {
      throw refuse(
        limits.length
          ? "--memory-max, --cpu-quota and --tasks-max need user systemd, which this machine does not have; the job was not started"
          : "user systemd is not available on this machine and --require-systemd forbids detached mode; the job was not started",
      );
    }
    const id = `${slug(input.name)}-${randomBytes(3).toString("hex")}`;
    const logMaxBytes = input.logMaxBytes ?? DEFAULT_LOG_MAX_BYTES;
    const dir = this.dir(id);
    const runner = path.join(dir, "runner.sh");
    const envFile = path.join(dir, "env.sh");
    const launchFile = path.join(dir, "launch");
    const mode: JobMeta["mode"] = systemd ? "systemd" : "detached";
    const unit = systemd ? `bbjob-${id}` : null;
    const meta: JobMeta = {
      id,
      name: input.name,
      command: input.command,
      cwd: input.cwd,
      mode,
      unit,
      pid: null,
      createdAt: new Date().toISOString(),
      timeoutSec: input.timeoutSec,
      logMaxBytes,
      threadId: input.threadId,
      format: 2,
      ...(input.keyHash ? { keyFingerprint: requestFingerprint(input) } : {}),
    };
    // Nothing has run yet: on any failure, mark the directory as such.
    const notStarted = async (message: string): Promise<never> => {
      await rm(envFile, { force: true });
      await writeFile(launchFile, "not-started\n").catch(() => undefined);
      throw refuse(message);
    };
    await mkdir(dir, { mode: 0o700 });
    try {
      // Written before anything can run, so a keyed start that dies half-way
      // can be found again (see startKeyed).
      await writeFile(launchFile, "launching\n");
      if (input.keyHash) await writeFile(path.join(dir, "key"), input.keyHash, { mode: 0o600 });
      // Per-job copies: bash reads a script while it runs, so a shared runner
      // rewritten by a later start could corrupt jobs already running.
      await writeFile(runner, RUNNER, { mode: 0o700 });
      await writeFile(path.join(dir, "exec.pl"), EXEC_PL, { mode: 0o600 });
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
      // Before the launch, so a job whose launch result is lost can still be
      // listed and stopped.
      await writeFile(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2), { mode: 0o600 });
    } catch (error) {
      await notStarted(`could not prepare the job directory: ${errorText(error)}`);
    }

    const base = userEnv();
    const inherited: Record<string, string> = {};
    for (const key of INHERITED_ENV) {
      const value = base[key];
      if (value) inherited[key] = value;
    }
    for (const [key, value] of Object.entries(input.bbEnv ?? {})) {
      if (/^BB_[A-Z_]+$/.test(key)) inherited[key] = value;
    }

    if (unit) {
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
        // systemd-run that failed on its own (bad property, no bus) leaves no
        // unit behind. A timeout, or a unit that exists, may have started.
        const timedOut = (error as { killed?: boolean }).killed === true;
        // A unit that already ran and was collected is not-found too: its
        // exit code or output tells it apart.
        const ran =
          existsSync(path.join(dir, "exit")) ||
          ((await stat(path.join(dir, "output.log")).catch(() => null))?.size ?? 0) > 0;
        if (!timedOut && !ran && (await this.unitLoadState(unit)) === "not-found") {
          await notStarted(`systemd-run failed: ${errorText(error)}`);
        }
        // env.sh stays: the job may still read it. describe() removes it once
        // the job is known not to run.
        throw new Error(
          `systemd-run did not confirm job ${id} (${errorText(error)}); it may be running: check bb jobs status ${id}`,
        );
      }
      meta.pid = await this.unitMainPid(unit);
    } else {
      // detached: true makes the child a session + process-group leader, so
      // it outlives this worker.
      const child = spawn(this.options.shell ?? "/bin/bash", [runner, dir], {
        cwd: input.cwd,
        detached: true,
        stdio: "ignore",
        env: inherited,
      });
      const pid = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("spawn", () => resolve(child.pid ?? -1));
      }).catch((error: unknown) => notStarted(`could not start bash: ${errorText(error)}`));
      child.unref();
      meta.pid = pid;
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

    await writeFile(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2), {
      mode: 0o600,
    });
    await rm(launchFile, { force: true });
    return this.get(id);
  }

  /** Newest first; with `threadId`, only jobs started from that thread. */
  async list(limit: number, threadId: string | null = null): Promise<Job[]> {
    const metas: JobMeta[] = [];
    for (const m of await this.readAllMeta()) {
      if (threadId !== null && m.threadId !== threadId) continue;
      // A launch that failed before any process existed is not a job.
      if ((await this.readLaunch(m.id)) !== "not-started") metas.push(m);
    }
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
      // A keyed job whose claim was not settled (half-way start, owner gone
      // before recording "done") keeps its key until a start or release-key
      // settles it; archiving it would free the key silently.
      const marker = await readFile(path.join(this.dir(meta.id), "key"), "utf8").catch(() => null);
      if (marker) {
        const latest = await this.claims(marker.trim()).latest();
        if (latest?.claim === "corrupt" || latest?.claim.state === "pending") continue;
      }
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

  /** The job's `launch` marker: "launching", "not-started", or undefined. */
  private async readLaunch(id: string): Promise<string | undefined> {
    return (await readFile(path.join(this.dir(id), "launch"), "utf8").catch(() => null))?.trim();
  }

  /** "loaded", "not-found", ...; null when systemctl does not answer. */
  private async unitLoadState(unit: string): Promise<string | null> {
    const out = await run("systemctl", ["--user", "show", "-p", "LoadState", "--value", unit], {
      env: userEnv(),
      timeout: 5000,
    }).catch(() => null);
    return out?.stdout.trim() || null;
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
    const launch = await this.readLaunch(meta.id);
    let state: JobState;
    let finishedAt: string | null = null;
    if (exitCode !== null) {
      state = stopRequested ? "stopped" : "exited";
      finishedAt = (await stat(path.join(dir, "exit"))).mtime.toISOString();
    } else if (alive) {
      state = "running";
    } else if (launch === "not-started") {
      state = "not-started";
    } else if (launch === "launching" && !stopRequested) {
      // The start did not finish and nothing runs: whether the command ran
      // at all is unknown.
      state = "incomplete";
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
