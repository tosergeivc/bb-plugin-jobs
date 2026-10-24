---
name: background-jobs
description: Start dev servers, deploys, builds, watchers and any command that must keep running after your turn with `bb jobs start`, then check it with `bb jobs ready|status|logs|wait|stop`. Use instead of `cmd &`, `nohup`, `setsid`, `screen`, `tmux` or the Bash tool's background mode whenever a process must outlive the current turn or a bb restart.
---

# Background jobs

Processes you start from the Bash tool stay inside bb's own process tree. A
provider can tear that tree down when its session ends, and on Linux bb runs
as `bb-app.service` with `KillMode=control-group`, so stopping the service
kills every process it ever started. `&`, `nohup` and `setsid` do not leave
that cgroup. `bb jobs` runs the command on your
thread's machine as its own transient `systemd-run --user` unit (Linux) or as
a detached session (macOS, or Linux without user systemd), with output in a
log file.

## Commands

| Command | Effect |
| --- | --- |
| `bb jobs start --name <label> -- <command>` | Start a job in the current directory. Prints the job id, state and first output. |
| `bb jobs start --cwd <dir> --env K=V --timeout 30m -- <command>` | Set directory, extra env (repeat `--env`) and a hard time limit (SIGTERM, SIGKILL 15 s later; exit 124). |
| `bb jobs start --name api --ready-url http://localhost:3000/health -- 'npm start'` | Start a server and return when it answers 2xx (`--ready-log '<regex>'` waits for a log line instead; `--ready-timeout`, default 60s, max 10m). Exit 0 ready, 1 the job ended, 124 not ready yet. |
| `bb jobs ready <id> --url <url>` / `--log <regex>` | Re-check readiness of a running job. |
| `bb jobs list [--running]` | Jobs on this machine, newest first. |
| `bb jobs status <id>` | State, exit code, command and log path. |
| `bb jobs logs <id> [--bytes N]` | End of the job's combined stdout/stderr (default 16 KiB). |
| `bb jobs wait <id> [--timeout 5m]` | Block until the job ends (max 10m per call); exit code mirrors the job, 124 if still running. |
| `bb jobs stop <id>` | SIGTERM the whole process tree, SIGKILL after 15 s. |
| `bb jobs prune --older-than 7d` | Move finished jobs to the archive (`--delete` to free disk). Only when the user asks to clean up. |

All commands accept `--machine <id|name>` to target another machine and
`--json` (except `logs`, `wait`) for machine-readable output.

## Rules

- Quote the whole command as one token when it uses pipes, `&&`, `;` or
  redirects: `bb jobs start --name deploy -- './deploy.sh prod 2>&1 | tee deploy.txt'`.
  Several tokens are quoted one by one: `bb jobs start -- npm run dev`.
- The job gets no stdin. Pass answers with flags or env, never prompts.
- The job inherits only PATH, HOME, USER, SHELL, LANG, TZ and SSH_AUTH_SOCK
  from the machine; pass anything else with `--env`. `--env` values are not
  kept on disk after the job starts. Pass a secret as `--env TOKEN="$TOKEN"`,
  never literally, and never inside the command: the command is stored and
  shown by `bb jobs status`.
- After `start`, read the printed first output. For a deploy, follow with
  `bb jobs wait <id> --timeout 10m` and repeat `wait` until it is no longer
  running; report the exit code and the relevant log lines.
- For a server, start it with `--ready-url` (or `--ready-log`) and say it is up
  only after exit 0. On exit 124 read `bb jobs logs <id>` before retrying
  `bb jobs ready`. `bb jobs stop <id>` when it is no longer needed.
- The log keeps at most twice `--log-max` MiB (default 50); older output is
  dropped.
- States: `running`, `exited` (with exit code), `stopped` (by `bb jobs stop`),
  `lost` (gone without an exit code: reboot, OOM, killed from outside).
- Mode `detached` (shown in brackets) survives the end of the turn but, on
  Linux, not a full stop of the bb-app service. Mode `systemd` runs in its own
  cgroup and is meant to survive both; surviving a bb restart is not yet
  verified.
