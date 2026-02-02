import { spawn } from "node:child_process";
import process from "node:process";

const extraNodeOption = "--disable-warning=DEP0040";
const existingNodeOptions = process.env.NODE_OPTIONS ?? "";

if (!existingNodeOptions.includes(extraNodeOption)) {
  process.env.NODE_OPTIONS = `${existingNodeOptions} ${extraNodeOption}`.trim();
}

const [entry, ...args] = process.argv.slice(2);

if (!entry) {
  // eslint-disable-next-line no-console
  console.error("Usage: node scripts/run.mjs <entry> [...args]");
  process.exit(2);
}

const child = spawn(process.execPath, [entry, ...args], { stdio: "inherit", env: process.env });

child.on("close", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

