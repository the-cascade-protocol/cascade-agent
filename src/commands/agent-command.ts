/**
 * registerAgentCommand — mounts @the-cascade-protocol/agent as a `cascade agent`
 * sub-command tree inside the cascade-cli program.
 *
 * Exposed subcommands:
 *   cascade agent              Start the interactive REPL
 *   cascade agent serve        Start the document intelligence HTTP server
 *   cascade agent review       Terminal review of AI extraction queue
 *   cascade agent login        Add / update provider credentials
 *   cascade agent provider     Show or switch the active provider
 *   cascade agent model        Show or switch the model
 */

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
} from "../config.js";
import {
  createProvider,
  downloadDefaultModel,
  DEFAULT_MODELS,
  ALL_PROVIDERS,
  type ProviderName,
} from "../providers/index.js";
import { startRepl } from "../repl.js";
import { runAgent, type SimpleMessage } from "../agent.js";
import { needsOnboarding, runOnboarding } from "../onboarding.js";
import { validateKeyDetailed } from "../auth.js";
import { createSessionLogger } from "../logger.js";
import { runServeMode } from "./serve.js";
import { runReviewMode } from "./review.js";
import chalk from "chalk";
import readline from "readline";

// ── helpers ────────────────────────────────────────────────────────────────

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

function requireApiKey(provider: ProviderName): void {
  if (provider === "ollama" || provider === "local") return;
  const key = getApiKey(provider);
  if (!key) {
    const envVar = {
      anthropic: "ANTHROPIC_API_KEY",
      openai: "OPENAI_API_KEY",
      google: "GOOGLE_AI_API_KEY",
      ollama: "",
      local: "",
    }[provider];
    console.error(
      chalk.red(`No API key for ${provider}.`) +
      `\nRun ${chalk.cyan("cascade agent login")} or set ${chalk.cyan(envVar)}.`
    );
    process.exit(1);
  }
}

async function runOneShot(
  provider: ReturnType<typeof createProvider>,
  prompt: string
): Promise<void> {
  const logger = createSessionLogger(provider.providerName, provider.model);
  const messages: SimpleMessage[] = [{ role: "user", content: prompt }];
  logger.logUserMessage(prompt);
  try {
    await runAgent(provider, messages, [], {
      onText(delta) { process.stdout.write(delta); logger.logAssistantText(delta); },
      onToolStart(name, input) { void name; void input; },
      onToolEnd(name, result) { void name; void result; },
    });
    process.stdout.write("\n");
  } finally {
    logger.close();
  }
}

// ── registerAgentCommand ───────────────────────────────────────────────────

export function registerAgentCommand(program: Command): void {
  const agent = program
    .command("agent")
    .description("Natural language interface for Cascade Protocol operations")
    .option("-p, --provider <name>", "Provider to use for this run")
    .option("-m, --model <model>", "Model override for this run")
    .argument("[prompt]", "One-shot prompt (omit for interactive REPL)")
    .action(async (
      prompt: string | undefined,
      opts: { provider?: string; model?: string },
    ) => {
      const config = loadConfig();
      const providerName = (opts.provider as ProviderName) ?? config.activeProvider ?? "anthropic";

      if (!opts.provider && needsOnboarding()) {
        const provider = await runOnboarding();
        if (prompt) {
          await runOneShot(provider, prompt);
        } else {
          await startRepl(provider);
        }
        return;
      }

      requireApiKey(providerName);
      const provider = createProvider(
        config,
        providerName,
        opts.model ? resolveModel(opts.model) : undefined,
      );

      if (prompt) {
        await runOneShot(provider, prompt);
      } else {
        await startRepl(provider);
      }
    });

  // ── cascade agent serve ──────────────────────────────────────────────────

  agent
    .command("serve")
    .description("Start the document intelligence extraction server (POST /extract)")
    .option("--port <number>", "Port to listen on", "8765")
    .option("--web-review", "Serve the web review UI")
    .action(async (opts: { port?: string; webReview?: boolean }) => {
      const port = parseInt(opts.port ?? "8765", 10);
      await runServeMode(port, opts.webReview ?? false);
    });

  // ── cascade agent review ─────────────────────────────────────────────────

  agent
    .command("review")
    .description("Interactive terminal review of AI extraction queue")
    .option("--pod <path>", "Path to the Cascade pod directory")
    .option("--output <path>", "Path to write review results JSON")
    .action(async (opts: { pod?: string; output?: string }) => {
      await runReviewMode(opts);
    });

  // ── cascade agent login ──────────────────────────────────────────────────

  agent
    .command("login")
    .description("Add or update credentials for a provider")
    .option("-p, --provider <name>", "Provider to configure")
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
        console.log(chalk.gray("This will download the Qwen3.5 model (~1.5 GB) to ~/.config/cascade-agent/models/\n"));
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
            rl.close(); process.exit(1);
          }
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

  // ── cascade agent provider ───────────────────────────────────────────────

  agent
    .command("provider [name]")
    .description("Get or set the active provider")
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

  // ── cascade agent model ──────────────────────────────────────────────────

  agent
    .command("model [name]")
    .description("Get or set the model for the active provider")
    .option("-p, --provider <name>", "Provider to configure")
    .action(async (name?: string, opts?: { provider?: string }) => {
      const config = loadConfig();
      const providerName = (opts?.provider as ProviderName) ?? config.activeProvider ?? "anthropic";

      if (!name) {
        const current = getModel(providerName) ?? DEFAULT_MODELS[providerName];
        console.log(`\nProvider: ${chalk.cyan(providerName)}`);
        console.log(`Current model: ${chalk.cyan(current)}\n`);
        console.log(chalk.bold("Model shortcuts:"));
        for (const [alias, id] of Object.entries(MODEL_ALIASES)) {
          console.log(`  ${chalk.white(alias.padEnd(10))} ${chalk.gray(id)}`);
        }
        console.log(chalk.gray("\nOr pass any full model ID.\n"));
        return;
      }

      const resolved = resolveModel(name);
      config.providers ??= {};
      config.providers[providerName] ??= {};
      config.providers[providerName]!.model = resolved;
      saveConfig(config);
      console.log(chalk.green(`✓ ${providerName} model set to ${resolved}`));
    });
}
