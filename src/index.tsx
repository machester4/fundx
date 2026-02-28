#!/usr/bin/env node
import Pastel from "pastel";

const app = new Pastel({
  importMeta: import.meta,
  name: "fundx",
  version: "0.1.0",
  description: "FundX — Autonomous AI Fund Manager powered by the Claude Agent SDK",
});

await app.run();
