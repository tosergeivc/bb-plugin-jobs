import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { JobManager, cleanTerminalText, isLaunchLine } from "../jobs-core.ts";

function grepDir(dir: string, needle: string): string[] {
  return readdirSync(dir).filter((f) => readFileSync(path.join(dir, f), "utf8").includes(needle));
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer().listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

/** Processes that mention a job directory, for failure messages. */
function psLines(dir: string): string {
  try {
    return execFileSync("ps", ["-A", "-ww", "-o", "pid=,ppid=,pgid=,command="])
      .toString()
      .split("\n")
      .filter((l) => l.includes(dir))
      .join(" | ");
  } catch (error) {
    return String(error);
  }
}

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

describe("isLaunchLine", () => {
  const dir = "/data/jobs/srv-1a2b3c";
  it("accepts the job's own launch lines under any interpreter path or version", () => {
    for (const line of [
      `perl ${dir}/exec.pl ${dir} 0 0 bash ${dir}/command.sh`,
      `/usr/bin/perl5.34 ${dir}/exec.pl ${dir} 52428800 0 bash ${dir}/command.sh`,
      `/bin/bash ${dir}/runner.sh ${dir}`,
      `bash ${dir}/runner.sh ${dir}`,
      `bash ${dir}/command.sh`,
      `/opt/homebrew/bin/bash ${dir}/command.sh`,
    ]) assert.ok(isLaunchLine(line, dir), line);
  });
  it("rejects strangers that only mention the job directory", () => {
    for (const line of [
      `tail -f ${dir}/output.log`,
      `cat ${dir}/command.sh`,
      `bash -c cat ${dir}/command.sh`,
      `vim ${dir}/exec.pl`,
      `perl ${dir}/exec.pl.bak`,
      `bash /data/jobs/srv-1a2b3cX/command.sh`,
      `perl /data/jobs/srv-1a2b3c-other/exec.pl x`,
    ]) assert.equal(isLaunchLine(line, dir), false, line);
  });
});

describe("cleanTerminalText", () => {
  it("drops colour and OSC codes and keeps the last redraw of a line", () => {
    const raw = "\x1b[32m✓ built\x1b[0m in \x1b[1m1.2s\x1b[0m\n" +
      "\x1b]0;title\x07progress 10%\rprogress 50%\rprogress 100%\n" +
      "windows line\r\n" +
      "\x1b[2K\x1b[1Gdone";
    assert.equal(cleanTerminalText(raw), "✓ built in 1.2s\nprogress 100%\nwindows line\ndone");
  });
});

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
      assert.equal(job.mode, (await jobs.hasSystemd()) ? "systemd" : "detached");
      const done = await until(() => jobs.get(job.id), (j) => j.state !== "running");
      assert.equal(done.state, "exited");
      assert.equal(done.exitCode, 3);
      const { text } = await jobs.logs(job.id, 4096);
      assert.ok(text.includes(`HI IT'S ME FROM ${work.toUpperCase()}`), text);
    });

    it("stop kills the whole process tree, including a child in its own group", async () => {
      const n = forceDetached ? 4100 : 4200;
      writeFileSync(path.join(work, "tree.sh"), `sleep ${n} & perl -e 'use POSIX; POSIX::setsid(); exec @ARGV' sleep ${n + 1} & sleep ${n + 2}\n`);
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

    it("--env values reach the command but are not left on disk", async () => {
      const secret = `s3cr3t-${forceDetached ? "d" : "s"}-'quoted' $notexpanded\nline2`;
      const job = await jobs.start({
        ...base,
        name: "env",
        command: 'printf "%s" "$TOKEN" | wc -c; echo "dir=$dir code=$code"; echo "envfile=${BBJOBS_ENV_FILE:-unset}"',
        env: { TOKEN: secret, dir: "clobber", code: "77" },
      });
      const done = await until(() => jobs.get(job.id), (j) => j.state !== "running");
      assert.equal(done.state, "exited");
      assert.equal(done.exitCode, 0);
      const { text } = await jobs.logs(job.id, 4096);
      assert.match(text, new RegExp(`^\\s*${Buffer.byteLength(secret)}$`, "m"), text);
      assert.match(text, /dir=clobber code=77/);
      assert.match(text, /envfile=unset/);
      const jobDir = path.dirname(done.logPath);
      assert.equal(existsSync(path.join(jobDir, "env.sh")), false);
      assert.deepEqual(grepDir(jobDir, "s3cr3t"), []);
    });

    it("--env file is removed when the job cannot start", async () => {
      const gone = mkdtempSync(path.join(tmpdir(), "bbjobs-gone-"));
      const job = await jobs.start({ ...base, cwd: gone, name: "nocd", command: "true", env: { TOKEN: "s3cr3t-nocd" } });
      // remove cwd only after start validated it: the runner's cd fails
      execFileSync("rmdir", [gone]);
      const done = await until(() => jobs.get(job.id), (j) => j.state !== "running");
      const jobDir = path.dirname(done.logPath);
      assert.deepEqual(grepDir(jobDir, "s3cr3t"), []);
    });

    it("records the exit code even when a leftover child keeps the output open, and stop still finds it", async () => {
      const n = forceDetached ? 4700 : 4710;
      const job = await jobs.start({ ...base, name: "leftover", command: `sleep ${n} & echo bye; exit 3` });
      const done = await until(() => jobs.get(job.id), (j) => j.state !== "running", 5000);
      assert.equal(done.state, "exited");
      assert.equal(done.exitCode, 3);
      assert.ok(alive(`^sleep ${n}$`), "leftover child keeps running");
      await jobs.stop(job.id);
      await sleep(300);
      assert.equal(alive(`^sleep ${n}$`), false, "stop kills the leftover child");
    });

    it("caps the log: rotates to output.log.1 and logs() still returns the newest lines", async () => {
      const job = await jobs.start({
        ...base,
        name: "chatty",
        command: 'for i in $(seq 1 600); do printf "line %04d %0150d\\n" "$i" 0; done',
        logMaxBytes: 20000,
      });
      await until(() => jobs.get(job.id), (j) => j.state !== "running");
      const dir = path.dirname(job.logPath);
      assert.ok(existsSync(path.join(dir, "output.log.1")), "rotated file exists");
      const kept = statSync(job.logPath).size + statSync(path.join(dir, "output.log.1")).size;
      assert.ok(kept < 2 * (20000 + 65536), `kept ${kept} bytes`);
      assert.ok(kept < 600 * 160, "older output was dropped");
      const { text, job: seen } = await jobs.logs(job.id, 4096);
      assert.match(text, /line 0600 /);
      assert.match(text, /exited 0/, `state=${seen.state} exit=${seen.exitCode}; ps: ${psLines(dir)}`);
    });

    it("ready: URL answers, log line appears, job exits early, or times out", async () => {
      const port = await freePort();
      const server = await jobs.start({
        ...base,
        name: "srv",
        command: `sleep 1; echo "listening on ${port}"; exec node -e "require('http').createServer((q, s) => s.end('ok')).listen(${port}, '127.0.0.1')"`,
      });
      const byUrl = await jobs.ready(server.id, { url: `http://127.0.0.1:${port}/`, logPattern: null }, 20000);
      if (byUrl.outcome !== "ready") {
        const { text } = await jobs.logs(server.id, 4096);
        assert.fail(`ready=${byUrl.outcome} (${byUrl.detail}); state=${byUrl.job.state}; log:\n${text}; ps: ${psLines(path.dirname(server.logPath))}`);
      }
      assert.ok(byUrl.waitedMs >= 500, "not ready before the server started");
      const byLog = await jobs.ready(server.id, { url: null, logPattern: `listening on \\d+` }, 5000);
      assert.equal(byLog.outcome, "ready", byLog.detail);
      const slow = await jobs.ready(server.id, { url: null, logPattern: "never printed" }, 1500);
      assert.equal(slow.outcome, "timeout");
      assert.equal(slow.job.state, "running");
      await jobs.stop(server.id);
      const crash = await jobs.start({ ...base, name: "crash", command: "echo boom; exit 2" });
      const early = await jobs.ready(crash.id, { url: `http://127.0.0.1:${port}/`, logPattern: null }, 20000);
      assert.equal(early.outcome, "exited");
      assert.ok(early.waitedMs < 10000);
    });

    it("never reports or signals a stranger that took over the job's PID", async () => {
      const n = forceDetached ? 4800 : 4810;
      const job = await jobs.start({ ...base, name: "reuse", command: "exit 0" });
      await until(() => jobs.get(job.id), (j) => j.state !== "running");
      const dir = path.dirname(job.logPath);
      // exec.pl records the exit code, then drains the pipe and exits.
      await until(async () => alive(`exec.pl ${dir}`), (a) => !a, 5000);
      const meta = JSON.parse(readFileSync(path.join(dir, "meta.json"), "utf8"));
      // Strangers that mention the job directory in their arguments: an agent
      // tailing the log, and a command that merely names command.sh. We plant
      // one stranger's PID in meta.json as if the PID had been reused.
      const tail = spawn("tail", ["-f", path.join(dir, "output.log")], { detached: true, stdio: "ignore" });
      const stranger = spawn("bash", ["-c", `sleep ${n}`, path.join(dir, "command.sh")], {
        detached: true,
        stdio: "ignore",
      });
      tail.unref();
      stranger.unref();
      await sleep(300);
      writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ ...meta, mode: "detached", unit: null, pid: stranger.pid }));
      writeFileSync(path.join(dir, "pgid"), `${stranger.pid}\n`);
      rmSync(path.join(dir, "exit"));
      const now = await jobs.get(job.id);
      assert.equal(now.state, "lost");
      try {
        await jobs.stop(job.id);
        assert.ok(alive(`^sleep ${n}$`), "stranger must survive stop");
        assert.ok(alive(`^tail -f ${dir}/output.log$`), "log tail must survive stop");
      } finally {
        process.kill(tail.pid!, "SIGKILL");
        process.kill(stranger.pid!, "SIGKILL");
      }
    });

    it("prune: dry run, archive, delete; running jobs stay", async () => {
      // Own root, so pruning does not remove jobs other tests list.
      const jobs = new JobManager(mkdtempSync(path.join(tmpdir(), "bbjobs-prune-")), { forceDetached });
      const keep = await jobs.start({ ...base, name: "keep", command: "sleep 30" });
      const old = await jobs.start({ ...base, name: "old", command: "true" });
      await until(() => jobs.get(old.id), (j) => j.state !== "running");
      await sleep(50);
      const dry = await jobs.prune(0, { remove: false, dryRun: true });
      assert.ok(dry.pruned.some((p) => p.id === old.id));
      assert.ok(!dry.pruned.some((p) => p.id === keep.id));
      assert.ok(existsSync(path.dirname(old.logPath)), "dry run moves nothing");
      const none = await jobs.prune(3600_000, { remove: false, dryRun: false });
      assert.ok(!none.pruned.some((p) => p.id === old.id), "too young to prune");
      const archived = await jobs.prune(0, { remove: false, dryRun: false });
      assert.ok(archived.pruned.some((p) => p.id === old.id));
      assert.ok(existsSync(path.join(archived.archiveDir, old.id, "output.log")));
      await assert.rejects(jobs.get(old.id), /no job/);
      assert.equal((await jobs.get(keep.id)).state, "running");
      await jobs.stop(keep.id);
      const deleted = await jobs.prune(0, { remove: true, dryRun: false });
      assert.ok(deleted.pruned.some((p) => p.id === keep.id));
      assert.equal(existsSync(path.dirname(keep.logPath)), false);
    });

    it("puts [jobs] lines on their own line and passes BB_* context", async () => {
      const job = await jobs.startWithChecks({
        ...base,
        name: "ctx",
        command: 'printf "%s|%s" "$BB_THREAD_ID" "$BB_THREAD_STORAGE"',
        bbEnv: { BB_THREAD_ID: "thr_test", BB_THREAD_STORAGE: "/tmp/store", NOT_BB: "x" },
      });
      assert.ok(Array.isArray(job.warnings));
      await until(() => jobs.get(job.id), (j) => j.state !== "running");
      const { text } = await jobs.logs(job.id, 4096);
      assert.match(text, /^thr_test\|\/tmp\/store\n\[jobs\] exited 0 /m, text);
    });

    it("logs --since returns only new whole lines and a cursor to continue from", async () => {
      const job = await jobs.start({
        ...base,
        name: "cursor",
        command: 'echo one; echo two; sleep 1.5; printf "three\n\033[31mfour\033[0m\n"; sleep 1; printf "partial"; sleep 1; echo " line"',
      });
      await sleep(800);
      const first = await jobs.logs(job.id, 4096, { since: 0 });
      assert.match(first.text, /one\ntwo\n$/);
      const second = await until(() => jobs.logs(job.id, 4096, { since: first.cursor }), (r) => r.text.includes("four"));
      assert.equal(second.text, "three\nfour\n", "only new lines, colour removed");
      // While "partial" has no newline yet, it is held back.
      await sleep(600);
      const held = await jobs.logs(job.id, 4096, { since: second.cursor });
      assert.ok(!held.text.includes("partial"), held.text);
      await until(() => jobs.get(job.id), (j) => j.state !== "running");
      const rest = await jobs.logs(job.id, 4096, { since: held.cursor });
      assert.match(rest.text, /^partial line\n\[jobs\] exited 0 /);
      const raw = await jobs.logs(job.id, 4096, { raw: true });
      assert.ok(raw.text.includes("\x1b[31m"), "--raw keeps escape codes");
    });

    it("logs --since pages through rotated output and reports what was rotated away", async () => {
      const job = await jobs.start({
        ...base,
        name: "pages",
        command: 'for i in $(seq 1 3000); do printf "row %05d\n" "$i"; done',
        logMaxBytes: 10000,
      });
      await until(() => jobs.get(job.id), (j) => j.state !== "running");
      const lost = await jobs.logs(job.id, 4096, { since: 0 });
      assert.ok(lost.skippedBytes > 0, "early output was rotated away");
      const rows: string[] = [];
      let cursor = 0;
      for (let i = 0; i < 50; i++) {
        const page = await jobs.logs(job.id, 4096, { since: cursor });
        rows.push(...page.text.split("\n").filter((l) => l.startsWith("row ")));
        if (page.cursor === cursor) break;
        cursor = page.cursor;
      }
      assert.equal(rows.at(-1), "row 03000");
      const numbers = rows.map((r) => Number(r.slice(4)));
      for (let i = 1; i < numbers.length; i++) assert.equal(numbers[i], numbers[i - 1]! + 1, "no gaps or repeats");
    });

    it("list filters by thread", async () => {
      const mine = await jobs.start({ ...base, name: "mine", command: "true", threadId: "thr_a" });
      const other = await jobs.start({ ...base, name: "other", command: "true", threadId: "thr_b" });
      const ids = (await jobs.list(500, "thr_a")).map((j) => j.id);
      assert.ok(ids.includes(mine.id));
      assert.ok(!ids.includes(other.id));
      assert.ok((await jobs.list(500)).some((j) => j.id === other.id));
    });

    it("writes [jobs] exited after all of the command's output", async () => {
      for (let round = 0; round < 5; round++) {
        const job = await jobs.start({
          ...base,
          name: "burst",
          command: 'head -c 400000 /dev/zero | tr "\\0" x | fold -w 100; echo; echo LAST-LINE; exit 0',
          logMaxBytes: 0,
        });
        await until(() => jobs.get(job.id), (j) => j.state !== "running");
        const lines = readFileSync(job.logPath, "utf8").trimEnd().split("\n");
        assert.match(lines.at(-1)!, /^\[jobs\] exited 0 /, `round ${round}: last lines ${JSON.stringify(lines.slice(-3))}`);
        assert.equal(lines.at(-2), "LAST-LINE", `round ${round}`);
      }
    });

    it("--key: a repeated or concurrent start returns the same job; a failed start frees the key", async () => {
      const keyed = new JobManager(mkdtempSync(path.join(tmpdir(), "bbjobs-key-")), { forceDetached });
      const input = { ...base, name: "keyed", command: "sleep 20", key: "deploy:release-42" };
      const [a, b, c] = await Promise.all([keyed.startWithChecks(input), keyed.startWithChecks(input), keyed.startWithChecks(input)]);
      assert.equal(a.id, b.id);
      assert.equal(b.id, c.id);
      assert.equal([a, b, c].filter((j) => !j.reused).length, 1, "exactly one start");
      assert.equal((await keyed.list(50)).length, 1, "one job on disk");
      const again = await keyed.startWithChecks(input);
      assert.equal(again.id, a.id);
      assert.equal(again.reused, true);
      await keyed.stop(a.id);
      // A finished job still owns its key; after prune the key is free again.
      assert.equal((await keyed.startWithChecks(input)).id, a.id);
      await keyed.prune(0, { remove: false, dryRun: false });
      const fresh = await keyed.startWithChecks({ ...input, command: "true" });
      assert.notEqual(fresh.id, a.id);
      assert.equal(fresh.reused, false);
      // A start that fails releases its key.
      await assert.rejects(keyed.startWithChecks({ ...input, key: "bad-cwd", cwd: "/nonexistent" }), /does not exist/);
      const ok = await keyed.startWithChecks({ ...input, key: "bad-cwd", command: "true" });
      assert.equal(ok.reused, false);
    });

    it("--env-file: values reach the command without being copied into the job directory", async () => {
      const envPath = path.join(work, "secrets.env");
      writeFileSync(envPath, "# deploy secrets\nexport TOKEN=sentinel-7f3a\nNAME=\"two words\"\nbad-name=x\n", { mode: 0o600 });
      const job = await jobs.startWithChecks({
        ...base,
        name: "envfile",
        command: 'printf "%s|%s\\n" "$TOKEN" "$NAME"',
        envFile: envPath,
      });
      assert.deepEqual(job.warnings, []);
      await until(() => jobs.get(job.id), (j) => j.state !== "running");
      const { text } = await jobs.logs(job.id, 4096);
      assert.match(text, /^sentinel-7f3a\|two words$/m);
      const dir = path.dirname(job.logPath);
      assert.deepEqual(grepDir(dir, "sentinel-7f3a").filter((f) => f !== "output.log"), [], "not stored outside the job's own output");
      await assert.rejects(jobs.startWithChecks({ ...base, name: "x", command: "true", envFile: path.join(work, "missing.env") }), /--env-file not found/);
      await assert.rejects(jobs.startWithChecks({ ...base, name: "x", command: "true", envFile: "relative.env" }), /absolute path/);
      writeFileSync(path.join(work, "open.env"), "A=1\n", { mode: 0o644 });
      const open = await jobs.startWithChecks({ ...base, name: "open", command: "true", envFile: path.join(work, "open.env") });
      assert.match(open.warnings.join(" "), /readable by other users/);
    });

    it("resource limits and --require-systemd apply in systemd mode and refuse otherwise", async () => {
      const limited = { ...base, name: "limited", command: "sleep 20", memoryMax: "64M", cpuQuota: "50%", tasksMax: 32 };
      if (await jobs.hasSystemd()) {
        const job = await jobs.startWithChecks({ ...limited, requireSystemd: true });
        const show = execFileSync("systemctl", ["--user", "show", job.unit!, "-p", "MemoryMax", "-p", "TasksMax", "-p", "CPUQuotaPerSecUSec"]).toString();
        assert.match(show, /MemoryMax=67108864/);
        assert.match(show, /TasksMax=32/);
        assert.match(show, /CPUQuotaPerSecUSec=500ms/);
        await jobs.stop(job.id);
      } else {
        await assert.rejects(jobs.startWithChecks(limited), /need user systemd/);
        await assert.rejects(jobs.startWithChecks({ ...base, name: "strict", command: "true", requireSystemd: true }), /--require-systemd/);
      }
      await assert.rejects(jobs.startWithChecks({ ...base, name: "bad", command: "true", memoryMax: "lots" }), /bad --memory-max/);
      await assert.rejects(jobs.startWithChecks({ ...base, name: "bad", command: "true", cpuQuota: "1.5" }), /bad --cpu-quota/);
    });

    it("lists newest first", async () => {
      const list = await jobs.list(50);
      assert.ok(list.length >= 3);
      assert.ok(list[0]!.createdAt >= list[list.length - 1]!.createdAt);
    });
  });
}
