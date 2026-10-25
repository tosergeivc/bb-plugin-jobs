// Tests for server.ts: the `bb jobs` CLI and the --notify service, against
// the SDK's fake plugin host. The machine side is a fake host RPC that keeps
// jobs in memory, so each test decides when a job ends.
process.env.BB_JOBS_NOTIFY_POLL_MS = "50";

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { requestFingerprint } from "../jobs-core.ts";
import plugin from "../server.ts";

const HOST = "host_test";
const THREAD = "thr_me";
const OTHER = "thr_other";

type FakeJob = {
  id: string;
  name: string;
  command: string;
  cwd: string;
  mode: "systemd";
  unit: string;
  pid: number;
  state: "running" | "exited" | "stopped" | "lost";
  exitCode: number | null;
  createdAt: string;
  finishedAt: string | null;
  timeoutSec: number | null;
  logMaxBytes: number | null;
  threadId: string | null;
  logPath: string;
  output: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await sleep(20);
  }
}

function setup() {
  const jobs = new Map<string, FakeJob>();
  const keys = new Map<string, string>();
  const threadStatus = new Map<string, string>([[THREAD, "idle"], [OTHER, "idle"]]);
  const sends: { threadId: string; text: string; mode: string }[] = [];
  const queued = new Map<string, { id: string; updatedAt: number; text: string }[]>();
  let sendBehaviour: "ok" | "fail" = "ok";
  // What the machine does with the next start: run it, refuse it, or never answer.
  let startFault: "none" | "refuse" | "timeout" = "none";
  const fingerprints = new Map<string, string>();
  let counter = 0;

  const publicJob = (job: FakeJob) => {
    const { output: _output, ...rest } = job;
    return rest;
  };
  const textOf = (input: { text?: string }[]) => input.map((part) => part.text ?? "").join("");

  const { bb, harness } = createFakePluginHost({
    pluginId: "jobs",
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          if (!threadStatus.has(threadId)) throw new Error(`no thread ${threadId}`);
          return makeThreadResponse({
            id: threadId,
            status: threadStatus.get(threadId) as never,
            environmentId: null,
          });
        },
        storageLocation: async () => ({ hostId: HOST, storageRootPath: "/storage" }),
        send: async (args: { threadId: string; mode: string; input: { text?: string }[] }) => {
          if (sendBehaviour === "fail") throw new Error("HTTP 500: Internal server error");
          const text = textOf(args.input);
          sends.push({ threadId: args.threadId, text, mode: args.mode });
          if (threadStatus.get(args.threadId) !== "idle") {
            const id = `qmsg_${++counter}`;
            queued.set(args.threadId, [...(queued.get(args.threadId) ?? []), { id, updatedAt: Date.now(), text }]);
            return { ok: true, delivery: "queued", queuedMessage: { id } };
          }
          return { ok: true, delivery: "sent" };
        },
        queuedMessages: {
          list: async ({ threadId }: { threadId: string }) =>
            (queued.get(threadId) ?? []).map((m) => ({ id: m.id, updatedAt: m.updatedAt })),
          update: async (args: { threadId: string; queuedMessageId: string; input: { text?: string }[] }) => {
            const row = (queued.get(args.threadId) ?? []).find((m) => m.id === args.queuedMessageId)!;
            row.text = textOf(args.input);
            row.updatedAt = Date.now();
            return row;
          },
          delete: async ({ threadId, queuedMessageId }: { threadId: string; queuedMessageId: string }) => {
            queued.set(threadId, (queued.get(threadId) ?? []).filter((m) => m.id !== queuedMessageId));
            return { ok: true };
          },
        },
      },
      system: { config: async () => ({ primaryHostId: HOST }) },
    },
    experimental_callHostRpc: async ({ method, input }: { method: string; input: Record<string, unknown> }) => {
      const need = (id: unknown) => {
        const job = jobs.get(String(id));
        if (!job) throw new Error(`no job with id ${String(id)} on this machine`);
        return job;
      };
      switch (method) {
        case "start": {
          const id = `${String(input.name)}-${(++counter).toString(16).padStart(6, "0")}`;
          const job: FakeJob = {
            id, name: String(input.name), command: String(input.command), cwd: String(input.cwd),
            mode: "systemd", unit: `bbjob-${id}`, pid: 1000 + counter, state: "running",
            exitCode: null, createdAt: new Date().toISOString(), finishedAt: null,
            timeoutSec: null, logMaxBytes: Number(input.logMaxBytes), threadId: (input.threadId as string) ?? null,
            logPath: `/data/jobs/${id}/output.log`, output: "",
          };
          if (startFault === "refuse") throw new Error("start_refused: working directory does not exist: /gone");
          if (startFault === "timeout") throw new Error("host RPC start timed out after 60000 ms");
          // The same fingerprint as the real machine side.
          const fingerprint = requestFingerprint(input as unknown as Parameters<typeof requestFingerprint>[0]);
          if (input.key && keys.has(String(input.key))) {
            const existing = jobs.get(keys.get(String(input.key))!)!;
            if (fingerprints.get(String(input.key)) !== fingerprint) {
              throw new Error(`key_conflict: --key ${String(input.key)} was used for a different request`);
            }
            return { ...publicJob(existing), warnings: [], reused: true };
          }
          jobs.set(id, job);
          if (input.key) {
            keys.set(String(input.key), id);
            fingerprints.set(String(input.key), fingerprint);
          }
          return { ...publicJob(job), warnings: [], reused: false };
        }
        case "get":
          return publicJob(need(input.id));
        case "list":
          return {
            jobs: [...jobs.values()]
              .filter((j) => input.threadId === null || j.threadId === input.threadId)
              .map(publicJob),
          };
        case "logs": {
          const job = need(input.id);
          return { job: publicJob(job), text: job.output, truncated: false, cursor: job.output.length, skippedBytes: 0 };
        }
        case "releaseKey":
          if (keys.has(String(input.key)) && !input.force) {
            throw new Error(`key_in_use: --key ${String(input.key)} belongs to job ${keys.get(String(input.key))} (running); add --force`);
          }
          return keys.delete(String(input.key))
            ? { released: true, state: "done", backup: "/data/keys/x.bak" }
            : { released: false, state: "none", backup: null };
        case "stop": {
          const job = need(input.id);
          if (job.state === "running") job.state = "stopped";
          return publicJob(job);
        }
        default:
          throw new Error(`unexpected host call ${method}`);
      }
    },
  });

  const end = (id: string, exitCode: number, output = `output of ${id}\n`) => {
    const job = jobs.get(id)!;
    job.state = "exited";
    job.exitCode = exitCode;
    job.finishedAt = new Date().toISOString();
    job.output = output;
  };
  const start = async (name: string, extra: string[] = [], threadId = THREAD) => {
    const result = await harness.behavior.runCli(
      ["start", "--name", name, "--cwd", "/tmp", ...extra, "--", "sleep 60"],
      { threadId },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    return result.stdout.split(/\s+/)[0]!;
  };
  const pending = async () =>
    Object.keys((await bb.storage.kv.get<Record<string, unknown>>("notify")) ?? {});

  return {
    bb, harness, jobs, threadStatus, sends, queued, end, start, pending,
    setSend: (b: "ok" | "fail") => { sendBehaviour = b; },
    setStartFault: (f: "none" | "refuse" | "timeout") => { startFault = f; },
  };
}

