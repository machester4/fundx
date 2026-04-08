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
  await app.run();
}
