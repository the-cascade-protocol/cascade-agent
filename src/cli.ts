#!/usr/bin/env node
import readline from "readline";
import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

function readPackageVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };
    return pkg.version;
  } catch {
    return "unknown";
  }
}

/** Walk up the directory tree from startDir until a .git folder is found. */
function findGitRoot(startDir: string): string | null {
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null; // reached filesystem root
    dir = parent;
  }
}
import chalk from "chalk";
import { Command } from "commander";
import {
  loadConfig,
  saveConfig,
  getApiKey,
  getActiveProvider,
  getModel,
  resolveModel,
  MODEL_ALIASES,
  PROVIDER_LABELS,
} from "./config.js";
import {
  createProvider,
  downloadDefaultModel,
  DEFAULT_MODELS,
  ALL_PROVIDERS,
  type ProviderName,
} from "./providers/index.js";
import { startRepl } from "./repl.js";
import { runAgent } from "./agent.js";
import { needsOnboarding, runOnboarding } from "./onboarding.js";
import { validateKeyDetailed } from "./auth.js";
import { createSessionLogger, listLogs, LOG_DIR } from "./logger.js";
import { runServeMode } from "./commands/serve.js";
import { runReviewMode } from "./commands/review.js";

// ── helpers ────────────────────────────────────────────────────────────────

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

function requireApiKey(provider: ProviderName): void {
  if (provider === "ollama" || provider === "local") return; // no key needed
  const key = getApiKey(provider);
  if (!key) {
    const envVar = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", google: "GOOGLE_AI_API_KEY", ollama: "", local: "" }[provider];
    console.error(
      chalk.red(`No API key for ${provider}.`) +
      `\nRun ${chalk.cyan("cascade-agent login")} or set ${chalk.cyan(envVar)}.`
    );
    process.exit(1);
  }
}

// ── program ────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("cascade-agent")
  .description("Natural language interface for the Cascade Protocol CLI")
  .version(readPackageVersion());

// ── cascade-agent login ────────────────────────────────────────────────────

