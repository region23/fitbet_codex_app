import { spawn } from "node:child_process";
import process from "node:process";

const extraNodeOption = "--disable-warning=DEP0040";
const existingNodeOptions = process.env.NODE_OPTIONS ?? "";

if (!existingNodeOptions.includes(extraNodeOption)) {
  process.env.NODE_OPTIONS = `${existingNodeOptions} ${extraNodeOption}`.trim();
}

const args = process.argv.slice(2);
const child = spawn(process.execPath, ["node_modules/vitest/vitest.mjs", ...args], {
  stdio: "inherit",
  env: process.env
});

child.on("close", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
