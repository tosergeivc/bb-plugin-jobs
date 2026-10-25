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
const READY_MAX_MS = 10 * 60 * 1000;
const NOTIFY_KEY = "notify";
const NOTIFY_POLL_MS = 5000;
const NOTIFY_TAIL_BYTES = 2048;
/** Lines of output a notice shows for a job that exited 0. */
const NOTIFY_SUCCESS_LINES = 5;
const SENT_CLEANUP_MS = 60_000;

/** A finished job's thread gets a message; entries live in plugin kv. */
type NotifyEntry = {
  hostId: string;
  threadId: string;
  addedAt: string;
  /** Failed send attempts; the entry is dropped after NOTIFY_MAX_FAILURES. */
  failures?: number;
};
const NOTIFY_MAX_FAILURES = 5;
/**
 * Notices sent but still waiting in the thread's queue (the thread was busy).
 * While queued they can be edited: a job the agent has read in the meantime
 * is taken out, and jobs that end later are added to the same message.
 */
const SENT_KEY = "notify-sent";
type SentEntry = { threadId: string; queuedMessageId: string; section: string; sentAt: string };
const SENT_TTL_MS = 24 * 3600 * 1000;

export default async function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const settings = bb.settings.define({
    notifyVisibility: {
      type: "select",
      label: "Who sees --notify messages",
      options: ["agent-only", "visible"],
      experimental_optionLabels: {
        "agent-only": "Only the agent (the chat shows its reply)",
        visible: "Agent and user (shown in the chat)",
      },
      default: "agent-only",
    },
  });

  /**
   * BB_* variables for a job started from a thread, when the job runs on the
   * thread's own machine (paths like the thread storage only exist there).
   */
  async function threadEnv(
    threadId: string | undefined,
    hostId: string,
  ): Promise<Record<string, string>> {
    if (!threadId) return {};
    const thread = await bb.sdk.threads.get({ threadId }).catch(() => null);
    if (!thread) return {};
    const env: Record<string, string> = { BB_THREAD_ID: threadId };
    if (thread.projectId) env.BB_PROJECT_ID = thread.projectId;
    if (thread.environmentId) {
      const environment = await bb.sdk.environments
        .get({ environmentId: thread.environmentId })
        .catch(() => null);
      if (environment?.hostId === hostId) env.BB_ENVIRONMENT_ID = environment.id;
    }
    const storage = await bb.sdk.threads.storageLocation({ threadId }).catch(() => null);
    if (storage?.hostId === hostId) env.BB_THREAD_STORAGE = storage.storageRootPath;
    return env;
  }

  async function readNotify(): Promise<Record<string, NotifyEntry>> {
    return (await bb.storage.kv.get<Record<string, NotifyEntry>>(NOTIFY_KEY)) ?? {};
  }
  // kv has no compare-and-swap; serialise our own read-modify-write cycles.
  let notifyLock: Promise<unknown> = Promise.resolve();
  function updateNotify(
    change: (entries: Record<string, NotifyEntry>) => void,
  ): Promise<void> {
    const next = notifyLock.then(async () => {
      const entries = await readNotify();
      change(entries);
      await bb.storage.kv.set(NOTIFY_KEY, entries);
    });
    notifyLock = next.catch(() => undefined);
    return next;
  }

  /**
   * The agent saw a job's final state itself (wait, status, logs, ready or a
   * fast failure at start), so a notice would only cost it another turn.
   */
  async function acknowledge(job: Job, threadId: string | undefined): Promise<void> {
    if (!threadId || job.state === "running") return;
    const entries = await readNotify().catch(() => ({}) as Record<string, NotifyEntry>);
    if (entries[job.id]?.threadId === threadId) {
      await updateNotify((all) => void delete all[job.id]);
    }
    const sent = await readSent().catch(() => ({}) as Record<string, SentEntry>);
    const mine = sent[job.id];
    if (mine?.threadId === threadId) {
      await withSentLock(async () => {
        const all = await readSent();
        const entry = all[job.id];
        if (!entry) return;
        delete all[job.id];
        await rewriteQueuedNotice(entry.threadId, entry.queuedMessageId, all);
        await bb.storage.kv.set(SENT_KEY, all);
      }).catch((error: unknown) =>
        bb.log.warn(`withdrawing notice for ${job.id} failed: ${String(error)}`),
      );
    }
  }

  async function readSent(): Promise<Record<string, SentEntry>> {
    return (await bb.storage.kv.get<Record<string, SentEntry>>(SENT_KEY)) ?? {};
  }
  let sentLock: Promise<unknown> = Promise.resolve();
  function withSentLock<T>(work: () => Promise<T>): Promise<T> {
    const next = sentLock.then(work);
    sentLock = next.catch(() => undefined);
    return next;
  }

  function noticeText(sections: string[]): string {
    const header =
      sections.length === 1 ? "[bb jobs] A job ended." : `[bb jobs] ${sections.length} jobs ended.`;
    return [header, ...sections].join("\n\n");
  }
  async function noticeInput(sections: string[]) {
    const { notifyVisibility } = await settings.get();
    return [
      {
        type: "text" as const,
        text: noticeText(sections),
        mentions: [],
        ...(notifyVisibility === "agent-only" ? { visibility: "agent-only" as const } : {}),
      },
    ];
  }

  /**
   * Make a still-queued notice match the sent entries that point at it:
   * update its text, or delete it when no job is left in it. A notice that
   * was already delivered is left alone and its entries are dropped.
   */
  async function rewriteQueuedNotice(
    threadId: string,
    queuedMessageId: string,
    sent: Record<string, SentEntry>,
  ): Promise<void> {
    const queued = await bb.sdk.threads.queuedMessages.list({ threadId });
    const row = queued.find((m) => m.id === queuedMessageId);
    const ids = Object.keys(sent).filter((id) => sent[id]!.queuedMessageId === queuedMessageId);
    if (!row) {
      for (const id of ids) delete sent[id];
      return;
    }
    if (!ids.length) {
      await bb.sdk.threads.queuedMessages.delete({ threadId, queuedMessageId });
      return;
    }
    await bb.sdk.threads.queuedMessages.update({
      threadId,
      queuedMessageId,
      expectedUpdatedAt: row.updatedAt,
      input: await noticeInput(ids.map((id) => sent[id]!.section)),
    });
  }

  type NoticeCheck =
    | { kind: "pending" }
    | { kind: "drop" }
    | { kind: "report"; job: Job; text: string };

  /** Is the job done, and is anyone left to tell? */
  async function checkNotice(id: string, entry: NotifyEntry): Promise<NoticeCheck> {
    let job: Job;
    try {
      job = await host.call("get", { id }, { hostId: entry.hostId, timeoutMs: 15_000 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The job is gone (pruned, wrong machine): nothing left to report.
      if (/no job with id/.test(message)) return { kind: "drop" };
      return { kind: "pending" }; // machine offline or worker busy: try later
    }
    if (job.state === "running") return { kind: "pending" };
    // Stopped through `bb jobs stop`: whoever stopped it already knows.
    if (job.state === "stopped") return { kind: "drop" };
    const thread = await bb.sdk.threads.get({ threadId: entry.threadId }).catch(() => null);
    if (!thread) return { kind: "drop" }; // the thread was deleted
    const { text } = await host
      .call(
        "logs",
        { id, maxBytes: NOTIFY_TAIL_BYTES, since: null, raw: false },
        { hostId: entry.hostId, timeoutMs: 15_000 },
      )
      .catch(() => ({ text: "" }));
    return { kind: "report", job, text };
  }

  /** A short block per job: result line, where to look, and a tail of output. */
  function noticeSection(job: Job, hostId: string, text: string): string {
    const result = job.state === "exited" ? `exited ${job.exitCode}` : job.state;
    const seconds =
      job.finishedAt !== null
        ? (Date.parse(job.finishedAt) - Date.parse(job.createdAt)) / 1000
        : null;
    const took = seconds === null ? "" : ` after ${formatSeconds(seconds)}`;
    const command = job.command.length > 120 ? `${job.command.slice(0, 120)}…` : job.command;
    // The [jobs] start/exit lines repeat what the first line already says.
    let lines = text
      .trimEnd()
      .split("\n")
      .filter((line) => !/^\[jobs\] (started|exited) /.test(line));
    const ok = job.state === "exited" && job.exitCode === 0;
    if (ok) lines = lines.slice(-NOTIFY_SUCCESS_LINES);
    const output = lines.join("\n").trim();
    return [
      `${job.id} ${result}${took}: ${command}`,
      `Log: bb jobs logs ${job.id} --machine ${hostId} (cwd ${job.cwd})`,
      ...(output ? ["```", output, "```"] : ["(no output)"]),
    ].join("\n");
  }

  /**
   * Forget sent notices that are no longer waiting in their thread's queue
   * (delivered, or deleted) and anything older than SENT_TTL_MS.
   */
  let lastSentCleanup = 0;
  async function cleanupSent(): Promise<void> {
    if (Date.now() - lastSentCleanup < SENT_CLEANUP_MS) return;
    lastSentCleanup = Date.now();
    await withSentLock(async () => {
      const sent = await readSent();
      const ids = Object.keys(sent);
      if (!ids.length) return;
      const now = Date.now();
      const threads = new Set(ids.map((id) => sent[id]!.threadId));
      for (const threadId of threads) {
        const queued = await bb.sdk.threads.queuedMessages
          .list({ threadId })
          .catch(() => null);
        for (const id of ids) {
          const entry = sent[id];
          if (!entry || entry.threadId !== threadId) continue;
          const expired = now - Date.parse(entry.sentAt) > SENT_TTL_MS;
          const gone = queued !== null && !queued.some((m) => m.id === entry.queuedMessageId);
          if (expired || gone) delete sent[id];
        }
      }
      await bb.storage.kv.set(SENT_KEY, sent);
    });
  }

  /** One pass: every thread gets at most one message for all its ended jobs. */
  async function deliverNotices(signal: AbortSignal): Promise<void> {
    await cleanupSent().catch((error: unknown) =>
      bb.log.warn(`notify-sent cleanup failed: ${error instanceof Error ? error.message : String(error)}`),
    );
    const entries = await readNotify().catch(() => ({}) as Record<string, NotifyEntry>);
    const byThread = new Map<string, { id: string; section: string }[]>();
    const drops: string[] = [];
    for (const [id, entry] of Object.entries(entries)) {
      if (signal.aborted) return;
      const check = await checkNotice(id, entry).catch((error: unknown) => {
        bb.log.warn(`notice check for ${id} failed: ${error instanceof Error ? error.message : String(error)}`);
        return { kind: "pending" } as const;
      });
      if (check.kind === "drop") drops.push(id);
      if (check.kind === "report") {
        const list = byThread.get(entry.threadId) ?? [];
        list.push({ id, section: noticeSection(check.job, entry.hostId, check.text) });
        byThread.set(entry.threadId, list);
      }
    }
    if (drops.length) await updateNotify((all) => drops.forEach((id) => delete all[id]));
    for (const [threadId, items] of byThread) {
      if (signal.aborted) return;
      // The agent may have acknowledged a job while we were checking.
      const current = await readNotify().catch(() => ({}) as Record<string, NotifyEntry>);
      const fresh = items.filter((item) => current[item.id]);
      if (!fresh.length) continue;
      try {
        await withSentLock(async () => {
          const sent = await readSent();
          // Add to this thread's notice if it is still waiting in the queue.
          const queued = await bb.sdk.threads.queuedMessages.list({ threadId });
          const waiting = queued.find((m) =>
            Object.values(sent).some((e) => e.threadId === threadId && e.queuedMessageId === m.id),
          );
          let queuedMessageId: string | null = null;
          if (waiting) {
            const ids = Object.keys(sent).filter((id) => sent[id]!.queuedMessageId === waiting.id);
            await bb.sdk.threads.queuedMessages.update({
              threadId,
              queuedMessageId: waiting.id,
              expectedUpdatedAt: waiting.updatedAt,
              input: await noticeInput([
                ...ids.map((id) => sent[id]!.section),
                ...fresh.map((item) => item.section),
              ]),
            });
            queuedMessageId = waiting.id;
          } else {
            const result = await bb.sdk.threads.send({
              threadId,
              mode: "queue-if-active",
              input: await noticeInput(fresh.map((item) => item.section)),
            });
            if (result.delivery === "queued") queuedMessageId = result.queuedMessage.id;
          }
          if (queuedMessageId) {
            for (const item of fresh) {
              sent[item.id] = {
                threadId,
                queuedMessageId,
                section: item.section,
                sentAt: new Date().toISOString(),
              };
            }
          }
          await bb.storage.kv.set(SENT_KEY, sent);
        });
        await updateNotify((all) => fresh.forEach((item) => delete all[item.id]));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        bb.log.warn(`notice to ${threadId} failed: ${message}`);
        await updateNotify((all) => {
          for (const item of fresh) {
            const entry = all[item.id];
            if (!entry) continue;
            entry.failures = (entry.failures ?? 0) + 1;
            if (entry.failures >= NOTIFY_MAX_FAILURES) delete all[item.id];
          }
        });
      }
    }
  }

  bb.background.service("notify", {
    async start(signal) {
      while (!signal.aborted) {
        await deliverNotices(signal).catch((error: unknown) =>
          bb.log.warn(`notify pass failed: ${error instanceof Error ? error.message : String(error)}`),
        );
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, NOTIFY_POLL_MS);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
      }
    },
  });

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
    timeoutMs = 60_000,
  ) {
    return host.call(method, input, { hostId, signal, timeoutMs });
  }

  const readyOptions = {
    "ready-url": {
      type: "string",
      description:
        "Ready when this URL answers 2xx (checked on the job's machine, so localhost works)",
    },
    "ready-log": {
      type: "string",
      description: "Ready when the log has a line matching this regex",
    },
    "ready-timeout": {
      type: "duration",
      defaultUnit: "s",
      min: 1000,
      max: READY_MAX_MS,
      default: 60_000,
      description: "How long to wait for ready (max 10m; the job keeps running). Exit 124",
    },
  } as const;

  function readyCheck(options: {
    "ready-url"?: string;
    "ready-log"?: string;
  }): { url: string | null; logPattern: string | null } | null {
    const url = options["ready-url"] ?? null;
    const logPattern = options["ready-log"] ?? null;
    if (url === null && logPattern === null) return null;
    if (url !== null && !/^https?:\/\//.test(url)) {
      throw new PluginCliError(`--ready-url must start with http:// or https://: ${url}`, {
        code: "invalid_url",
      });
    }
    if (logPattern !== null) {
      try {
        new RegExp(logPattern, "m");
      } catch (error) {
        throw new PluginCliError(`bad --ready-log regex: ${(error as Error).message}`, {
          code: "invalid_regex",
        });
      }
    }
    return { url, logPattern };
  }

  async function waitReady(
    id: string,
    check: { url: string | null; logPattern: string | null },
    timeoutMs: number,
    hostId: string,
    signal?: AbortSignal,
    threadId?: string,
  ) {
    const result = await call(
      "ready",
      { id, ...check, timeoutMs },
      hostId,
      signal,
      timeoutMs + 30_000,
    );
    const { text } = await call(
      "logs",
      { id, maxBytes: 4096, since: null, raw: false },
      hostId,
      signal,
    );
    await acknowledge(result.job, threadId);
    const exitCode =
      result.outcome === "ready" ? 0 : result.outcome === "timeout" ? 124 : 1;
    const verdict =
      result.outcome === "ready"
        ? `READY after ${(result.waitedMs / 1000).toFixed(1)}s: ${result.detail}`
        : result.outcome === "timeout"
          ? `NOT READY after ${(result.waitedMs / 1000).toFixed(1)}s (job still running): ${result.detail}`
          : `FAILED: ${result.detail}`;
    return {
      exitCode,
      stdout: `${describe(result.job)}\n${verdict}\n--- last output ---\n${text}`,
    };
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
            "log-max": {
              type: "integer",
              min: 0,
              max: 4096,
              default: 50,
              description:
                "Rotate output.log to output.log.1 past this many MiB, so at most twice this is kept; 0 = no limit",
            },
            ...readyOptions,
            notify: {
              type: "boolean",
              description:
                "When the job ends, post its result and last output to the calling thread (checked every 5 s)",
            },
            "notify-thread": {
              type: "string",
              description: "Thread to notify instead of the calling one; implies --notify",
            },
            machine: machineOption,
            json: jsonOption,
          },
          async run(input, ctx) {
            const ready = readyCheck(input.options);
            const notifyThread =
              input.options["notify-thread"] ??
              (input.options.notify ? ctx.threadId : undefined);
            if (input.options.notify && !notifyThread) {
              throw new PluginCliError("--notify needs a thread to notify", {
                code: "missing_thread",
                hint: "Run from a bb thread, or pass --notify-thread <thread-id>.",
              });
            }
            if (notifyThread) {
              await bb.sdk.threads.get({ threadId: notifyThread }).catch(() => {
                throw new PluginCliError(`no thread ${notifyThread}`, {
                  code: "thread_not_found",
                });
              });
            }
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
                logMaxBytes: input.options["log-max"] * 1024 * 1024,
                threadId: ctx.threadId ?? null,
                bbEnv: await threadEnv(ctx.threadId, hostId),
              },
              hostId,
              ctx.signal,
            );
            if (notifyThread) {
              await updateNotify((all) => {
                all[job.id] = { hostId, threadId: notifyThread, addedAt: new Date().toISOString() };
              });
            }
            const warnings = job.warnings.map((w) => `Warning: ${w}\n`).join("");
            const notifyLine = notifyThread
              ? `Notify: thread ${notifyThread} gets a message when the job ends\n`
              : "";
            if (ready) {
              const result = await waitReady(
                job.id,
                ready,
                input.options["ready-timeout"],
                hostId,
                ctx.signal,
                ctx.threadId,
              );
              if (input.options.json) {
                const now = await call("get", { id: job.id }, hostId, ctx.signal);
                return {
                  exitCode: result.exitCode,
                  stdout: JSON.stringify({ ...now, warnings: job.warnings }, null, 2),
                };
              }
              return { ...result, stdout: warnings + notifyLine + result.stdout };
            }
            // Give fast failures (typo, missing file) a moment to surface.
            await new Promise((r) => setTimeout(r, 1500));
            const { job: now, text } = await call(
              "logs",
              { id: job.id, maxBytes: 4096, since: null, raw: false },
              hostId,
              ctx.signal,
            );
            await acknowledge(now, ctx.threadId);
            if (input.options.json) {
              return {
                exitCode: 0,
                stdout: JSON.stringify({ ...now, warnings: job.warnings }, null, 2),
              };
            }
            return {
              exitCode: now.state === "exited" && now.exitCode !== 0 ? 1 : 0,
              stdout:
                warnings +
                `${describe(now)}\n` +
                notifyLine +
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
            all: {
              type: "boolean",
              description:
                "Jobs of every thread on the machine. Default from a thread: only that thread's jobs",
            },
            machine: machineOption,
            json: jsonOption,
          },
          async run(input, ctx) {
            const hostId = await resolveHost(input.options.machine, ctx.threadId);
            const threadId = input.options.all ? null : (ctx.threadId ?? null);
            const { jobs } = await call(
              "list",
              { limit: input.options.limit, threadId },
              hostId,
              ctx.signal,
            );
            const shown = input.options.running
              ? jobs.filter((j) => j.state === "running")
              : jobs;
            if (input.options.json) {
              return { exitCode: 0, stdout: JSON.stringify(shown, null, 2) };
            }
            if (!shown.length) {
              return {
                exitCode: 0,
                stdout: threadId
                  ? "No jobs from this thread. Add --all for every thread's jobs.\n"
                  : "No jobs.\n",
              };
            }
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
            await acknowledge(job, ctx.threadId);
            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify(job, null, 2)
                : `${describe(job)}\nCommand: ${job.command}\nLog: ${job.logPath}\n`,
            };
          },
        }),
        logs: cliCommand({
          summary: "Print a job's output: the end, or only what is new since a cursor",
          description:
            "Without --since, prints the end of the log. Every call ends with a `next: --since N` line on stderr; pass N back to get only the output written after it, in whole lines. Terminal colour codes and progress-bar redraws are removed unless --raw.",
          positionals: [{ name: "id", description: "Job id", required: true }],
          options: {
            bytes: {
              type: "integer",
              min: 1,
              max: LOG_MAX_BYTES,
              default: LOG_DEFAULT_BYTES,
              description: `At most this many bytes (default ${LOG_DEFAULT_BYTES}, max ${LOG_MAX_BYTES})`,
            },
            since: {
              type: "integer",
              min: 0,
              max: Number.MAX_SAFE_INTEGER,
              description: "Cursor from an earlier `next: --since N`; prints only newer output",
              aliases: ["cursor"],
            },
            raw: {
              type: "boolean",
              description: "Keep terminal escape codes and carriage-return redraws",
            },
            machine: machineOption,
            json: jsonOption,
          },
          async run(input, ctx) {
            const hostId = await resolveHost(input.options.machine, ctx.threadId);
            const result = await call(
              "logs",
              {
                id: input.positionals.id,
                maxBytes: input.options.bytes,
                since: input.options.since ?? null,
                raw: input.options.raw,
              },
              hostId,
              ctx.signal,
            ).catch(notFound);
            await acknowledge(result.job, ctx.threadId);
            if (input.options.json) {
              return { exitCode: 0, stdout: JSON.stringify(result, null, 2) };
            }
            const { job, text, truncated, cursor, skippedBytes } = result;
            const before =
              input.options.since === undefined
                ? truncated
                  ? `[… earlier output in ${job.logPath}]\n`
                  : ""
                : skippedBytes > 0
                  ? `[… ${skippedBytes} bytes were rotated away before this read]\n`
                  : "";
            const more =
              input.options.since !== undefined && truncated
                ? " (more output is waiting)"
                : job.state === "running"
                  ? " (job still running)"
                  : "";
            return {
              exitCode: 0,
              stdout: before + text,
              stderr: `${describe(job)}\nnext: --since ${cursor}${more}\n`,
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
              await new Promise((r) => setTimeout(r, 1000));
              job = await call("get", { id: job.id }, hostId, ctx.signal);
            }
            const { text } = await call(
              "logs",
              { id: job.id, maxBytes: 4096, since: null, raw: false },
              hostId,
              ctx.signal,
            );
            await acknowledge(job, ctx.threadId);
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
        ready: cliCommand({
          summary: "Wait until a running job is ready (URL answers or log line appears)",
          positionals: [{ name: "id", description: "Job id", required: true }],
          options: {
            url: { ...readyOptions["ready-url"], aliases: ["ready-url"] },
            log: { ...readyOptions["ready-log"], aliases: ["ready-log"] },
            timeout: { ...readyOptions["ready-timeout"], aliases: ["ready-timeout"] },
            machine: machineOption,
          },
          constraints: [{ kind: "at-least-one", options: ["url", "log"] }],
          async run(input, ctx) {
            const check = readyCheck({
              "ready-url": input.options.url,
              "ready-log": input.options.log,
            })!;
            const hostId = await resolveHost(input.options.machine, ctx.threadId);
            await call("get", { id: input.positionals.id }, hostId, ctx.signal).catch(notFound);
            return waitReady(
              input.positionals.id,
              check,
              input.options.timeout,
              hostId,
              ctx.signal,
              ctx.threadId,
            );
          },
        }),
        prune: cliCommand({
          summary: "Archive (or delete) finished jobs older than a given age",
          description:
            "Moves job directories of finished jobs into the plugin's archive directory. Running jobs are never touched. Use --delete to free the disk space instead.",
          options: {
            "older-than": {
              type: "duration",
              defaultUnit: "d",
              min: 0,
              required: true,
              description: "Only jobs that ended at least this long ago (e.g. 7d, 12h)",
            },
            delete: {
              type: "boolean",
              description: "Delete instead of moving to the archive",
            },
            "dry-run": {
              type: "boolean",
              description: "Only list what would be pruned",
            },
            machine: machineOption,
            json: jsonOption,
          },
          async run(input, ctx) {
            const hostId = await resolveHost(input.options.machine, ctx.threadId);
            const result = await call(
              "prune",
              {
                olderThanMs: input.options["older-than"],
                delete: input.options.delete,
                dryRun: input.options["dry-run"],
              },
              hostId,
              ctx.signal,
            );
            if (input.options.json) {
              return { exitCode: 0, stdout: JSON.stringify(result, null, 2) };
            }
            const total = result.pruned.reduce((n, p) => n + p.bytes, 0);
            const verb = input.options["dry-run"]
              ? "Would prune"
              : input.options.delete
                ? "Deleted"
                : `Archived to ${result.archiveDir}:`;
            return {
              exitCode: 0,
              stdout: result.pruned.length
                ? `${verb} ${result.pruned.length} job(s), ${(total / 1024 / 1024).toFixed(1)} MiB\n` +
                  result.pruned.map((p) => `  ${p.id}`).join("\n") +
                  "\n"
                : "Nothing to prune.\n",
            };
          },
        }),
        stop: cliCommand({
          summary: "Stop a job and every process it started",
          positionals: [{ name: "id", description: "Job id", required: true }],
          options: {
            force: {
              type: "boolean",
              description: "Stop a job that another thread started",
            },
            machine: machineOption,
          },
          async run(input, ctx) {
            const hostId = await resolveHost(input.options.machine, ctx.threadId);
            const current = await call(
              "get",
              { id: input.positionals.id },
              hostId,
              ctx.signal,
            ).catch(notFound);
            if (
              !input.options.force &&
              ctx.threadId &&
              current.threadId &&
              current.threadId !== ctx.threadId &&
              current.state === "running"
            ) {
              throw new PluginCliError(
                `job ${current.id} belongs to thread ${current.threadId}, not this one`,
                {
                  code: "foreign_job",
                  hint: "Ask the user first; add --force to stop it anyway.",
                },
              );
            }
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

function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${Math.round(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
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
