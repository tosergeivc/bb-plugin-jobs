# bb-plugin-jobs

A [bb](https://getbb.app) plugin that adds `bb jobs`: run dev servers, deploys, builds and other long commands as background jobs that keep running after the agent's turn ends, wait until a server is ready, and tell the agent's thread when a job finishes.

Русская версия: [README.ru.md](README.ru.md).

## Contents

- [The problem](#the-problem)
- [Requirements](#requirements)
- [Install](#install)
- [Usage](#usage)
- [How it works](#how-it-works)
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
| Linux with a user systemd | transient unit `bbjob-<id>` via `systemd-run --user`, its own cgroup | yes | designed to (own cgroup); not yet observed |
| macOS, or Linux without user systemd | detached session leader | yes | no on Linux; macOS not tested |

## Requirements

- bb 0.46 or newer.
- Linux or macOS machines; WSL works. Native Windows machines are refused with an explicit error.
- `bash` and `perl` on each machine that runs jobs (present on macOS and most Linux systems).
- Linux, for jobs that outlive your login session: user lingering. Without it systemd stops all of the user's units, including jobs, when the last login session ends. Check with `loginctl show-user $USER -p Linger`; enable once with `sudo loginctl enable-linger $USER`. `bb jobs start` prints a warning when lingering is off.
- No account or external service.

## Install

```bash
bb plugin install git:https://github.com/tosergeivc/bb-plugin-jobs.git@semver:^0.3.0
```

bb builds the plugin on install. The plugin ships a skill (`background-jobs`) that bb gives to agents in every thread, so agents start using `bb jobs` without extra prompting.

Plugins are full-trust code inside the bb server. Read the source before installing; it is about 1,500 lines of TypeScript, with small embedded bash and perl helpers.

## Usage

```bash
bb jobs start --name deploy --timeout 30m -- './deploy.sh prod'
bb jobs wait deploy-1a2b3c --timeout 10m      # repeat while it exits 124 (still running)
bb jobs logs deploy-1a2b3c --bytes 20000
bb jobs stop deploy-1a2b3c

bb jobs start --name api --ready-url http://localhost:3000/health -- 'npm start'
bb jobs start --name migrate --notify -- './migrate.sh'   # the thread gets a message when it ends
bb jobs prune --older-than 7d
```

| Command | Effect |
|---------|--------|
| `bb jobs start [--name N] [--cwd DIR] [--env K=V]... [--timeout 30m] [--log-max 50] -- <command>` | Start a job; prints id, state and first output |
| `bb jobs start … --ready-url URL` / `--ready-log REGEX` [`--ready-timeout 60s`] | Start, then return only when the URL answers 2xx or a log line matches; exit 0 ready, 1 job ended, 124 not ready yet (job keeps running) |
| `bb jobs start … --notify` / `--notify-thread THREAD` | When the job ends, post its result, command, times and last 2 KiB of output to the calling (or given) thread |
| `bb jobs ready <id> --url URL` / `--log REGEX` [`--timeout 60s`] | The same readiness check for a job that is already running |
| `bb jobs list [--running]` | Jobs on the machine, newest first |
| `bb jobs status <id>` | State, exit code, command, log path |
| `bb jobs logs <id> [--bytes N]` | End of the combined stdout/stderr log (default 16 KiB) |
| `bb jobs wait <id> [--timeout 5m]` | Wait up to 10 min; exit code mirrors the job, 124 if still running |
| `bb jobs stop <id>` | SIGTERM the whole process tree, SIGKILL 15 s later |
| `bb jobs prune --older-than 7d [--delete] [--dry-run]` | Move finished jobs that ended at least that long ago to the plugin's `archive/` directory, or delete them; running jobs are never touched |

Every command accepts `--machine <id|name>`. Without it, the job runs on the machine of the calling thread. `start`, `list`, `status` and `prune` accept `--json`.

Command rules:

- One token after `--` runs as a bash line, so pipes, `&&` and redirects work: `-- './build.sh && ./deploy.sh 2>&1'`. Several tokens are quoted one by one: `-- npm run dev`.
- The job has no stdin. Pass answers with flags or `--env`.
- A job inherits only `PATH HOME USER LOGNAME SHELL LANG LC_ALL TZ SSH_AUTH_SOCK` from the machine; add the rest with `--env`. Started from a thread, it also gets `BB_THREAD_ID` and `BB_PROJECT_ID`, plus `BB_ENVIRONMENT_ID` and `BB_THREAD_STORAGE` when it runs on the thread's own machine.
- States: `running`, `exited` (with code), `stopped` (by `bb jobs stop`), `lost` (gone without an exit code: reboot, OOM, external kill).
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
- `--notify` stores the job id, machine and thread in the plugin's server storage. A background service on the bb server checks those jobs every 5 seconds and, when one has ended, sends one message to the thread with `queue-if-active`: an active thread gets it after the current turn, an idle thread starts a new turn. Jobs stopped with `bb jobs stop`, jobs that no longer exist and deleted threads are dropped without a message.

## Similar plugins

Two plugins in the bb-community marketplace solve the same problem; as of 24 October 2026:

- [Terminal Jobs](https://github.com/ryanbbrown/bb-plugin-terminal-jobs) runs each command in a bb terminal, records jobs in SQLite and notifies one owner thread.
- [Shell tasks](https://github.com/ahkohd/bb-plugin-shell-tasks) adds a `task` agent tool and a per-thread panel, and batches completion messages.

Both start the command from the bb daemon (`spawn` with `detached: true`). On Linux such a process stays in the bb service's cgroup, so a stop or update of a bb service with `KillMode=control-group` ends it too. `bb jobs` runs each job as its own `systemd-run --user` unit instead, and adds readiness checks, a log cap and PID-reuse protection. The other two offer things `bb jobs` does not: a UI panel (Shell tasks), and SQLite job records with notification retry (Terminal Jobs). If you install more than one, their agent skills compete; keep one.

## What was tested

Tested on 23–24 October 2026 with bb 0.46.2 (nightly), live on one Linux server and one macOS machine:

| Check | Linux (Ubuntu, user systemd) | macOS (arm64, detached) |
|-------|------------------------------|-------------------------|
| Job keeps running after the turn ends | passed (~19 h) | passed (~1.5 h) |
| Output and exit code recorded; `wait` mirrors code | passed | passed |
| `stop` kills the whole tree, incl. a child in its own process group | passed | passed |
| `--timeout` ends the process group with code 124 | passed | passed |
| `--ready-url` / `--ready-log`, log cap with rotation | passed | passed |
| `--notify`: one message per ended job; none for a stopped job | passed | passed |
| Survives a full stop/update of the bb service | not yet observed | not tested |

Unit tests (`npm test`, run on Linux; a GitHub Actions workflow for Linux and macOS is prepared but not yet enabled): 30 tests, including `--env` cleanup, log rotation, readiness (URL, log line, early exit, timeout), prune, and strangers (a `tail -f` of the job log, a process planted on the job's PID and process group) that must be neither reported nor signalled.

## Limitations

- `--env` values are not kept on disk: they go to `env.sh` (mode 0600) in the job directory, and the job loads and deletes that file before the command runs. If the job never starts, the runner or the next `status`/`list` deletes it. The values still exist in the job's process environment (readable by the same OS user), and they pass through the `bb` command line, so prefer `--env TOKEN="$TOKEN"` (the shell expands it; the thread transcript shows `$TOKEN`) over typing a secret literally. The command itself is stored in `meta.json` and shown by `bb jobs status`: never put secrets in it.
- `perl` (present on macOS and most Linux systems) runs the log cap and `--timeout`. Without perl, a job with `--timeout` ends with code 125 instead of running unbounded, and other jobs run with an uncapped log.
- In detached mode a child that starts its own session or process group (`setsid`, many daemons) is found while its parent belongs to the job, but not after that parent has exited.
- Detached mode on Linux survives the end of a turn but not a stop of a bb service that uses `KillMode=control-group`.
- Finished job directories are not removed automatically; run `bb jobs prune`. The default moves them to `archive/`, which does not free disk space; `--delete` does.
- `wait` blocks at most 10 minutes per call.
- `--notify` delivers at least once: if the bb server stops between sending the message and recording it, the thread can get the same message twice. It does not retry a message bb rejected. Notices reach the thread up to about 5 seconds after the job ends. A message to an idle thread starts a new agent turn.
- The `--notify` list lives on the bb server; a job on a machine that stays offline is reported when the machine reconnects.

## Development

```bash
npm install
npm run typecheck
npm test            # bundles test/jobs-core.test.ts with esbuild and runs node --test
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
| `PLUGIN_OVERVIEW.md` | Long description for the bb marketplace |
| `test/` | Tests for both modes |

## Changelog

- **0.3.0** — `--notify` / `--notify-thread`: a message to the thread when a job ends; jobs get `BB_THREAD_ID`, `BB_PROJECT_ID`, `BB_ENVIRONMENT_ID`, `BB_THREAD_STORAGE`; `bb jobs start` warns when systemd user lingering is off; native Windows machines are refused with a clear error; `[jobs]` lines always start on their own line; tests run on macOS too (no `setsid` binary needed); `PLUGIN_OVERVIEW.md`. The short description no longer claims that jobs survive a bb restart, which is still unverified.
- **0.2.0** — `--ready-url` / `--ready-log` on `start` and `bb jobs ready`; log cap with rotation (`--log-max`, default 50 MiB); `bb jobs prune`; detached jobs identified by their launch lines and process group instead of a stored PID, so a recycled PID is never reported or stopped; per-job runner copy (a shared runner rewritten by a later `start` could corrupt running jobs); the exit code is recorded even when a leftover child keeps the output open.
- **0.1.1** — `--env` values are no longer stored on disk after the job starts (were kept in `command.sh`). Jobs started with 0.1.0 keep their old `command.sh`.
- **0.1.0** — first release.

## License

MIT, see [LICENSE](LICENSE).

---

*Updated: 24 October 2026*