let current: ReturnType<typeof setup> | null = null;
afterEach(async () => {
  await current?.harness.lifecycle.dispose();
  current = null;
});

async function boot(options: { service?: boolean } = {}) {
  current = setup();
  await plugin(current.bb);
  const t = current;
  const runService = () => t.harness.behavior.runService("notify");
  if (options.service !== false) runService();
  return { ...t, runService };
}

describe("--notify service", () => {
  it("sends one message to an idle thread when a job ends, then forgets it", async () => {
    const t = await boot();
    const id = await t.start("deploy", ["--notify"]);
    assert.deepEqual(await t.pending(), [id]);
    await sleep(150);
    assert.equal(t.sends.length, 0, "nothing while the job runs");
    t.end(id, 0, "deployed\n");
    await until(() => t.sends.length === 1);
    assert.match(t.sends[0]!.text, new RegExp(`^\\[bb jobs\\] A job ended\\.\\n\\n${id} exited 0`));
    assert.match(t.sends[0]!.text, /deployed/);
    await until(async () => (await t.pending()).length === 0);
    await sleep(200);
    assert.equal(t.sends.length, 1, "exactly one message");
  });

  it("puts jobs that end together into one message", async () => {
    const t = await boot();
    const a = await t.start("a", ["--notify"]);
    const b = await t.start("b", ["--notify"]);
    t.end(a, 0);
    t.end(b, 2);
    await until(() => t.sends.length >= 1);
    await sleep(200);
    assert.equal(t.sends.length, 1);
    assert.match(t.sends[0]!.text, /2 jobs ended/);
    assert.match(t.sends[0]!.text, new RegExp(`${a} exited 0`));
    assert.match(t.sends[0]!.text, new RegExp(`${b} exited 2`));
  });

  it("sends nothing when the agent already read the result or stopped the job", async () => {
    // The service starts only after the agent's reads, so it cannot win the race.
    const t = await boot({ service: false });
    const read = await t.start("read", ["--notify"]);
    const stopped = await t.start("stopped", ["--notify"]);
    t.end(read, 0);
    const status = await t.harness.behavior.runCli(["status", read], { threadId: THREAD });
    assert.equal(status.exitCode, 0);
    await t.harness.behavior.runCli(["stop", stopped], { threadId: THREAD });
    t.runService();
    await until(async () => (await t.pending()).length === 0);
    await sleep(200);
    assert.equal(t.sends.length, 0);
  });

  it("withdraws a queued notice when the agent reads the job, and adds later jobs to it", async () => {
    const t = await boot();
    t.threadStatus.set(THREAD, "active");
    const a = await t.start("a", ["--notify"]);
    const b = await t.start("b", ["--notify"]);
    const c = await t.start("c", ["--notify"]);
    t.end(a, 0);
    t.end(b, 0);
    await until(() => (t.queued.get(THREAD) ?? []).length === 1);
    t.end(c, 0);
    await until(() => (t.queued.get(THREAD) ?? [])[0]?.text.includes(c) ?? false);
    assert.equal(t.queued.get(THREAD)!.length, 1, "later job merged into the waiting notice");
    await t.harness.behavior.runCli(["logs", a], { threadId: THREAD });
    const text = t.queued.get(THREAD)![0]!.text;
    assert.ok(!text.includes(a) && text.includes(b) && text.includes(c), text);
    await t.harness.behavior.runCli(["status", b], { threadId: THREAD });
    await t.harness.behavior.runCli(["status", c], { threadId: THREAD });
    assert.equal(t.queued.get(THREAD)!.length, 0, "empty notice deleted");
  });

  it("waits for an idle thread when bb cannot queue, without counting a failure", async () => {
    const t = await boot();
    t.threadStatus.set(THREAD, "active");
    t.setSend("fail");
    const id = await t.start("busy", ["--notify"]);
    t.end(id, 0);
    await until(() =>
      t.harness.inspection.logEntries.some((e) => /notices now wait until their thread is idle/.test(e.message)),
    );
    await sleep(300);
    const entry = ((await t.bb.storage.kv.get<Record<string, { failures?: number }>>("notify")) ?? {})[id];
    assert.ok(entry, "still pending");
    assert.equal(entry!.failures ?? 0, 0, "not counted as a failure");
    t.setSend("ok");
    t.threadStatus.set(THREAD, "idle");
    await until(() => t.sends.length === 1);
    assert.equal(t.sends[0]!.threadId, THREAD);
  });

  it("backs off after a failure to an idle thread instead of dropping the notice", async () => {
    const t = await boot();
    t.setSend("fail");
    const id = await t.start("flaky", ["--notify"]);
    t.end(id, 1);
    await until(async () => {
      const e = ((await t.bb.storage.kv.get<Record<string, { failures?: number }>>("notify")) ?? {})[id];
      return (e?.failures ?? 0) >= 1;
    });
    const entry = ((await t.bb.storage.kv.get<Record<string, { failures?: number; nextAttemptAt?: number }>>("notify")) ?? {})[id]!;
    assert.equal(entry.failures, 1);
    assert.ok(entry.nextAttemptAt! - Date.now() > 20_000, "next try about 30 s later");
    t.setSend("ok");
    await sleep(300);
    assert.equal(t.sends.length, 0, "no retry before the backoff ends");
    assert.deepEqual(await t.pending(), [id], "kept, not dropped");
  });

  it("drops a notice that could not be delivered within 72 hours", async () => {
    const t = await boot();
    await t.bb.storage.kv.set("notify", {
      "old-job-1": { hostId: HOST, threadId: THREAD, addedAt: new Date(Date.now() - 73 * 3600 * 1000).toISOString() },
    });
    await until(async () => (await t.pending()).length === 0);
    assert.ok(t.harness.inspection.logEntries.some((e) => /not delivered within 72 h/.test(e.message)));
  });
});