program
  .command("login")
  .description("Add or update credentials for a provider")
  .option("-p, --provider <name>", "Provider to configure (anthropic|openai|google|ollama|local)")
  .action(async (opts: { provider?: string }) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    let providerName = opts.provider as ProviderName | undefined;

    if (!providerName) {
      console.log(chalk.bold.cyan("\nCascade Agent — Login\n"));
      console.log("Choose a provider:\n");
      ALL_PROVIDERS.forEach((p, i) =>
        console.log(`  ${chalk.white(i + 1 + ".")} ${PROVIDER_LABELS[p]}`)
      );
      console.log();
      const choice = await ask(rl, `Provider [1-${ALL_PROVIDERS.length}]: `);
      const idx = parseInt(choice.trim(), 10) - 1;
      providerName = ALL_PROVIDERS[idx];
      if (!providerName) {
        console.error(chalk.red("Invalid choice.")); rl.close(); process.exit(1);
      }
    }

    console.log(chalk.gray(`\nConfiguring ${PROVIDER_LABELS[providerName]}`));

    const config = loadConfig();
    config.providers ??= {};
    config.providers[providerName] ??= {};

    if (providerName === "ollama") {
      const defaultUrl = config.providers.ollama?.baseUrl ?? "http://localhost:11434";
      const url = await ask(rl, `Ollama base URL [${defaultUrl}]: `);
      config.providers.ollama!.baseUrl = url.trim() || defaultUrl;
    } else if (providerName === "local") {
      console.log(chalk.bold("\nLocal Provider Setup — Qwen3.5-2B\n"));
      console.log(chalk.gray("This will download the Qwen3.5-2B-Instruct-Q4_K_M model (~1.5 GB)"));
      console.log(chalk.gray("to ~/.config/cascade-agent/models/\n"));
      const confirm = await ask(rl, "Download model now? [Y/n]: ");
      if (!confirm.trim() || confirm.trim().toLowerCase() === "y") {
        let lastPercent = -1;
        process.stdout.write(chalk.gray("Downloading "));
        try {
          const modelPath = await downloadDefaultModel((progress) => {
            const pct = Math.floor(progress.percent);
            if (pct !== lastPercent && pct % 5 === 0) {
              process.stdout.write(chalk.gray(`${pct}%… `));
              lastPercent = pct;
            }
          });
          console.log(chalk.green("\n✓ Model downloaded"));
          config.providers.local!.baseUrl = modelPath;
        } catch (err) {
          console.error(chalk.red(`\n✗ Download failed: ${(err as Error).message}`));
          console.log(chalk.gray("\nYou can also download manually:"));
          console.log(chalk.gray("  npx node-llama-cpp pull --repo Qwen/Qwen3.5-2B-Instruct-GGUF --file Qwen3.5-2B-Instruct-Q4_K_M.gguf"));
          rl.close(); process.exit(1);
        }
      } else {
        console.log(chalk.gray("\nSkipping download. Set the model path manually in ~/.config/cascade-agent/config.json"));
      }
    } else {
      const keyUrls: Record<string, string> = {
        anthropic: "https://console.anthropic.com/settings/keys",
        openai: "https://platform.openai.com/api-keys",
        google: "https://aistudio.google.com/app/apikey  (free tier available)",
      };
      console.log(`\nGet your API key at: ${chalk.underline(keyUrls[providerName])}\n`);

      const key = await ask(rl, "API key: ");
      const trimmed = key.trim();
      if (!trimmed) { console.error(chalk.red("No key entered.")); rl.close(); process.exit(1); }

      process.stdout.write(chalk.gray("Validating…  "));
      const validation = await validateKeyDetailed(providerName, trimmed);
      if (!validation.ok) {
        console.log(chalk.red("✗ Key validation failed."));
        if (validation.error) console.log(chalk.gray(`  Reason: ${validation.error}`));
        rl.close(); process.exit(1);
      }
      console.log(chalk.green("✓ Valid"));
      config.providers[providerName]!.apiKey = trimmed;
    }

    // Ask to set as active if not already
    if (config.activeProvider !== providerName) {
      const setActive = await ask(rl, `Set ${providerName} as active provider? [Y/n]: `);
      if (!setActive.trim() || setActive.trim().toLowerCase() === "y") {
        config.activeProvider = providerName;
      }
    }

    saveConfig(config);
    console.log(chalk.green(`\n✓ Saved to ~/.config/cascade-agent/config.json`));
    rl.close();
  });

// ── cascade-agent provider [name] ──────────────────────────────────────────

program
  .command("provider [name]")
  .description("Get or set the active provider (anthropic|openai|google|ollama)")
  .action((name?: string) => {
    if (!name) {
      const active = getActiveProvider();
      console.log(chalk.bold("\nConfigured providers:\n"));
      const config = loadConfig();
      for (const p of ALL_PROVIDERS) {
        const pc = config.providers?.[p];
        const hasKey = p === "ollama" || p === "local" || !!pc?.apiKey || !!getApiKey(p);
        const marker = p === active ? chalk.green(" ◀ active") : "";
        const status = hasKey ? chalk.green("✓") : chalk.gray("–");
        console.log(`  ${status} ${chalk.white(p.padEnd(12))} ${chalk.gray(PROVIDER_LABELS[p])}${marker}`);
      }
      console.log();
      return;
    }
    if (!ALL_PROVIDERS.includes(name as ProviderName)) {
      console.error(chalk.red(`Unknown provider: ${name}. Choose from: ${ALL_PROVIDERS.join(", ")}`));
      process.exit(1);
    }
    const config = loadConfig();
    saveConfig({ ...config, activeProvider: name as ProviderName });
    console.log(chalk.green(`✓ Active provider set to ${name}`));
  });

// ── cascade-agent model [name] ─────────────────────────────────────────────

