import { Command } from "commander";
import { initCommand } from "./init.js";
import { fundCommand } from "./fund.js";
import { statusCommand } from "./status.js";
import { sessionCommand } from "./session.js";
import { startCommand, stopCommand } from "./daemon.js";
import { logsCommand } from "./logs.js";
import { portfolioCommand } from "./portfolio-cmd.js";
import { tradesCommand } from "./trades-cmd.js";
import { performanceCommand } from "./performance-cmd.js";
import { gatewayCommand } from "./gateway.js";
import { askCommand } from "./ask.js";

const program = new Command()
  .name("fundx")
  .description("FundX — Autonomous AI Fund Manager powered by Claude Code")
  .version("0.1.0");

program.addCommand(initCommand);
program.addCommand(fundCommand);
program.addCommand(statusCommand);
program.addCommand(sessionCommand);
program.addCommand(startCommand);
program.addCommand(stopCommand);
program.addCommand(logsCommand);
program.addCommand(portfolioCommand);
program.addCommand(tradesCommand);
program.addCommand(performanceCommand);
program.addCommand(gatewayCommand);
program.addCommand(askCommand);

program.parse();
