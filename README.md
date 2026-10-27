# bb-plugin-jobs

[![CI](https://github.com/tosergeivc/bb-plugin-jobs/actions/workflows/ci.yml/badge.svg)](https://github.com/tosergeivc/bb-plugin-jobs/actions/workflows/ci.yml)

A [bb](https://getbb.app) plugin that adds `bb jobs`: run dev servers, deploys, builds and other long commands as background jobs that keep running after the agent's turn ends, wait until a server is ready, and tell the agent's thread when a job finishes.

`bb jobs` manages the life of a command: start, output, exit code, stop. It is not a deployment system: it does not approve releases, accept artifacts or roll back. An exit code of 0, a ready check or a notice says the command finished, not that the deploy is correct; check the result itself.

Русская версия: [README.ru.md](README.ru.md).

## Contents

- [The problem](#the-problem)
- [Requirements](#requirements)
- [Install](#install)
- [Usage](#usage)
- [How it works](#how-it-works)
- [Works well with](#works-well-with)
- [Similar plugins](#similar-plugins)
- [What was tested](#what-was-tested)
- [Limitations](#limitations)
- [Development](#development)
- [License](#license)

## The problem

When a bb agent starts a long process from its Bash tool (`npm run dev &`, `nohup ./deploy.sh &`, `setsid …`), that process belongs to the agent's process tree. When the turn ends, the provider shuts that tree down and the process dies silently. On Linux, bb usually also runs as a systemd user service with `KillMode=control-group`, so every process it ever started is killed when bb stops or updates itself.

`bb jobs` starts the command outside bb's process tree:

| Machine | How a job runs | Survives end of turn | Survives bb service stop/update |
|---------|----------------|----------------------|---------------------------------|
| Linux with a user systemd | transient unit `bbjob-<id>` via `systemd-run --user`, its own cgroup | yes | in-app update: yes, observed; restart of `bb-app.service`: designed to (own cgroup), not yet observed |
| macOS, or Linux without user systemd | detached session leader | yes | no on Linux; macOS not tested |

## Requirements

- bb 0.46 or newer.
- Linux or macOS machines; WSL works. Native Windows machines are refused with an explicit error.
- `bash` and `perl` on each machine that runs jobs (present on macOS and most Linux systems).
- Linux, for jobs that outlive your login session: user lingering. Without it systemd stops all of the user's units, including jobs, when the last login session ends. Check with `loginctl show-user $USER -p Linger`; enable once with `sudo loginctl enable-linger $USER`. `bb jobs start` prints a warning when lingering is off.
- No account or external service.

## Install

```bash
bb plugin install git:https://github.com/tosergeivc/bb-plugin-jobs.git@semver:^0.5.6
```

bb builds the plugin on install. The plugin ships two skills that bb gives to agents in every thread:

- `background-jobs` — agents start using `bb jobs` without extra prompting.
- `task-preflight` — before multi-step work that may need the owner (deploys, releases, installs, pushes, other machines, credentials), the agent lists what can block it, checks what it can without changing anything, asks all owner questions in one form, and saves the answers to `$BB_THREAD_STORAGE/preflight.json`, so later turns and subthreads reuse them instead of stopping on a question mid-way. An answer covers only what was asked; only the owner's own answer counts.

Plugins are full-trust code inside the bb server. Read the source before installing; it is about 1,500 lines of TypeScript, with small embedded bash and perl helpers.

## Usage

```bash
bb jobs start --name deploy --timeout 30m -- './deploy.sh prod'
bb jobs wait deploy-1a2b3c --timeout 10m      # repeat while it exits 124 (still running)
bb jobs logs deploy-1a2b3c --bytes 20000
bb jobs stop deploy-1a2b3c

bb jobs start --name api --ready-url http://localhost:3000/health -- 'npm start'
bb jobs start --name migrate --notify -- './migrate.sh'   # the thread gets a message when it ends
bb jobs prune --older-than 7d                  # this thread's finished jobs; --all for every thread
```

| Command | Effect |
|---------|--------|
| `bb jobs start [--name N] [--cwd DIR] [--env K=V]... [--timeout 30m] [--log-max 50] -- <command>` | Start a job; prints id, state and first output |
| `bb jobs start … --ready-url URL` / `--ready-log REGEX` [`--ready-timeout 60s`] | Start, then return only when the URL answers 2xx or a log line matches; exit 0 ready, 1 job ended, 124 not ready yet (job keeps running) |
| `bb jobs start … --key KEY` | Idempotent start: if a job was already started with this key on the machine, return it (`Reused job …`) instead of starting another. A retry after a lost answer, or several starts at once, run the command once (limits below). The key is bound to the request (command, directory, `--env` values by hash, env file path, `--timeout`, limits, `--require-systemd`); `--name` and `--log-max` are not part of it, and neither is the content of the env file. A different request with a used key fails with `key_conflict`. A start still in progress gives `key_busy`; a start that stopped half-way gives `key_unknown`. Neither is ever resolved by a timeout. The key stays with its job until the job is pruned. |
| `bb jobs release-key KEY [--force]` | Free a key after checking a `key_unknown` state, so the next start runs the command again. Without `--force` it is refused while a start with the key is in progress or a job it started still exists (for `key_busy`, wait and repeat the start instead). Nothing is deleted: the old claim stays in the key's history, and job directories lose their link to the key |
| `bb jobs start … --env-file /abs/path` | Load `KEY=VALUE` lines from a file on the job's machine when the job starts (blank lines, `#` comments, `export ` and one pair of quotes are handled; nothing is executed). Values never pass through bb or its command line. A file other users can read or write is refused (chmod 600). |
| `bb jobs start … --memory-max 2G --cpu-quota 150% --tasks-max 512` | systemd limits for the job's own cgroup (jobs are outside the bb service's limits). Need user systemd: on a machine without it the job is not started. |
| `bb jobs start … --require-systemd` | Fail instead of starting a detached job when the machine has no user systemd |
| `bb jobs start … --notify` / `--notify-thread THREAD` | When the job ends, post a short notice to the calling (or given) thread: result, duration, command, where the log is, and the last 5 lines of output for exit 0 or the last 2 KiB otherwise |
| `bb jobs ready <id> --url URL` / `--log REGEX` [`--timeout 60s`] | The same readiness check for a job that is already running |
| `bb jobs list [--running] [--all]` | Jobs started from the calling thread, newest first; `--all` shows every thread's jobs on the machine (outside a thread, all jobs) |
| `bb jobs status <id>` | State, exit code, command, log path |
| `bb jobs logs <id> [--bytes N] [--raw]` | End of the combined stdout/stderr log (default 16 KiB), with terminal colour codes and progress-bar redraws removed unless `--raw` |
| `bb jobs logs <id> --since N` | Only output written after cursor N, in whole lines while the job runs; each call prints `next: --since N` on stderr |
| `bb jobs wait <id> [--timeout 5m]` | Wait up to 10 min; exit code mirrors the job, 124 if still running |
| `bb jobs stop <id> [--force]` | SIGTERM the whole process tree, SIGKILL 15 s later; another thread's running job needs `--force` |
| `bb jobs prune --older-than 7d [--delete] [--dry-run] [--all]` | Move finished jobs that ended at least that long ago to the plugin's `archive/` directory, or delete them; running jobs are never touched. From a thread, only that thread's jobs (like `list`); `--all` for every job on the machine. Outside a thread, every job |

Every command accepts `--machine <id|name>`. Without it, the job runs on the machine of the calling thread. `start`, `list`, `status`, `logs` and `prune` accept `--json`.

Command rules:

- One token after `--` runs as a bash line, so pipes, `&&` and redirects work: `-- './build.sh && ./deploy.sh 2>&1'`. Several tokens are quoted one by one: `-- npm run dev`.
- The job has no stdin and no terminal. Pass answers with flags or `--env`. A prompt does not wait: `sudo`, an ssh password or unknown host key, a git credential prompt, Python `input()` or a `[y/N]` question fail at once. `start`, `wait` and `ready` then print `NEEDS INPUT:` with the reason and what to do, and a `--notify` notice for such a job is shown in the chat even when notices are set to agent-only, because only a person can give that input.
- A job inherits only `PATH HOME USER LOGNAME SHELL LANG LC_ALL TZ SSH_AUTH_SOCK` from the machine; add the rest with `--env`. Started from a thread, it also gets `BB_THREAD_ID` and `BB_PROJECT_ID`, plus `BB_ENVIRONMENT_ID` and `BB_THREAD_STORAGE` when it runs on the thread's own machine.
- States: `running`, `exited` (with code), `stopped` (by `bb jobs stop`), `lost` (gone without an exit code: reboot, OOM, external kill), `incomplete` (the start was interrupted between launching and confirming; nothing runs now, and whether the command ran is unknown: check its log and, on Linux, `systemctl --user status bbjob-<id>`), `not-started` (the launch failed before any process existed; not shown by `list`).
- When the start itself fails, the error code says what happened: `start_refused` means nothing ran (missing directory or env file, bad value, `systemd-run` rejected the unit); `start_unknown` means the answer was lost, for example a timeout, and the job may be running. Repeat a `start_unknown` start with the same `--key`, or check `bb jobs list` first.
- The log keeps at most twice `--log-max` MiB (default 50): past the limit `output.log` becomes `output.log.1` and a new `output.log` starts. `bb jobs logs` reads across both files.
- `--ready-url` is fetched on the job's machine, so `http://localhost:…` works for a job on another machine.

### Server workflow for agents

1. `bb jobs start --name api --ready-url http://localhost:3000/health -- 'npm start'` (or `--ready-log 'listening on'` when there is no health URL).
2. Exit 0: the server answers. Exit 1: it crashed; the output shows why. Exit 124: not ready within `--ready-timeout`; run `bb jobs ready <id> --url …` again or read `bb jobs logs <id>`.
3. `bb jobs stop <id>` when the server is no longer needed.

### Deploy workflow for agents

1. `bb jobs start --name deploy --timeout 30m --notify -- './deploy.sh prod'`, then read the first output; a typo shows up here as `exited` with a non-zero code.
2. End the turn or continue with other work. The thread receives a `[bb jobs]` message with the result when the deploy ends. Without `--notify`, run `bb jobs wait <id> --timeout 10m` and repeat while it returns 124.
3. On `exited 0`, check the service itself (`curl -sf …/health`, version endpoint). Exit code 0 alone does not prove the deploy worked.
4. Report the job id, exit code and the relevant lines from `bb jobs logs <id>`.

## How it works

```text
agent Bash: bb jobs start ──► server.ts (bb server, CLI)
                                │ host RPC to the thread's machine
                                ▼
                             host.ts (bb daemon on that machine)
                                │ jobs-core.ts
                    ┌───────────┴────────────┐
             systemd-run --user          detached spawn
             unit bbjob-<id>             (new session)
                    └───────────┬────────────┘
                                ▼
      runner.sh → exec.pl → command (own process group)
                    │
                    └► output.log (+ .1), exit file
```

- `server.ts` registers the `bb jobs` CLI. It resolves the target machine (thread → environment → host, or `--machine`) and forwards the call to the plugin's host entry.
- `host.ts` runs inside the bb daemon on that machine and calls `JobManager` in `jobs-core.ts`.
- `runner.sh` (a copy per job, never rewritten while a job runs) changes into the working directory and hands over to `exec.pl`.
- `exec.pl` runs the command in its own process group with output on a pipe, copies the pipe into `output.log` with the size cap, enforces `--timeout` (SIGTERM to the group, SIGKILL 15 s later, exit 124) and writes the exit code to `exit` atomically as soon as the command ends. It keeps copying while a leftover child still writes, so that child does not die of SIGPIPE. The job does not depend on the bb worker after it starts.
- In detached mode no stored PID is trusted, because PIDs get reused. A process belongs to the job when its command line is exactly one of the job's own launch lines (`runner.sh`, `exec.pl`, `command.sh` in the job directory), when it descends from one, or when it is in the command's process group, started no earlier than the job, and that group's leader is the job's own process or already gone. A recycled PID, or a process that merely mentions the job directory (`tail -f …/output.log`), is never reported or signalled. macOS hides other processes' environments, so an environment marker cannot do this. In systemd mode the unit's cgroup defines the job.
- Job files live in the plugin's data directory on the machine, `jobs/<id>/`, mode 0700.
- `--notify` stores the job id, machine and thread in the plugin's server storage. A background service on the bb server checks those jobs every 5 seconds and sends each thread one message for all of its jobs that ended since the last check, with `queue-if-active`: an active thread gets it after the current turn, an idle thread starts a new turn. A notice is cancelled when the agent reads the finished result itself (`wait`, `status`, `logs`, `ready`, or `start` showing a fast failure). Cancelling works only while the notice waits in the thread's queue, that is while the thread is busy: a notice to an idle thread is delivered at once and starts a turn, and cannot be taken back. By default notices are agent-only (the setting `notifyVisibility`, `bb plugin config jobs set notifyVisibility visible` to show them in the chat as well); the agent reads them, the chat shows the agent's reply. Jobs stopped with `bb jobs stop`, jobs that no longer exist and deleted threads are dropped without a message. If bb fails to queue a notice for a busy thread (bb 0.46.1 running on a database already migrated by a newer bb answers HTTP 500), the notice waits until the thread is idle and is then delivered directly, without the queue. Other delivery errors are retried with a growing pause (30 s doubling up to 6 h); a notice not delivered within 72 hours is dropped with a log line.
- `logs --since` cursors count bytes from the job's start across log rotations (`log-base` in the job directory records the bytes rotated out), so a cursor stays valid after a rotation; output rotated away for good is reported as skipped bytes.

## Works well with

- [Lame duck](https://github.com/ymichael/bb-plugins) pauses new sends and lets active turns finish before you restart or update the bb server. `bb jobs` keeps its `--notify` list on the server, so notices for jobs that end during the restart are sent once the server is back.
- [Env Catalog](https://github.com/VKirill/bb-plugin-env-catalog) keeps secrets encrypted on the bb server. Read a secret into a shell variable there and pass it as `--env NAME="$NAME"` rather than writing it into the command.
- Claude Code has its own background Bash mode, and its processes end with the session like any other (observed on 23 October 2026). Claude Code 2.1.310 contains a `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` setting which, according to the [Shell tasks README](https://github.com/ahkohd/bb-plugin-shell-tasks#install), disables background Bash commands and subagents; set it with `printf '1\n' | bb machine env set CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` so agents use `bb jobs` instead. Its exact effect was not tested here.

## Similar plugins

Two plugins in the bb-community marketplace solve the same problem; as of 24 October 2026:

- [Terminal Jobs](https://github.com/ryanbbrown/bb-plugin-terminal-jobs) runs each command in a bb terminal, records jobs in SQLite and notifies one owner thread.
- [Shell tasks](https://github.com/ahkohd/bb-plugin-shell-tasks) adds a `task` agent tool and a per-thread panel, and batches completion messages.

Both start the command from the bb daemon (`spawn` with `detached: true`). On Linux such a process stays in the bb service's cgroup, so a stop or update of a bb service with `KillMode=control-group` ends it too. `bb jobs` runs each job as its own `systemd-run --user` unit instead, and adds readiness checks, a log cap and PID-reuse protection; like Shell tasks it batches notices, cancels notices the agent already acted on, reads output by cursor and strips terminal codes. The other two offer things `bb jobs` does not: a UI panel and a native agent tool (Shell tasks), and SQLite job records with a manual notification retry (Terminal Jobs). If you install more than one, their agent skills compete; keep one.

## What was tested

Tested on 23–24 October 2026 with bb 0.46.2 (nightly), live on two Linux machines (both with user systemd) and one macOS machine; 0.4.1 ran the same scenario (ready check on coloured output, `logs --since`, stop, `--timeout`, exit code and `BB_THREAD_ID`) on all three:

| Check | Linux (Ubuntu, user systemd) | macOS (arm64, detached) |
|-------|------------------------------|-------------------------|
| Job keeps running after the turn ends | passed (~19 h) | passed (~1.5 h) |
| Output and exit code recorded; `wait` mirrors code | passed | passed |
| `stop` kills the whole tree, incl. a child in its own process group | passed | passed |
| `--timeout` ends the process group with code 124 | passed | passed |
| `--ready-url` / `--ready-log`, log cap with rotation | passed | passed |
| `--notify`: one message per ended job; none for a stopped job | passed | passed |
| Notices batched per thread, withdrawn once the agent read the result, merged into a waiting notice (0.4.0) | passed | not tested |
| `logs` without escape codes, `--since` cursor (0.4.0) | passed | passed |
| Survives an in-app bb update (bb stops its server and starts the new version inside the running service) | passed: a job with a 5-minute heartbeat ran through two updates to 0.47.2-nightly on 26 Oct 2026 without a gap | not tested |
| Survives a restart of `bb-app.service` (systemd kills the service's cgroup) | not yet observed | not tested |

Real-agent check (0.4.0, 24 October 2026): a Codex thread on the Linux server, given an ordinary task ("start a server that outlives your turn, run a 40-second deploy") without any mention of `bb jobs`, found the `background-jobs` skill, started the server with `--ready-url` and the deploy with `--notify`, and ended its turn. The server kept answering after the turn; the deploy's notice woke the idle thread, which reported exit 0 and its output. The Codex sandbox did not block the `bb` CLI. Another thread's `bb jobs stop` on that server was refused without `--force`.

Tests (`npm test`) run on Linux and macOS in [GitHub Actions](https://github.com/tosergeivc/bb-plugin-jobs/actions/workflows/ci.yml) on every push: 85 tests. 17 drive `server.ts` through the SDK's fake plugin host (notices: one per thread, cancelled after the agent read the result, withdrawn from and merged into a waiting notice, waiting for an idle thread when bb cannot queue, backoff, 72-hour limit; thread-scoped `list` and `prune`; `stop --force`; error codes of refused, unknown and keyed starts; `release-key`; `NEEDS INPUT` in output and owner-visible notices). 3 start three processes at once with one `--key`. The remaining 65 cover input hints from real job output, terminal-code cleaning, cursor reads across log rotation, `--env` cleanup, log rotation, readiness (URL, log line, early exit, timeout), prune, `--key` claims and their recovery, and strangers (a `tail -f` of the job log, a process planted on the job's PID and process group) that must be neither reported nor signalled.

## Limitations

- `--env` values are written briefly to disk: they go to `env.sh` (mode 0600) in the job directory, and the job loads and deletes that file before the command runs. If the job never starts, the runner or the next `status`/`list` deletes it. The values still exist in the job's process environment (readable by the same OS user), and they pass through the `bb` command line, so another process of the same user can see them in the `bb` process's arguments while it runs, and the thread transcript shows them if typed literally. For secrets use `--env-file` instead: the values stay in a file on the job's machine (it must be chmod 600) and are read only by the job. The command itself is stored in `meta.json` and shown by `bb jobs status`: never put secrets in it.
- A job that runs `ssh host command` is a local `ssh` client. `bb jobs stop` and `--timeout` end that client; without a terminal (`ssh -tt`) the remote command may keep running. Run the command on the remote machine as its own job with `--machine` when that machine is enrolled in bb, or make the remote side stop itself (`timeout` on the remote host).
- `--key` deduplicates per machine. Each key has a history of claims in the plugin's data directory; every change adds the next numbered entry, and only one process can add a given number, so starts in several OS processes at once still start one job. A claim records its process and that process's start time; it is taken over only when that process is gone and the job directory shows that nothing started (`key_busy` while it lives, `key_unknown` when the directory shows a launch that may have run).
- A key is bound to the job's directory, not to every process the command started. After `bb jobs prune` archives a finished job, its key is free, even if the command left a daemon running outside the job (`setsid`, `nohup … &`, a service it started): a later start with that key runs the command again. Do not prune keyed deploy jobs while such leftovers may run.
- Keys written by 0.5.3 are not seen by 0.5.0–0.5.2: do not downgrade while keyed starts may be retried.
- `perl` (present on macOS and most Linux systems) runs the log cap and `--timeout`. Without perl, a job with `--timeout` ends with code 125 instead of running unbounded, and other jobs run with an uncapped log.
- In detached mode a child that starts its own session or process group (`setsid`, many daemons) is found while its parent belongs to the job, but not after that parent has exited.
- Detached mode on Linux survives the end of a turn but not a stop of a bb service that uses `KillMode=control-group`.
- Finished job directories are not removed automatically; run `bb jobs prune`. The default moves them to `archive/`, which does not free disk space; `--delete` does.
- `wait` blocks at most 10 minutes per call.
- Agent-only notices were checked with Claude Code and Codex threads (24 October 2026): both agents read the job output from the notice. Other providers were not checked; if an agent does not react to notices, set `notifyVisibility` to `visible`.
- `--notify` delivers at least once: if the bb server stops between sending the message and recording it, the thread can get the same message twice. It does not retry a message bb rejected. Notices reach the thread up to about 5 seconds after the job ends. A message to an idle thread starts a new agent turn.
- The `--notify` list lives on the bb server; a job on a machine that stays offline is reported when the machine reconnects.

## Development

```bash
npm install
npm run typecheck
npm test            # bundles each test/*.test.ts with esbuild and runs node --test
bb plugin build
bb plugin install .
```

| File | Purpose |
|------|---------|
| `contract.ts` | Server ↔ host RPC contract (zod) |
| `jobs-core.ts` | Start, status, logs, stop, ready, prune; embedded runner and `exec.pl`; plain Node |
| `host.ts` | bb host entry |
| `server.ts` | `bb jobs` CLI |
| `skills/background-jobs/SKILL.md` | Instructions bb gives to agents |
| `skills/task-preflight/SKILL.md` | Owner questions asked once before multi-step work, answers saved in thread storage |
| `PLUGIN_OVERVIEW.md` | Long description for the bb marketplace |
| `test/` | `jobs-core` tests for both modes; `server.test.ts` for the CLI and notices |
| `scripts/typecheck-latest.mjs` | Typecheck against the newest published SDK |
| `.github/workflows/ci.yml` | Typecheck and tests on Linux and macOS |

## Changelog

- **0.5.6** — `task-preflight` runs before the first change, even in a short deploy, and its checks find the usual blockers without changing anything: whether `sudo` works, the lowest port a non-root process may bind, write access, missing tools and credentials, whether a port can be shared. A table turns each failed check into a decision with a default (for example port 8080 with `bb connect expose` instead of 80). The `background-jobs` skill sends agents through these checks before the first `bb jobs start` of a deploy or server. Found by a test with real Claude Code and Codex agents: both discovered that port 80 needs root by trying it.
- **0.5.5** — new skill `task-preflight`: before multi-step work the agent lists what may need the owner, checks what it can, asks once and saves the answers in thread storage. A job that failed because it needed input (sudo, ssh password or host key, git credentials, Python `input()`, a `[y/N]` prompt) gets a `NEEDS INPUT:` line with the reason in `start`, `wait` and `ready`, and its notice is shown in the chat even with agent-only notices.
- **0.5.4** — `bb jobs prune` run from a thread archives or deletes only that thread's jobs, like `list`; `--all` covers every thread's jobs on the machine. Before, a prune from one thread also archived other threads' finished jobs.
- **0.5.3** — `--key` holds across processes: claims are a numbered history in which only one process can add each entry, so two processes starting with one key at once start one job (before, a race could start two or three). A claim also records its process's start time, so a reused PID no longer keeps a key busy. A damaged claim gives `key_unknown` and `release-key` frees it. A start interrupted after launching is listed as `incomplete` and can be stopped; a launch that failed before anything ran (`systemd-run` rejected the unit) frees the key at once instead of leaving `key_unknown`. `release-key` refuses while a start with the key is in progress or a job it started exists, unless `--force`, and unlinks the key from every job directory. An error after the launch keeps the key bound, so a retry with the same key returns the job. `/tmp/` and `/tmp` count as one directory; a key from 0.5.0/0.5.1 is compared by command and directory. Start errors are `start_refused` (nothing ran) or `start_unknown` (answer lost, the job may run). `--cpu-quota 0%`, `--memory-max 0` and percentages above 100% are refused. Tests: three processes race on one key.
- **0.5.2** — `--key` no longer frees a pending claim after 15–60 seconds, which could start a second job when a first start was slow: same-key starts wait for each other in the worker, a claim of another live process gives `key_busy`, a dead owner is reconciled from the job directory (nothing started: claim again; complete job: reuse it; half-way: `key_unknown`), and `bb jobs release-key` frees a key by renaming its claim. Keys are bound to the request (`key_conflict`). `--env-file` refuses files other users can read or write. The skill no longer suggests `--env TOKEN="$TOKEN"`.
- **0.5.1** — invalid `--memory-max`, `--cpu-quota`, `--key` and `--env-file` values, and starts the machine refuses (missing working directory or env file, no systemd for limits), are reported as usage errors with a hint; before, `bb plugin list` showed them as "cli jobs failed" next to the running plugin.
- **0.5.0** — `--key` idempotent start (concurrent and repeated starts with one key give one job); `--env-file` loads secrets from a file on the job's machine without passing them through bb; `--memory-max`, `--cpu-quota`, `--tasks-max` set systemd limits for the job; `--require-systemd` refuses detached mode; README: `env.sh` is written briefly, ssh jobs, not a deployment system.
- **0.4.3** — loads on bb plugin SDK 0.6.43 and newer (bb 0.46.1); notices that bb cannot queue wait for the thread to become idle; failed notices are retried with backoff for up to 72 hours instead of being dropped after five tries.
- **0.4.2** — the `[jobs] exited` line is written after all of the command's output (it could land before the last lines, and after a log rotation in `output.log.1`); job processes are recognised whatever path or version the bash/perl interpreter shows in `ps`; CI on Linux and macOS.
- **0.4.1** — shorter notices (one result line with duration, log location, last 5 lines for exit 0, last 2 KiB otherwise, no repeated `[jobs]` lines); notices are agent-only by default (`notifyVisibility` setting); records of sent notices are cleaned every minute; README explains when a notice cannot be withdrawn.
- **0.4.0** — `logs` removes terminal colour codes and progress-bar redraws (`--raw` keeps them) and reads by cursor (`--since`, `next:` line, `--json`); `--ready-log` now matches the cleaned text; one notice per thread for jobs that end together, cancelled when the agent already read the result; `list` shows the calling thread's jobs (`--all` for every thread); `stop` refuses another thread's running job without `--force`; skill: `bb connect expose` for remote viewers; README: works well with Lame duck, Env Catalog, `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`.
- **0.3.0** — `--notify` / `--notify-thread`: a message to the thread when a job ends; jobs get `BB_THREAD_ID`, `BB_PROJECT_ID`, `BB_ENVIRONMENT_ID`, `BB_THREAD_STORAGE`; `bb jobs start` warns when systemd user lingering is off; native Windows machines are refused with a clear error; `[jobs]` lines always start on their own line; tests run on macOS too (no `setsid` binary needed); `PLUGIN_OVERVIEW.md`. The short description no longer claims that jobs survive a bb restart, which is still unverified.
- **0.2.0** — `--ready-url` / `--ready-log` on `start` and `bb jobs ready`; log cap with rotation (`--log-max`, default 50 MiB); `bb jobs prune`; detached jobs identified by their launch lines and process group instead of a stored PID, so a recycled PID is never reported or stopped; per-job runner copy (a shared runner rewritten by a later `start` could corrupt running jobs); the exit code is recorded even when a leftover child keeps the output open.
- **0.1.1** — `--env` values are no longer stored on disk after the job starts (were kept in `command.sh`). Jobs started with 0.1.0 keep their old `command.sh`.
- **0.1.0** — first release.

## License

MIT, see [LICENSE](LICENSE).

---

*Updated: 24 October 2026*
