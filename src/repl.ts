import readline from "readline";
import { execSync } from "child_process";
import chalk from "chalk";
import { runAgent, type SimpleMessage } from "./agent.js";
import { createProvider, type ProviderName } from "./providers/index.js";
import type { Provider } from "./providers/types.js";
import type { ToolInput } from "./tools.js";
import { createSessionLogger, listLogs, LOG_DIR } from "./logger.js";
import { loadConfig, resolveModel } from "./config.js";
import { initSystemPrompt } from "./system-prompt.js";

function formatToolStart(name: string, input: ToolInput): string {
  let detail = "";
  if (name === "shell" && input.command) {
    const cmd = input.command.length > 100
      ? input.command.slice(0, 100) + "…"
      : input.command;
    detail = chalk.gray(` $ ${cmd}`);
  } else if (name === "read_file" && input.path) {
    detail = chalk.gray(` ${input.path}`);
  }
  return chalk.yellow(`  ⚙ ${name}`) + detail;
}

function formatToolEnd(result: string): string {
  const lines = result.split("\n");
  const preview = lines.slice(0, 3).join("\n");
  const suffix = lines.length > 3 ? chalk.gray(`\n  … (${lines.length} lines)`) : "";
  return chalk.gray("  ↳ ") + chalk.dim(preview) + suffix;
}

// ── Slash commands ──────────────────────────────────────────────────────────

const COMMANDS = [
  { cmd: "/model [name]",      desc: "Pick from a numbered model list, or switch directly" },
  { cmd: "/provider [name]",   desc: "Show current provider or switch to another" },
  { cmd: "/clear",             desc: "Clear conversation history" },
  { cmd: "/logs",              desc: "List recent session logs" },
  { cmd: "/help",              desc: "Show this command list" },
  { cmd: "/exit",              desc: "Exit the agent" },
];

function showCommands(): void {
  console.log();
  console.log(chalk.bold("  Commands:"));
  for (const { cmd, desc } of COMMANDS) {
    console.log(`  ${chalk.cyan(cmd.padEnd(24))} ${chalk.gray(desc)}`);
  }
  console.log();
}

// ── REPL ────────────────────────────────────────────────────────────────────