program
  .command("model [name]")
  .description("Get or set the model for the active provider")
  .option("-p, --provider <name>", "Provider to configure")
  .option("-l, --list", "Fetch available models live from the provider API")
  .action(async (name?: string, opts?: { provider?: string; list?: boolean }) => {
    const config = loadConfig();
    const providerName = (opts?.provider as ProviderName) ?? config.activeProvider ?? "anthropic";

    if (opts?.list) {
      requireApiKey(providerName);
      const provider = createProvider(config, providerName);
      process.stdout.write(chalk.gray(`Fetching models from ${providerName}…\n`));
      try {
        const models = await provider.listModels();
        const current = getModel(providerName) ?? DEFAULT_MODELS[providerName];
        console.log(`\nProvider: ${chalk.cyan(providerName)}`);
        console.log(`Current model: ${chalk.cyan(current)}\n`);
        console.log(chalk.bold("Available models:"));
        for (const id of models) {
          const marker = id === current ? chalk.green(" ◀ active") : "";
          console.log(`  ${chalk.white(id)}${marker}`);
        }
        console.log();
        console.log(chalk.gray("Set with: cascade-agent model <model-id>"));
      } catch (err) {
        console.error(chalk.red(`Failed to fetch models: ${(err as Error).message}`));
        process.exit(1);
      }
      return;
    }

    if (!name) {
      const current = getModel(providerName) ?? DEFAULT_MODELS[providerName];
      console.log(`\nProvider: ${chalk.cyan(providerName)}`);
      console.log(`Current model: ${chalk.cyan(current)}\n`);
      console.log(chalk.bold("Model shortcuts:"));
      for (const [alias, id] of Object.entries(MODEL_ALIASES)) {
        console.log(`  ${chalk.white(alias.padEnd(10))} ${chalk.gray(id)}`);
      }
      console.log(chalk.gray("\nOr pass any full model ID."));
      console.log(chalk.gray("Use --list to fetch live models from the provider API."));
      return;
    }

    const resolved = resolveModel(name);
    config.providers ??= {};
    config.providers[providerName] ??= {};
    config.providers[providerName]!.model = resolved;
    saveConfig(config);
    console.log(chalk.green(`✓ ${providerName} model set to ${resolved}`));
  });

// ── cascade-agent [prompt] (default) ──────────────────────────────────────

program
  .argument("[prompt]", "One-shot prompt (omit for interactive REPL)")
  .option("-p, --provider <name>", "Provider to use for this run")
  .option("-m, --model <model>",   "Model override for this run")
  .option("-s, --script <file>",   "Run questions from a file (one per line), then exit")
  .action(async (prompt: string | undefined, opts: { provider?: string; model?: string; script?: string }) => {
    const config = loadConfig();
    const providerName = (opts.provider as ProviderName) ?? config.activeProvider ?? "anthropic";

    // First-run: no provider configured and no env var set → onboarding
    if (!opts.provider && needsOnboarding()) {
      const provider = await runOnboarding();
      if (!prompt) {
        await startRepl(provider);
      } else {
        await runOneShot(provider, prompt);
      }
      return;
    }

    requireApiKey(providerName);

    const provider = createProvider(
      config,
      providerName,
      opts.model ? resolveModel(opts.model) : undefined
    );

    if (opts.script) {
      await runScript(provider, opts.script);
    } else if (prompt) {
      await runOneShot(provider, prompt);
    } else {
      await startRepl(provider);
    }
  });

// ── cascade-agent logs ─────────────────────────────────────────────────────

program
  .command("logs")
  .description("List recent session logs")
  .option("-n, --number <n>", "Number of logs to show", "20")
  .action((opts: { number?: string }) => {
    const limit = parseInt(opts.number ?? "20", 10);
    const logs = listLogs(limit);
    if (logs.length === 0) {
      console.log(chalk.gray("\nNo session logs yet. Logs are written automatically when you run the agent.\n"));
      console.log(chalk.gray(`Log directory: ${LOG_DIR}\n`));
      return;
    }
    console.log(chalk.bold(`\nRecent sessions (${LOG_DIR}):\n`));
    for (const entry of logs) {
      const date = entry.createdAt.toLocaleString();
      console.log(`  ${chalk.gray(date)}  ${chalk.cyan(entry.filename)}`);
    }
    console.log();
    console.log(chalk.gray("Open a log:  cat ~/.config/cascade-agent/logs/<filename>"));
    console.log(chalk.gray("Or in your editor:  open ~/.config/cascade-agent/logs/\n"));
  });

