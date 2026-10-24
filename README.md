# bb-plugin-jobs

A [bb](https://getbb.app) plugin that adds `bb jobs`: run dev servers, deploys, builds and other long commands as durable background jobs that keep running after the agent's turn ends.

Русская версия: [README.ru.md](README.ru.md).

## Contents

- [The problem](#the-problem)
- [Install](#install)
- [Usage](#usage)
- [How it works](#how-it-works)
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

## Install

Requires bb 0.46 or newer.

```bash
bb plugin install git:https://github.com/tosergeivc/bb-plugin-jobs.git@semver:^0.1.1
```

bb builds the plugin on install. The plugin ships a skill (`background-jobs`) that bb gives to agents in every thread, so agents start using `bb jobs` without extra prompting.

Plugins are full-trust code inside the bb server. Read the source before installing; it is about 900 lines of TypeScript.

## Usage

```bash
bb jobs start --name deploy --timeout 30m -- './deploy.sh prod'
bb jobs wait deploy-1a2b3c --timeout 10m      # repeat while it exits 124 (still running)
bb jobs logs deploy-1a2b3c --bytes 20000
bb jobs stop deploy-1a2b3c
```

| Command | Effect |
|---------|--------|
| `bb jobs start [--name N] [--cwd DIR] [--env K=V]... [--timeout 30m] -- <command>` | Start a job; prints id, state and first output |
| `bb jobs list [--running]` | Jobs on the machine, newest first |
| `bb jobs status <id>` | State, exit code, command, log path |
| `bb jobs logs <id> [--bytes N]` | End of the combined stdout/stderr log (default 16 KiB) |
| `bb jobs wait <id> [--timeout 5m]` | Wait up to 10 min; exit code mirrors the job, 124 if still running |
| `bb jobs stop <id>` | SIGTERM the whole process tree, SIGKILL 15 s later |

Every command accepts `--machine <id|name>`. Without it, the job runs on the machine of the calling thread. `start`, `list` and `status` accept `--json`.

Command rules:

- One token after `--` runs as a bash line, so pipes, `&&` and redirects work: `-- './build.sh && ./deploy.sh 2>&1'`. Several tokens are quoted one by one: `-- npm run dev`.
- The job has no stdin. Pass answers with flags or `--env`.
- A job inherits only `PATH HOME USER LOGNAME SHELL LANG LC_ALL TZ SSH_AUTH_SOCK` from the machine; add the rest with `--env`.
- States: `running`, `exited` (with code), `stopped` (by `bb jobs stop`), `lost` (gone without an exit code: reboot, OOM, external kill).

### Deploy workflow for agents

1. `bb jobs start --name deploy --timeout 30m -- './deploy.sh prod'`, then read the first output; a typo shows up here as `exited` with a non-zero code.
2. `bb jobs wait <id> --timeout 10m`; repeat while it returns 124.
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
                 runner.sh → output.log, exit file
```

- `server.ts` registers the `bb jobs` CLI. It resolves the target machine (thread → environment → host, or `--machine`) and forwards the call to the plugin's host entry.
- `host.ts` runs inside the bb daemon on that machine and calls `JobManager` in `jobs-core.ts`.
- `runner.sh` changes into the working directory, runs the command, appends output to `output.log` and writes the exit code to `exit` atomically. The job does not depend on the bb worker after it starts.
- `--timeout` runs the command in its own process group, and a watchdog sends that group SIGTERM, then SIGKILL 15 s later; the job ends with code 124.
- Job files live in the plugin's data directory on the machine, `jobs/<id>/`, mode 0700.

## What was tested

Tested on 23–24 October 2026 with bb 0.46.2 (nightly):

| Check | Linux (Ubuntu, user systemd) | macOS (arm64, detached) |
|-------|------------------------------|-------------------------|
| Job keeps running after the turn ends | passed (~19 h) | passed (~1.5 h) |
| Output and exit code recorded; `wait` mirrors code | passed | passed |
| `stop` kills the whole tree, incl. a child in its own process group | passed | passed |
| `--timeout` ends the process group with code 124 | passed | passed |
| Survives a full stop/update of the bb service | not yet observed | not tested |

Unit tests (`npm test`) run every check against both modes on Linux: 18 tests, including that `--env` values reach the command and are not left in the job directory.

## Limitations

- `--env` values are not kept on disk: they go to `env.sh` (mode 0600) in the job directory, and the job loads and deletes that file before the command runs. If the job never starts, the runner or the next `status`/`list` deletes it. The values still exist in the job's process environment (readable by the same OS user), and they pass through the `bb` command line, so prefer `--env TOKEN="$TOKEN"` (the shell expands it; the thread transcript shows `$TOKEN`) over typing a secret literally. The command itself is stored in `meta.json` and shown by `bb jobs status`: never put secrets in it.
- `--timeout` needs `perl` (present on macOS and most Linux systems). Without it, a job with `--timeout` ends with code 125 instead of running unbounded.
- Detached mode on Linux survives the end of a turn but not a stop of a bb service that uses `KillMode=control-group`.
- Finished job directories are not removed automatically.
- `wait` blocks at most 10 minutes per call.

## Development

```bash
npm install
npm run typecheck
npm test            # bundles test/jobs-core.test.ts with bb's esbuild and runs node --test
bb plugin build
bb plugin install .
```

| File | Purpose |
|------|---------|
| `contract.ts` | Server ↔ host RPC contract (zod) |
| `jobs-core.ts` | Start, status, logs, stop, runner script; plain Node |
| `host.ts` | bb host entry |
| `server.ts` | `bb jobs` CLI |
| `skills/background-jobs/SKILL.md` | Instructions bb gives to agents |
| `test/` | Tests for both modes |

## Changelog

- **0.1.1** — `--env` values are no longer stored on disk after the job starts (were kept in `command.sh`). Jobs started with 0.1.0 keep their old `command.sh`.
- **0.1.0** — first release.

## License

MIT, see [LICENSE](LICENSE).

---

*Updated: 24 October 2026*
