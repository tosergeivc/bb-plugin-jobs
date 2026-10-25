An agent that starts a dev server or a deploy from its Bash tool loses it when the turn ends: the process belongs to the agent's process tree. `bb jobs` runs the command outside that tree, on the thread's machine, and keeps its output and exit code.

## What you get

- `bb jobs start -- <command>` starts a job and prints its id and first output. `bb jobs status`, `logs`, `wait`, `list` and `stop` manage it; `stop` ends the whole process tree. `list` shows the calling thread's jobs, and another thread's job needs `--force` to stop.
- `--ready-url` or `--ready-log` makes `start` return only once a server answers or prints a given line, with distinct exit codes for ready, crashed and not yet.
- `--notify` posts the job's result and last output to the thread when it ends, so the agent does not have to poll. Jobs that end together arrive as one message, and a notice is cancelled once the agent has read the result itself.
- `bb jobs logs --since <cursor>` returns only new output, and logs come without terminal colour codes, so agents spend fewer tokens on long jobs.
- `--key` makes a start idempotent, `--env-file` loads secrets from a file on the job's machine without passing them through bb, and `--memory-max`, `--cpu-quota`, `--tasks-max` and `--require-systemd` bound critical jobs.
- Logs are capped (`--log-max`, default 50 MiB, rotated once). `bb jobs prune` archives or deletes old jobs.
- A `background-jobs` skill tells agents to use `bb jobs` instead of `&`, `nohup` or a provider's own background mode.
- A `task-preflight` skill makes agents ask the owner's questions once before multi-step work and save the answers in thread storage. Jobs that fail because they needed input (sudo, ssh, git credentials, a prompt) are reported as `NEEDS INPUT`, and their notice is shown in the chat.

## How it differs from similar plugins

On Linux with a user systemd, each job is a transient `systemd-run --user` unit with its own cgroup, outside the bb service. Plugins that spawn jobs from the bb daemon keep them in bb's cgroup, where a stop or update of a `KillMode=control-group` bb service ends them too. Surviving a bb restart follows from this design but has not been observed in a test yet. On macOS, and on Linux without user systemd, jobs run as detached sessions.

It manages the life of a command, not a release: an exit code of 0 says the command finished, not that a deploy is correct.

## Requirements

- Linux or macOS machines (WSL works); native Windows is refused.
- `bash` and `perl`, present on macOS and most Linux systems.
- Linux: for jobs to outlive your login session, enable lingering once: `sudo loginctl enable-linger $USER`. `bb jobs start` warns when it is off.
- No account or external service.
