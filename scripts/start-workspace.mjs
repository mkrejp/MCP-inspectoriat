import { spawn } from "node:child_process";

const children = [
  spawn(process.execPath, ["scripts/start-inspector.mjs"], { stdio: "inherit" }),
  spawn(process.execPath, ["scripts/dashboard-server.mjs"], { stdio: "inherit" }),
];
let stopping = false;

function stopChildren(signal) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  }
}

for (const child of children) {
  child.on("error", (error) => {
    console.error("Failed to start workspace service:", error.message);
    process.exitCode = 1;
    stopChildren("SIGTERM");
  });
  child.on("exit", (code, signal) => {
    if (!stopping && (code !== 0 || signal)) {
      process.exitCode = code ?? 1;
      stopChildren("SIGTERM");
    }
  });
}

process.on("SIGINT", () => stopChildren("SIGINT"));
process.on("SIGTERM", () => stopChildren("SIGTERM"));