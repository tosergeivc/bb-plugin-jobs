// bb-plugin-jobs — `bb jobs`: durable background jobs for agents.
//
// The CLI runs on the bb server; every job operation is forwarded to this
// plugin's host entry on the machine of the invoking thread, because the job
// must run (and its files live) where the agent works.
import {
  PluginCliError,
  cliCommand,
  defineCli,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { hostContract, type Job } from "./contract.js";
import { shellQuote } from "./jobs-core.js";

const LOG_DEFAULT_BYTES = 16 * 1024;
const LOG_MAX_BYTES = 512 * 1024;

export default async function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract });

  async function resolveHost(
    machine: string | undefined,
    threadId: string | undefined,
  ): Promise<string> {
    if (machine) {
      const hosts = await bb.sdk.hosts.list();
      const match = hosts.find(
        (h) => h.id === machine || h.name.toLowerCase() === machine.toLowerCase(),
      );
      if (!match) {
        throw new PluginCliError(`no machine named ${machine}`, {
          code: "machine_not_found",
          hint: "Run `bb machine list` for ids and names.",
        });
      }
      return match.id;
    }
    if (threadId) {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.environmentId) {
        const env = await bb.sdk.environments.get({
          environmentId: thread.environmentId,
        });
        return env.hostId;
      }
    }
    const { primaryHostId } = await bb.sdk.system.config();
    if (!primaryHostId) {
      throw new PluginCliError("cannot tell which machine to use", {
        code: "machine_unknown",
        hint: "Pass --machine <id|name>.",
      });
    }
    return primaryHostId;
  }

  const machineOption = {
    type: "string",
    description:
      "Machine id or name. Default: the machine of the calling thread.",
    aliases: ["host"],
  } as const;
  const jsonOption = {
    type: "boolean",
    description: "Print JSON instead of text",
  } as const;

  function call<M extends keyof typeof hostContract & string>(
    method: M,
    input: Parameters<typeof host.call<M>>[1],
    hostId: string,
    signal?: AbortSignal,
  ) {
    return host.call(method, input, { hostId, signal, timeoutMs: 60_000 });
  }

  bb.cli.register(
    defineCli({
      name: "jobs",
      summary:
        "Durable background jobs: servers, deploys and long commands that survive the end of the turn",
      commands: {
        start: cliCommand({
          summary: "Start a command as a durable background job",
          description:
            "Everything after `--` is the command. One token runs as a bash script line (pipes, &&, quotes work); several tokens are quoted and joined. Output goes to the job log; the command reads no stdin.",
          passthrough: true,
          options: {
            name: {
              type: "string",
              description: "Short label, used in the job id (max 64 chars)",
            },
            cwd: {
              type: "string",
              description: "Working directory. Default: the caller's cwd",
            },
            env: {
              type: "string",
              repeatable: true,
              placeholder: "KEY=VALUE",
              description: "Extra environment variable; repeat for more",
            },
            timeout: {
              type: "duration",
              defaultUnit: "m",
              min: 1000,
              max: 7 * 24 * 3600 * 1000,
              description:
                "Kill the job's process group after this long; exit 124 (needs perl). Default: none",
            },
            machine: machineOption,
            json: jsonOption,
          },
          async run(input, ctx) {
            const command =
              input.passthrough.length === 1
                ? input.passthrough[0]!
                : input.passthrough.map(shellQuote).join(" ");
            if (!command.trim()) {
              throw new PluginCliError("no command given", {
                code: "missing_command",
                hint: "bb jobs start --name deploy -- ./deploy.sh --prod",
              });
            }
            const cwd = input.options.cwd ?? ctx.cwd;
            if (!cwd) {
              throw new PluginCliError("no working directory", {
                code: "missing_cwd",
                hint: "Pass --cwd <absolute path>.",
              });
            }
            const env: Record<string, string> = {};
            for (const pair of input.options.env) {
              const eq = pair.indexOf("=");
              const key = eq > 0 ? pair.slice(0, eq) : "";
              if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
                throw new PluginCliError(`bad --env value: ${pair}`, {
                  code: "invalid_env",
                  hint: "Use --env KEY=VALUE.",
                });
              }
              env[key] = pair.slice(eq + 1);
            }
            const hostId = await resolveHost(input.options.machine, ctx.threadId);
            const name =
              input.options.name ?? command.trim().split(/\s+/)[0]!.slice(0, 64);
            const job = await call(
              "start",
              {
                name,
                command,
                cwd,
                env,
                timeoutSec:
                  input.options.timeout === undefined
                    ? null
                    : Math.ceil(input.options.timeout / 1000),
                threadId: ctx.threadId ?? null,
              },
              hostId,
              ctx.signal,
            );
            // Give fast failures (typo, missing file) a moment to surface.
            await new Promise((r) => setTimeout(r, 1500));
            const { job: now, text } = await call(
              "logs",
              { id: job.id, maxBytes: 4096 },
              hostId,
              ctx.signal,
            );
            if (input.options.json) {
              return { exitCode: 0, stdout: JSON.stringify(now, null, 2) };
            }
            return {
              exitCode: now.state === "exited" && now.exitCode !== 0 ? 1 : 0,
              stdout:
                `${describe(now)}\n` +
                `Logs:  bb jobs logs ${now.id}\n` +
                `Wait:  bb jobs wait ${now.id}\n` +
                `Stop:  bb jobs stop ${now.id}\n` +
                (text ? `--- first output ---\n${text}` : ""),
            };
          },
        }),
        list: cliCommand({
          summary: "List jobs on a machine, newest first",
          options: {
            limit: {
              type: "integer",
              min: 1,
              max: 500,
              default: 20,
              description: "How many jobs to show (1-500)",
            },
            running: {
              type: "boolean",
              description: "Only running jobs",
            },
            machine: machineOption,
            json: jsonOption,
          },
          async run(input, ctx) {
            const hostId = await resolveHost(input.options.machine, ctx.threadId);
            const { jobs } = await call(
              "list",
              { limit: input.options.limit },
              hostId,
              ctx.signal,
            );
            const shown = input.options.running
              ? jobs.filter((j) => j.state === "running")
              : jobs;
            if (input.options.json) {
              return { exitCode: 0, stdout: JSON.stringify(shown, null, 2) };
            }
            if (!shown.length) return { exitCode: 0, stdout: "No jobs.\n" };
            return {
              exitCode: 0,
              stdout: shown.map((j) => describe(j)).join("\n") + "\n",
            };
          },
        }),
        status: cliCommand({
          summary: "Show one job",
          positionals: [{ name: "id", description: "Job id", required: true }],
          options: { machine: machineOption, json: jsonOption },
          async run(input, ctx) {
            const hostId = await resolveHost(input.options.machine, ctx.threadId);
            const job = await call(
              "get",
              { id: input.positionals.id },
              hostId,
              ctx.signal,
            ).catch(notFound);
            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify(job, null, 2)
                : `${describe(job)}\nCommand: ${job.command}\nLog: ${job.logPath}\n`,
            };
          },
        }),
        logs: cliCommand({
          summary: "Print the end of a job's output",
          positionals: [{ name: "id", description: "Job id", required: true }],
          options: {
            bytes: {
              type: "integer",
              min: 1,
              max: LOG_MAX_BYTES,
              default: LOG_DEFAULT_BYTES,
              description: `Bytes from the end of the log (max ${LOG_MAX_BYTES})`,
            },
            machine: machineOption,
          },
          async run(input, ctx) {
            const hostId = await resolveHost(input.options.machine, ctx.threadId);
            const { job, text, truncated } = await call(
              "logs",
              { id: input.positionals.id, maxBytes: input.options.bytes },
              hostId,
              ctx.signal,
            ).catch(notFound);
            return {
              exitCode: 0,
              stdout:
                (truncated ? `[… earlier output in ${job.logPath}]\n` : "") +
                text,
              stderr: `${describe(job)}\n`,
            };
          },
        }),
        wait: cliCommand({
          summary: "Wait until a job finishes; exit code mirrors the job",
          positionals: [{ name: "id", description: "Job id", required: true }],
          options: {
            timeout: {
              type: "duration",
              defaultUnit: "s",
              min: 1000,
              max: 10 * 60 * 1000,
              default: 5 * 60 * 1000,
              description:
                "Stop waiting after this long (max 10m; the job keeps running). Exit 124 on timeout",
            },
            machine: machineOption,
          },
          async run(input, ctx) {
            const hostId = await resolveHost(input.options.machine, ctx.threadId);
            const deadline = Date.now() + input.options.timeout;
            let job = await call(
              "get",
              { id: input.positionals.id },
              hostId,
              ctx.signal,
            ).catch(notFound);
            while (job.state === "running" && Date.now() < deadline) {
              if (ctx.signal?.aborted) break;
              await new Promise((r) => setTimeout(r, 2000));
              job = await call("get", { id: job.id }, hostId, ctx.signal);
            }
            const { text } = await call(
              "logs",
              { id: job.id, maxBytes: 4096 },
              hostId,
              ctx.signal,
            );
            const exitCode =
              job.state === "running"
                ? 124
                : job.state === "exited"
                  ? (job.exitCode ?? 1)
                  : 1;
            return {
              exitCode,
              stdout: `${describe(job)}\n--- last output ---\n${text}`,
            };
          },
        }),
        stop: cliCommand({
          summary: "Stop a job and every process it started",
          positionals: [{ name: "id", description: "Job id", required: true }],
          options: { machine: machineOption },
          async run(input, ctx) {
            const hostId = await resolveHost(input.options.machine, ctx.threadId);
            const job = await call(
              "stop",
              { id: input.positionals.id },
              hostId,
              ctx.signal,
            ).catch(notFound);
            return { exitCode: 0, stdout: `${describe(job)}\n` };
          },
        }),
      },
    }),
  );
}

function describe(job: Job): string {
  const result =
    job.state === "exited" ? `exited ${job.exitCode}` : job.state;
  const pid = job.pid ? ` pid ${job.pid}` : "";
  return `${job.id}  ${result}  [${job.mode}${pid}]  started ${job.createdAt}  cwd ${job.cwd}`;
}

function notFound(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  throw new PluginCliError(message, {
    code: "job_error",
    hint: "Run `bb jobs list` (add --machine if the job runs elsewhere).",
  });
}