// ── cascade-agent upgrade ──────────────────────────────────────────────────

program
  .command("upgrade")
  .description("Upgrade to the latest version")
  .action(() => {
    const repoRoot = findGitRoot(dirname(fileURLToPath(import.meta.url)));

    console.log(chalk.bold.cyan("\nCascade Agent — Upgrade\n"));

    // ── npm install path (no git repo) ────────────────────────────────────
    if (!repoRoot) {
      console.log(chalk.gray("  Installed via npm — updating from registry…\n"));
      try {
        process.stdout.write(chalk.gray("  Installing latest version…  "));
        execSync("npm install -g @the-cascade-protocol/agent@latest", { stdio: "pipe" });
        console.log(chalk.green("✓"));
        console.log(chalk.green("\n  ✓ Upgrade complete!\n"));
      } catch (err) {
        console.log(chalk.red("✗"));
        const msg = (err as Error).message;
        const detail = msg.split("\n").find(l => l.trim()) ?? msg;
        console.error(chalk.red(`\n  Error: ${detail}`));
        console.log(chalk.gray("\n  Manual upgrade:\n    npm install -g @the-cascade-protocol/agent@latest\n"));
        process.exit(1);
      }
      return;
    }

    // ── git / dev install path ────────────────────────────────────────────
    console.log(chalk.gray(`  Repo: ${repoRoot}\n`));

    try {
      const before = execSync("git rev-parse --short HEAD", { cwd: repoRoot }).toString().trim();
      console.log(chalk.gray(`  Current commit: ${before}`));

      process.stdout.write(chalk.gray("  Pulling latest changes…  "));
      execSync("git pull --ff-only", { cwd: repoRoot });
      console.log(chalk.green("✓"));

      const after = execSync("git rev-parse --short HEAD", { cwd: repoRoot }).toString().trim();

      if (before === after) {
        console.log(chalk.gray("\n  Already up to date.\n"));
      } else {
        console.log(chalk.gray(`  Updated: ${before} → ${after}`));

        process.stdout.write(chalk.gray("  Building…  "));
        execSync("npm run build", { cwd: repoRoot, stdio: "pipe" });
        console.log(chalk.green("✓"));

        console.log(chalk.green("\n  ✓ Upgrade complete!\n"));
      }
    } catch (err) {
      console.log(chalk.red("✗"));
      const msg = (err as Error).message;
      const detail = msg.split("\n").find(l => l.trim()) ?? msg;
      console.error(chalk.red(`\n  Error: ${detail}`));
      console.log(chalk.gray(`\n  Manual upgrade:\n    cd ${repoRoot}\n    git pull && npm run build\n`));
      process.exit(1);
    }
  });

// ── cascade-agent serve ────────────────────────────────────────────────────

program
  .command("serve")
  .description("Start HTTP server for document intelligence extraction (POST /extract)")
  .option("--port <number>", "Port to listen on (default: 8765)", "8765")
  .option("--web-review", "Serve the web review UI and print its URL to stdout")
  .action(async (opts: { port?: string; webReview?: boolean }) => {
    const port = parseInt(opts.port ?? "8765", 10);
    await runServeMode(port, opts.webReview ?? false);
  });

// ── cascade-agent review ───────────────────────────────────────────────────

program
  .command("review")
  .description("Interactive terminal review of AI extraction queue (confidence 0.50–0.84)")
  .option("--pod <path>", "Path to the Cascade pod directory (default: ./pod)")
  .option("--output <path>", "Path to write review results JSON (default: <pod>/analysis/review-results.json)")
  .action(async (opts: { pod?: string; output?: string }) => {
    await runReviewMode(opts);
  });

program.parse();

// ── script runner ──────────────────────────────────────────────────────────

