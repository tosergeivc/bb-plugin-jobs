// Runs inside the bb daemon on the machine that owns the job. Thin RPC
// adapter over JobManager; jobs themselves never depend on this worker.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./contract.js";
import { JobManager } from "./jobs-core.js";

let manager: JobManager | null = null;
function jobs(dataDir: string): JobManager {
  manager ??= new JobManager(dataDir);
  return manager;
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    start: (input, ctx) => jobs(ctx.experimental_paths.dataDir).start(input),
    list: async ({ limit }, ctx) => ({
      jobs: await jobs(ctx.experimental_paths.dataDir).list(limit),
    }),
    get: ({ id }, ctx) => jobs(ctx.experimental_paths.dataDir).get(id),
    logs: ({ id, maxBytes }, ctx) =>
      jobs(ctx.experimental_paths.dataDir).logs(id, maxBytes),
    stop: ({ id }, ctx) => jobs(ctx.experimental_paths.dataDir).stop(id),
    ready: ({ id, url, logPattern, timeoutMs }, ctx) =>
      jobs(ctx.experimental_paths.dataDir).ready(id, { url, logPattern }, timeoutMs),
    prune: ({ olderThanMs, delete: remove, dryRun }, ctx) =>
      jobs(ctx.experimental_paths.dataDir).prune(olderThanMs, { remove, dryRun }),
  },
});
