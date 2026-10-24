// Host RPC contract shared by server.ts (caller) and host.ts (runs on the
// machine where the job must live). Both sides validate at the wire.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const JOB_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const jobId = z.string().regex(JOB_ID_PATTERN);

export const jobStateSchema = z.enum([
  "running", // process tree alive
  "exited", // finished and recorded its exit code
  "stopped", // stopped through `bb jobs stop`
  "lost", // gone without an exit code (reboot, OOM, killed from outside)
]);
export type JobState = z.infer<typeof jobStateSchema>;

export const jobSchema = z.object({
  id: z.string(),
  name: z.string(),
  command: z.string(),
  cwd: z.string(),
  mode: z.enum(["systemd", "detached"]),
  unit: z.string().nullable(),
  pid: z.number().int().nullable(),
  state: jobStateSchema,
  exitCode: z.number().int().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  timeoutSec: z.number().int().nullable(),
  threadId: z.string().nullable(),
  logPath: z.string(),
});
export type Job = z.infer<typeof jobSchema>;

export const hostContract = defineRpcContract({
  start: {
    input: z
      .object({
        name: z.string().min(1).max(64),
        command: z.string().min(1).max(64 * 1024),
        cwd: z.string().min(1),
        env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()),
        timeoutSec: z.number().int().positive().nullable(),
        threadId: z.string().nullable(),
      })
      .strict(),
    output: jobSchema,
  },
  list: {
    input: z.object({ limit: z.number().int().min(1).max(500) }).strict(),
    output: z.object({ jobs: z.array(jobSchema) }).strict(),
  },
  get: {
    input: z.object({ id: jobId }).strict(),
    output: jobSchema,
  },
  logs: {
    input: z
      .object({ id: jobId, maxBytes: z.number().int().min(1).max(512 * 1024) })
      .strict(),
    output: z
      .object({ job: jobSchema, text: z.string(), truncated: z.boolean() })
      .strict(),
  },
  stop: {
    input: z.object({ id: jobId }).strict(),
    output: jobSchema,
  },
});