describe("bb jobs CLI", () => {
  it("lists the calling thread's jobs, or every job with --all", async () => {
    const t = await boot();
    const mine = await t.start("mine");
    const theirs = await t.start("theirs", [], OTHER);
    const own = await t.harness.behavior.runCli(["list"], { threadId: THREAD });
    assert.ok(own.stdout.includes(mine) && !own.stdout.includes(theirs), own.stdout);
    const all = await t.harness.behavior.runCli(["list", "--all"], { threadId: THREAD });
    assert.ok(all.stdout.includes(mine) && all.stdout.includes(theirs), all.stdout);
  });

  it("refuses to stop another thread's running job without --force", async () => {
    const t = await boot();
    const theirs = await t.start("theirs", [], OTHER);
    const refused = await t.harness.behavior.runCli(["stop", theirs], { threadId: THREAD });
    assert.notEqual(refused.exitCode, 0);
    assert.match(refused.stderr + refused.stdout, /belongs to thread thr_other/);
    assert.equal(t.jobs.get(theirs)!.state, "running");
    const forced = await t.harness.behavior.runCli(["stop", theirs, "--force"], { threadId: THREAD });
    assert.equal(forced.exitCode, 0, forced.stderr);
    assert.equal(t.jobs.get(theirs)!.state, "stopped");
  });

  it("says when --key returned an existing job instead of starting one", async () => {
    const t = await boot();
    const first = await t.harness.behavior.runCli(["start", "--cwd", "/tmp", "--key", "rel-1", "--", "true"], { threadId: THREAD });
    const second = await t.harness.behavior.runCli(["start", "--cwd", "/tmp", "--key", "rel-1", "--", "true"], { threadId: THREAD });
    assert.equal(first.exitCode, 0, first.stderr);
    assert.ok(!/Reused job/.test(first.stdout));
    assert.match(second.stdout, /^Reused job \S+: a job with --key rel-1 was already started/);
    assert.equal(t.jobs.size, 1);
  });

  it("reports bad values and refused starts as usage errors", async () => {
    const t = await boot();
    for (const args of [["--memory-max", "lots"], ["--cpu-quota", "1.5"], ["--key", "has space"], ["--env-file", "relative.env"]]) {
      const result = await t.harness.behavior.runCli(["start", "--cwd", "/tmp", ...args, "--", "true"], { threadId: THREAD });
      assert.equal(result.exitCode, 1, args.join(" "));
      assert.doesNotMatch(result.stderr, /failed:/, `${args.join(" ")}: ${result.stderr}`);
    }
    assert.equal(t.jobs.size, 0, "nothing started");
  });

  it("reports key conflicts with their code, and release-key frees a key", async () => {
    const t = await boot();
    await t.harness.behavior.runCli(["start", "--cwd", "/tmp", "--key", "k1", "--", "true"], { threadId: THREAD });
    const conflict = await t.harness.behavior.runCli(["start", "--cwd", "/tmp", "--key", "k1", "--json", "--", "false"], { threadId: THREAD });
    assert.equal(conflict.exitCode, 1);
    assert.equal(JSON.parse(conflict.stdout).error.code, "key_conflict");
    // A different directory is a different request too.
    const elsewhere = await t.harness.behavior.runCli(["start", "--cwd", "/var", "--key", "k1", "--json", "--", "true"], { threadId: THREAD });
    assert.equal(JSON.parse(elsewhere.stdout).error.code, "key_conflict");
    const refused = await t.harness.behavior.runCli(["release-key", "k1", "--json"], { threadId: THREAD });
    assert.equal(refused.exitCode, 1);
    assert.equal(JSON.parse(refused.stdout).error.code, "key_in_use");
    const release = await t.harness.behavior.runCli(["release-key", "k1", "--force"], { threadId: THREAD });
    assert.match(release.stdout, /^Released --key k1/);
    const again = await t.harness.behavior.runCli(["start", "--cwd", "/tmp", "--key", "k1", "--", "false"], { threadId: THREAD });
    assert.equal(again.exitCode, 0, again.stderr);
    assert.equal(t.jobs.size, 2);
  });

  it("tells a refused start from one whose result is unknown", async () => {
    const t = await boot();
    t.setStartFault("refuse");
    const refused = await t.harness.behavior.runCli(["start", "--cwd", "/tmp", "--json", "--", "true"], { threadId: THREAD });
    assert.deepEqual(JSON.parse(refused.stdout).error, { code: "start_refused", message: "working directory does not exist: /gone" });
    t.setStartFault("timeout");
    const unknown = await t.harness.behavior.runCli(["start", "--cwd", "/tmp", "--key", "u1", "--", "true"], { threadId: THREAD });
    assert.equal(unknown.exitCode, 1);
    const json = await t.harness.behavior.runCli(["start", "--cwd", "/tmp", "--key", "u1", "--json", "--", "true"], { threadId: THREAD });
    const error = JSON.parse(json.stdout).error;
    assert.equal(error.code, "start_unknown");
    assert.match(error.message, /not confirmed: host RPC start timed out/);
    assert.match(unknown.stderr + unknown.stdout, /same --key/);
  });

  it("rejects --notify outside a thread with a hint", async () => {
    const t = await boot();
    const result = await t.harness.behavior.runCli(
      ["start", "--cwd", "/tmp", "--notify", "--", "true"],
      {},
    );
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr + result.stdout, /--notify needs a thread/);
  });
});
