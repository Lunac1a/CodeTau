#!/usr/bin/env node

const command = process.argv[2] ?? "help";

if (command === "doctor") {
  console.log(JSON.stringify({
    ok: true,
    node: process.version,
    platform: process.platform,
    architecture: "terminal-first agent skeleton"
  }, null, 2));
} else {
  console.log(`CodeTau Agent skeleton

Usage:
  pnpm start doctor   verify the local runtime

Agent commands will be added after the event and task-state specs are frozen.`);
}

