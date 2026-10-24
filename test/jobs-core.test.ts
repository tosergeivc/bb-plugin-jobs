import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { JobManager } from "../jobs-core.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 15000): Promise<T> {
  const end = Date.now() + ms;
  let v = await fn();
  while (!ok(v) && Date.now() < end) {
    await sleep(200);
    v = await fn();
  }
  return v;
}

function alive(pattern: string): boolean {
  try {
    execFileSync("pgrep", ["-f", pattern]);
    return true;
  } catch {
    return false;
  }
}

for (const forceDetached of [false, true]) {
  describe(forceDetached ? "detached mode" : "default mode (systemd on Linux)", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bbjobs-test-"));
    const jobs = new JobManager(root, { forceDetached });
    const work = mkdtempSync(path.join(tmpdir(), "bbjobs-cwd-"));
    const base = { cwd: work, env: {}, timeoutSec: null, threadId: null };

    it("runs a shell line in cwd with env and records the exit code", async () => {
      const job = await jobs.start({
        ...base,
        name: "Echo Test",
        command: 'echo "hi $GREETING from $(pwd)" | tr a-z A-Z; exit 3',
        env: { GREETING: "it's me" },
      });
      assert.match(job.id, /^echo-test-[0-9a-f]{6}$/);
      assert.equal(job.mode, forceDetached ? "detached" : "systemd");
      const done = await until(() => jobs.get(job.id), (j) => j.state !== "running");
      assert.equal(done.state, "exited");
      assert.equal(done.exitCode, 3);
      const { text } = await jobs.logs(job.id, 4096);
      assert.ok(text.includes(`HI IT'S ME FROM ${work.toUpperCase()}`), text);
    });

    it("stop kills the whole process tree, including a child in its own group", async () => {
      const n = forceDetached ? 4100 : 4200;
      writeFileSync(path.join(work, "tree.sh"), `sleep ${n} & setsid sleep ${n + 1} & sleep ${n + 2}\n`);
      const job = await jobs.start({ ...base, name: "tree", command: "bash tree.sh" });
      await until(() => jobs.get(job.id), (j) => j.state === "running");
      await sleep(500);
      for (const k of [0, 1, 2]) assert.ok(alive(`^sleep ${n + k}$`), `sleep ${n + k} should run`);
      const stopped = await jobs.stop(job.id);
      assert.equal(stopped.state, "stopped");
      await sleep(300);
      for (const k of [0, 1, 2]) assert.equal(alive(`^sleep ${n + k}$`), false, `sleep ${n + k} should be gone`);
    });

    it("rejects a missing working directory", async () => {
      await assert.rejects(
        jobs.start({ ...base, cwd: path.join(work, "nope"), name: "x", command: "true" }),
        /does not exist/,
      );
    });

    it("timeout ends the job with exit 124", async () => {
      const job = await jobs.start({ ...base, name: "slow", command: "sleep 30", timeoutSec: 1 });
      const done = await until(() => jobs.get(job.id), (j) => j.state !== "running");
      assert.equal(done.exitCode, 124);
    });

    it("timeout kills the command's process group, not just bash", async () => {
      const n = forceDetached ? 4300 : 4400;
      const job = await jobs.start({ ...base, name: "slow-tree", command: `sleep ${n} & sleep ${n + 1}`, timeoutSec: 1 });
      const done = await until(() => jobs.get(job.id), (j) => j.state !== "running");
      assert.equal(done.exitCode, 124);
      await sleep(300);
      for (const k of [0, 1]) assert.equal(alive(`^sleep ${n + k}$`), false, `sleep ${n + k} should be gone`);
      const { text } = await jobs.logs(job.id, 4096);
      assert.match(text, /timed out after 1s/);
    });

    it("a job that ends before its timeout keeps its own exit code and leaves no watchdog", async () => {
      const job = await jobs.start({ ...base, name: "quick", command: "exit 6", timeoutSec: 77 });
      const done = await until(() => jobs.get(job.id), (j) => j.state !== "running");
      assert.equal(done.exitCode, 6);
      await sleep(300);
      assert.equal(alive("^sleep 77$"), false, "watchdog sleep should be gone");
    });

    it("lists newest first", async () => {
      const list = await jobs.list(50);
      assert.ok(list.length >= 3);
      assert.ok(list[0]!.createdAt >= list[list.length - 1]!.createdAt);
    });
  });
}
