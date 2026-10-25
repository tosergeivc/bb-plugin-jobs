// Several processes start with one --key at the same moment. Only one of them
// may start the command; the others get the same job back or key_busy.
// Each racer is this file run again as a plain node script (RACE_WORKER=1).
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { JobManager, keyHash } from "../jobs-core.ts";

const RACERS = 3;
const ROUNDS = 6;

type Outcome = { id?: string; reused?: boolean; error?: string };

async function worker(): Promise<void> {
  const [root, key, at] = process.argv.slice(2) as [string, string, string];
  const jobs = new JobManager(root, { forceDetached: true });
  while (Date.now() < Number(at)) {} // start together
  let out: Outcome;
  try {
    const job = await jobs.startWithChecks({
      name: "race", command: "sleep 0.3", cwd: "/tmp", env: {}, timeoutSec: null, threadId: null, key,
    });
    out = { id: job.id, reused: job.reused };
  } catch (error) {
    out = { error: (error as Error).message.split(":")[0] };
  }
  process.stdout.write(JSON.stringify(out));
}

if (process.env.RACE_WORKER === "1") {
  await worker();
} else {
  const { describe, it } = await import("node:test");
  const self = fileURLToPath(import.meta.url);
  const exec = promisify(execFile);

  const race = async (root: string, key: string): Promise<Outcome[]> => {
    const at = String(Date.now() + 400);
    const runs = Array.from({ length: RACERS }, () =>
      exec(process.execPath, [self, root, key, at], { env: { ...process.env, RACE_WORKER: "1" } }),
    );
    return (await Promise.all(runs)).map((r) => JSON.parse(r.stdout) as Outcome);
  };
  const started = (root: string) =>
    readdirSync(path.join(root, "jobs"), { withFileTypes: true }).filter((d) => d.isDirectory()).length;
  const check = (outcomes: Outcome[], label: string) => {
    const fresh = outcomes.filter((o) => o.reused === false);
    assert.equal(fresh.length, 1, `${label}: exactly one racer starts the job: ${JSON.stringify(outcomes)}`);
    for (const o of outcomes) {
      if (o.error) assert.equal(o.error, "key_busy", `${label}: ${JSON.stringify(outcomes)}`);
      else assert.equal(o.id, fresh[0]!.id, `${label}: same job for everyone`);
    }
  };
  const deadPid = () =>
    new Promise<number>((resolve) => {
      const child = spawn("true");
      child.on("exit", () => resolve(child.pid!));
    });

  describe(`--key across ${RACERS} processes`, () => {
    it("a fresh key starts the command once", async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const root = mkdtempSync(path.join(tmpdir(), "bbjobs-race1-"));
        check(await race(root, "fresh"), `round ${round}`);
        assert.equal(started(root), 1, `round ${round}: one job directory`);
      }
    });

    it("a key whose job was pruned starts the command once", async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const root = mkdtempSync(path.join(tmpdir(), "bbjobs-race2-"));
        const jobs = new JobManager(root, { forceDetached: true });
        const first = await jobs.startWithChecks({
          name: "race", command: "true", cwd: "/tmp", env: {}, timeoutSec: null, threadId: null, key: "pruned",
        });
        while ((await jobs.get(first.id)).state === "running") await new Promise((r) => setTimeout(r, 50));
        await jobs.prune(0, { remove: false, dryRun: false });
        check(await race(root, "pruned"), `round ${round}`);
        assert.equal(started(root), 1, `round ${round}: one new job directory`);
      }
    });

    it("a pending claim of a dead process with no job starts the command once", async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const root = mkdtempSync(path.join(tmpdir(), "bbjobs-race3-"));
        // Both the 0.5.2 claim file and a claim generation of a dead start.
        const claim = JSON.stringify({ state: "pending", pid: await deadPid(), jobId: null, fingerprint: null });
        if (round % 2) {
          mkdirSync(path.join(root, "keys"), { recursive: true });
          writeFileSync(path.join(root, "keys", keyHash("dead")), claim);
        } else {
          mkdirSync(path.join(root, "claims", keyHash("dead")), { recursive: true });
          writeFileSync(path.join(root, "claims", keyHash("dead"), "00000001"), claim);
        }
        mkdirSync(path.join(root, "jobs"), { recursive: true });
        check(await race(root, "dead"), `round ${round}`);
        assert.equal(started(root), 1, `round ${round}: one job directory`);
      }
    });
  });
}
