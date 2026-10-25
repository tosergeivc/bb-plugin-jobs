// Typechecks the plugin against the newest published @get-bb/plugin-sdk.
// `npm run typecheck` first checks against the SDK pinned in devDependencies
// (the oldest supported, 0.6.43), then runs this, so CI catches APIs that are
// too new as well as APIs that newer SDKs removed or changed.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const work = path.join(root, ".typecheck-latest");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
for (const file of ["contract.ts", "host.ts", "server.ts", "jobs-core.ts", "tsconfig.json"]) {
  cpSync(path.join(root, file), path.join(work, file));
}
writeFileSync(
  path.join(work, "package.json"),
  JSON.stringify(
    {
      name: "bb-plugin-jobs-typecheck-latest",
      private: true,
      type: "module",
      dependencies: { zod: pkg.dependencies.zod },
      devDependencies: {
        "@get-bb/plugin-sdk": "latest",
        "@types/node": pkg.devDependencies["@types/node"],
        typescript: pkg.devDependencies.typescript,
      },
    },
    null,
    2,
  ),
);

const run = (cmd, args) => execFileSync(cmd, args, { cwd: work, stdio: "inherit" });
run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"]);
const sdk = JSON.parse(
  readFileSync(path.join(work, "node_modules/@get-bb/plugin-sdk/package.json"), "utf8"),
).version;
console.log(`typecheck against @get-bb/plugin-sdk ${sdk} (latest)`);
run("npx", ["tsc", "--noEmit"]);
rmSync(work, { recursive: true, force: true });