async function runScript(
  provider: ReturnType<typeof createProvider>,
  scriptPath: string,
): Promise<void> {
  const { runAgent } = await import("./agent.js");
  type SimpleMessage = import("./agent.js").SimpleMessage;
  const { initSystemPrompt } = await import("./system-prompt.js");
  const { createSessionLogger } = await import("./logger.js");

  let questions: string[];
  try {
    questions = readFileSync(scriptPath, "utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
  } catch {
    console.error(chalk.red(`Cannot read script file: ${scriptPath}`));
    process.exit(1);
  }

  if (questions.length === 0) {
    console.error(chalk.red("Script file is empty."));
    process.exit(1);
  }

  // Bootstrap CLI capabilities
  try {
    const caps = execSync("cascade capabilities", { encoding: "utf-8", timeout: 5000, stdio: ["pipe","pipe","pipe"] }).trim();
    initSystemPrompt(caps);
  } catch { /* silent */ }

  const logger = createSessionLogger(provider.providerName, provider.model);
  let messages: SimpleMessage[] = [];

  console.log(`\n${chalk.bold.cyan("Cascade Agent")} ${chalk.gray(`(${provider.providerName} / ${provider.model})`)}`);
  console.log(chalk.gray(`  Session log: ${logger.filePath}\n`));

  for (const question of questions) {
    console.log(chalk.green("▶ ") + question + "\n");
    logger.logUserMessage(question);
    messages = [...messages, { role: "user" as const, content: question }];
    let textStarted = false;

    try {
      messages = await runAgent(provider, messages, [], {
        onText(delta) {
          textStarted = true;
          process.stdout.write(chalk.white(delta));
          logger.logAssistantText(delta);
        },
        onToolStart(name, input) {
          if (textStarted) { process.stdout.write("\n"); textStarted = false; }
          const detail = name === "shell" && input.command
            ? chalk.gray(` $ ${String(input.command).slice(0, 100)}`)
            : "";
          console.log(chalk.yellow(`  ⚙ ${name}`) + detail);
          logger.logToolCall(name, input);
        },
        onToolEnd(_name, result) {
          const lines = result.split("\n");
          const preview = lines.slice(0, 3).join("\n");
          const suffix = lines.length > 3 ? chalk.gray(`\n  … (${lines.length} lines)`) : "";
          console.log(chalk.gray("  ↳ ") + chalk.dim(preview) + suffix);
          logger.logToolResult(_name, result);
        },
      });
    } catch (err) {
      const msg = (err as Error).message;
      console.error(chalk.red(`\nError: ${msg}`));
      logger.logError(msg);
    }

    process.stdout.write("\n\n");
  }

  logger.close();
}

// ── shared one-shot runner ─────────────────────────────────────────────────

async function runOneShot(
  provider: ReturnType<typeof createProvider>,
  prompt: string
): Promise<void> {
  const logger = createSessionLogger(provider.providerName, provider.model);
  logger.logUserMessage(prompt);
  let lastToolName = "";

  try {
    await runAgent(provider, [{ role: "user", content: prompt }], [], {
      onText: (d) => {
        process.stdout.write(d);
        logger.logAssistantText(d);
      },
      onToolStart: (name, input) => {
        const detail = name === "shell" ? (input.command ?? "") : (input.path ?? "");
        process.stderr.write(
          chalk.yellow(`\n⚙ ${name} `) + chalk.gray(detail.slice(0, 120) + "\n")
        );
        lastToolName = name;
        logger.logToolCall(name, input);
      },
      onToolEnd: (name, result) => {
        lastToolName = name;
        process.stderr.write(
          chalk.gray("  ↳ " + result.split("\n").slice(0, 2).join(" ").slice(0, 120) + "\n")
        );
        logger.logToolResult(name, result);
      },
    });
    process.stdout.write("\n");
    logger.close();
    process.stderr.write(chalk.gray(`\nLog saved: ${logger.filePath}\n`));
  } catch (err) {
    const msg = (err as Error).message;
    logger.logError(msg);
    logger.close();
    console.error(chalk.red(`Error: ${msg}`));
    process.exit(1);
  }
}
