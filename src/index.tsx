// Internal supervisor runner mode -- spawned as a detached background process by forkSupervisor()
if (process.argv.includes("--_supervisor-mode")) {
  const { startSupervisor } = await import("./services/supervisor.service.js");
  await startSupervisor();
// Internal daemon runner mode -- spawned by supervisor via fork()
} else if (process.argv.includes("--_daemon-mode")) {
  const { startDaemon } = await import("./services/daemon.service.js");
  await startDaemon();
} else {
  const { default: Pastel } = await import("pastel");
  const app = new Pastel({
    importMeta: import.meta,
    name: "fundx",
    version: "0.1.0",
    description: "FundX — Autonomous AI Fund Manager powered by the Claude Agent SDK",
  });
  // Strip the `--` separator that pnpm/npm inserts between script args and user
  // args when the CLI is invoked via `pnpm dev -- eval --case foo`. pnpm passes
  // process.argv as [node, index.tsx, --, eval, --case, foo]. Commander interprets
  // `--` as "end of options", silently swallowing all named flags that follow.
  // We remove it only when it appears at index 2 (immediately after the script path).
  const argv =
    process.argv[2] === "--"
      ? [process.argv[0], process.argv[1], ...process.argv.slice(3)]
      : process.argv;
  await app.run(argv);
}