export async function startRepl(initialProvider: Provider): Promise<void> {
  let provider = initialProvider;
  let logger = createSessionLogger(provider.providerName, provider.model);
  let messages: SimpleMessage[] = [];

  // Bootstrap CLI capabilities into the system prompt.
  // Shows a one-time install tip if cascade is not found.
  try {
    const caps = execSync("cascade capabilities", {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    initSystemPrompt(caps);
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? "";
    const notInstalled =
      stderr.includes("not found") ||
      stderr.includes("No such file") ||
      stderr.includes("command not found") ||
      stderr.includes("ENOENT");
    if (notInstalled) {
      console.log(
        chalk.gray("  Tip: install the Cascade CLI for full functionality:\n") +
        chalk.cyan("    npm install -g @the-cascade-protocol/cli\n")
      );
    }
  }

  function printHeader(): void {
    console.log(
      `\n${chalk.bold.cyan("Cascade Agent")}` +
      chalk.gray(` (${provider.providerName} / ${provider.model})`)
    );
    console.log(
      chalk.gray("Type your request, or ") +
      chalk.cyan("/help") +
      chalk.gray(" for commands.\n")
    );
    console.log(chalk.gray(`  Session log: ${logger.filePath}\n`));
  }

  printHeader();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY ?? true,
    prompt: chalk.green("▶ "),
  });

  rl.prompt();

  await new Promise<void>((resolve) => {
    rl.on("line", async (line) => {
      const input = line.trim();
      if (!input) { rl.prompt(); return; }

      // ── Slash commands ────────────────────────────────────────────────────
      if (input === "/" || input.startsWith("/")) {
        const parts = input.split(/\s+/);
        const cmd = parts[0];
        const arg = parts.slice(1).join(" ").trim();

        switch (cmd) {
          case "/":
          case "/help":
            showCommands();
            break;

          case "/clear":
            messages = [];
            console.log(chalk.gray("  Conversation cleared.\n"));
            break;

          case "/exit":
          case "/quit":
            rl.close();
            return;

          case "/model": {
            if (arg && arg !== "list") {
              // Direct name switch: /model <name> or /model sonnet
              const resolved = resolveModel(arg);
              const config = loadConfig();
              provider = createProvider(config, provider.providerName as ProviderName, resolved);
              console.log(chalk.green(`  ✓ Switched to ${chalk.cyan(resolved)}\n`));
              console.log(chalk.gray(`  To save permanently: cascade-agent model ${resolved}\n`));
              break;
            }

            // No arg or "list" → fetch and show numbered list for selection
            process.stdout.write(chalk.gray("  Fetching models…  "));
            let models: string[] = [];
            try {
              models = await provider.listModels();
              console.log(chalk.gray(`${models.length} found\n`));
            } catch (err) {
              console.log(chalk.red(`failed\n  ${(err as Error).message}\n`));
              break;
            }

            if (models.length === 0) {
              console.log(chalk.gray("  No models returned from provider.\n"));
              break;
            }

            const currentIdx = models.indexOf(provider.model);
            for (let i = 0; i < models.length; i++) {
              const isCurrent = models[i] === provider.model;
              const num = chalk.gray(`  ${String(i + 1).padStart(2)}.`);
              const id = isCurrent ? chalk.cyan(models[i]) : chalk.white(models[i]);
              const tag = isCurrent ? chalk.green("  ◀ current") : "";
              console.log(`${num} ${id}${tag}`);
            }
            console.log();

            // Pause the line reader and ask for a selection
            rl.pause();
            const defaultNum = currentIdx >= 0 ? currentIdx + 1 : 1;
            const answer = await new Promise<string>((res) =>
              rl.question(
                chalk.green(`  Choose a model [1-${models.length}] or Enter to keep current: `),
                res
              )
            );
            rl.resume();

            const trimmed = answer.trim();
            if (!trimmed) {
              console.log(chalk.gray("  No change.\n"));
            } else {
              const n = parseInt(trimmed, 10);
              const chosen = (n >= 1 && n <= models.length)
                ? models[n - 1]
                : models.find((m) => m === resolveModel(trimmed)) ?? resolveModel(trimmed);
              const config = loadConfig();
              provider = createProvider(config, provider.providerName as ProviderName, chosen);
              console.log(chalk.green(`\n  ✓ Switched to ${chalk.cyan(chosen)}\n`));
              console.log(chalk.gray(`  To save permanently: cascade-agent model ${chosen}\n`));
            }
            break;
          }

          case "/provider": {
            const { ALL_PROVIDERS: PROVIDERS } = await import("./providers/index.js");
            if (!arg) {
              // Show all providers
              console.log();
              for (const p of PROVIDERS) {
                const active = p === provider.providerName;
                const marker = active ? chalk.green(" ◀ active") : "";
                const label = active ? chalk.cyan(p) : chalk.white(p);
                console.log(`  ${label}${marker}`);
              }
              console.log();
              console.log(chalk.gray("  /provider <name>  — switch provider (session only)\n"));
            } else {
              if (!PROVIDERS.includes(arg as ProviderName)) {
                console.log(chalk.red(`  Unknown provider: ${arg}`));
                console.log(chalk.gray(`  Choose from: ${PROVIDERS.join(", ")}\n`));
              } else {
                const config = loadConfig();
                provider = createProvider(config, arg as ProviderName);
                console.log(chalk.green(`  ✓ Switched to ${chalk.cyan(arg)} / ${chalk.cyan(provider.model)} (this session only)\n`));
                console.log(chalk.gray(`  To save permanently: cascade-agent provider ${arg}\n`));
              }
            }
            break;
          }

          case "/logs": {
            const logs = listLogs(10);
            if (logs.length === 0) {
              console.log(chalk.gray(`\n  No session logs yet.\n  Directory: ${LOG_DIR}\n`));
            } else {
              console.log(chalk.bold(`\n  Recent sessions:\n`));
              for (const entry of logs) {
                const date = entry.createdAt.toLocaleString();
                const isCurrent = entry.filePath === logger.filePath;
                const marker = isCurrent ? chalk.green(" ◀ current") : "";
                console.log(`  ${chalk.gray(date)}  ${chalk.cyan(entry.filename)}${marker}`);
              }
              console.log();
              console.log(chalk.gray(`  open ~/.config/cascade-agent/logs/\n`));
            }
            break;
          }

          default:
            console.log(chalk.red(`  Unknown command: ${cmd}`));
            showCommands();
        }

        rl.prompt();
        return;
      }

      // ── Normal message ────────────────────────────────────────────────────
      rl.pause();
      process.stdout.write("\n");

      logger.logUserMessage(input);
      messages = [...messages, { role: "user" as const, content: input }];
      let textStarted = false;
      let lastToolName = "";

      // Show a loading indicator the first time the local model is used in a
      // session — model initialisation can take a few seconds before the first
      // token is emitted and the screen would otherwise appear frozen.
      let localLoadingShown = false;
      if (provider.providerName === "local") {
        const { isLocalModelLoaded } = await import("./providers/local.js");
        if (!isLocalModelLoaded()) {
          process.stdout.write(chalk.gray("  Loading model…\n"));
          localLoadingShown = true;
        }
      }

      try {
        messages = await runAgent(provider, messages, [], {
          onText(delta) {
            textStarted = true;
            process.stdout.write(chalk.white(delta));
            logger.logAssistantText(delta);
          },
          onToolStart(name, toolInput) {
            if (textStarted) { process.stdout.write("\n"); textStarted = false; }
            console.log(formatToolStart(name, toolInput));
            lastToolName = name;
            logger.logToolCall(name, toolInput);
          },
          onToolEnd(name, result) {
            lastToolName = name;
            console.log(formatToolEnd(result));
            logger.logToolResult(name, result);
          },
        });
      } catch (err) {
        const msg = (err as Error).message;
        console.error(chalk.red(`\nError: ${msg}`));
        logger.logError(msg);
      }

      process.stdout.write("\n\n");
      rl.resume();
      rl.prompt();
    });

    rl.on("close", () => {
      logger.close();
      console.log(chalk.gray("\nGoodbye."));
      resolve();
    });
  });
}
