import readline from "readline";
import chalk from "chalk";
import { loadConfig, saveConfig, getApiKey } from "./config.js";
import {
  createProvider,
  downloadDefaultModel,
  DEFAULT_MODELS,
  ALL_PROVIDERS,
  type ProviderName,
  type Provider,
} from "./providers/index.js";
import { validateKeyDetailed } from "./auth.js";

// ── detection ──────────────────────────────────────────────────────────────

/** True when no provider has been configured and no env var is set. */
export function needsOnboarding(): boolean {
  if (
    process.env.ANTHROPIC_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_AI_API_KEY
  ) {
    return false;
  }
  const config = loadConfig();
  const anyKey = ALL_PROVIDERS.some((p) => {
    if (p === "ollama" || p === "local") return false;
    return !!config.providers?.[p]?.apiKey;
  });
  // Also not needed if local model is configured
  const localConfigured = !!config.providers?.local?.baseUrl;
  return !anyKey && !localConfigured;
}

// ── visual helpers ─────────────────────────────────────────────────────────

function hr(): void {
  console.log(chalk.gray("  " + "─".repeat(58)));
}

function blank(): void {
  console.log();
}

function step(n: number, label: string): void {
  blank();
  console.log(
    chalk.cyan(`  Step ${n}: `) + chalk.bold.white(label)
  );
  hr();
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

// ── onboarding flow ────────────────────────────────────────────────────────

export async function runOnboarding(): Promise<Provider> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // ── Welcome banner ───────────────────────────────────────────────────────

  blank();
  console.log(chalk.cyan("  ╭" + "─".repeat(58) + "╮"));
  console.log(chalk.cyan("  │") + " ".repeat(60) + chalk.cyan("│"));
  console.log(
    chalk.cyan("  │") +
      "  " +
      chalk.bold.white("Cascade Agent") +
      " ".repeat(45) +
      chalk.cyan("│")
  );
  console.log(
    chalk.cyan("  │") +
      "  " +
      chalk.gray("Natural language for the Cascade Protocol CLI") +
      " ".repeat(13) +
      chalk.cyan("│")
  );
  console.log(
    chalk.cyan("  │") +
      "  " +
      chalk.gray("cascadeprotocol.org") +
      " ".repeat(39) +
      chalk.cyan("│")
  );
  console.log(chalk.cyan("  │") + " ".repeat(60) + chalk.cyan("│"));
  console.log(chalk.cyan("  ╰" + "─".repeat(58) + "╯"));
  blank();
  console.log(chalk.white("  Ask your health data questions in plain English."));
  console.log(
    chalk.gray("  Wraps the ") +
      chalk.cyan("cascade") +
      chalk.gray(" CLI — convert, validate, and query")
  );
  console.log(chalk.gray("  FHIR records, data pods, and Cascade RDF/Turtle files."));

  // ── Step 1: Provider ─────────────────────────────────────────────────────

  step(1, "Choose an AI provider");
  blank();
  console.log(chalk.gray("  Cascade Agent needs an AI model to understand your questions."));
  console.log(chalk.gray("  You can use any of the providers below — two are free:\n"));

  const providers: Array<{
    name: ProviderName;
    label: string;
    note?: string;
    free?: boolean;
    url: string;
  }> = [
    {
      name: "anthropic",
      label: "Anthropic Claude",
      url: "console.anthropic.com/settings/keys",
    },
    {
      name: "openai",
      label: "OpenAI GPT",
      url: "platform.openai.com/api-keys",
    },
    {
      name: "google",
      label: "Google Gemini",
      free: true,
      note: "free tier available",
      url: "aistudio.google.com/app/apikey",
    },
    {
      name: "ollama",
      label: "Ollama",
      free: true,
      note: "local — no API key needed",
      url: "ollama.com",
    },
    {
      name: "local",
      label: "Local (Qwen3.5-2B)",
      free: true,
      note: "on-device, no API key, ~1.5 GB download",
      url: "cascadeprotocol.org",
    },
  ];

  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    const num = chalk.bold.white(`  ${i + 1}.`);
    const label = chalk.white(p.label.padEnd(22));
    const badge = p.free ? chalk.green(" ★ " + p.note) : "";
    console.log(`${num} ${label}${badge}`);
    console.log(chalk.gray(`       ${p.url}`));
    blank();
  }

  let providerIndex = -1;
  while (providerIndex < 0 || providerIndex >= providers.length) {
    const raw = await ask(rl, chalk.green(`  Choose a provider [1-${providers.length}]: `));
    const n = parseInt(raw.trim(), 10);
    if (n >= 1 && n <= providers.length) {
      providerIndex = n - 1;
    } else {
      console.log(chalk.red(`  Please enter a number between 1 and ${providers.length}.`));
    }
  }

  const chosen = providers[providerIndex];
  const config = loadConfig();
  config.providers ??= {};
  config.providers[chosen.name] ??= {};

  // ── Step 2: API key (or Ollama URL) ──────────────────────────────────────

  const stepLabel =
    chosen.name === "ollama" ? "Configure Ollama" :
    chosen.name === "local"  ? "Download local model" :
    "Enter your API key";
  step(2, stepLabel);

  if (chosen.name === "ollama") {
    const defaultUrl = config.providers.ollama?.baseUrl ?? "http://localhost:11434";
    blank();
    console.log(chalk.white("  Ollama runs on your machine — no API key needed."));
    console.log(
      chalk.gray("  Make sure Ollama is running: ") + chalk.cyan("ollama serve")
    );
    blank();
    const raw = await ask(rl, chalk.green(`  Base URL [${defaultUrl}]: `));
    config.providers.ollama!.baseUrl = raw.trim() || defaultUrl;
  } else if (chosen.name === "local") {
    blank();
    console.log(chalk.white("  Qwen3.5-2B runs entirely on your device — no API key or internet needed after setup."));
    console.log(chalk.gray("  The model file is ~1.5 GB and will be saved to ~/.config/cascade-agent/models/"));
    blank();
    const confirm = await ask(rl, chalk.green("  Download model now? [Y/n]: "));
    if (!confirm.trim() || confirm.trim().toLowerCase() === "y") {
      let lastPercent = -1;
      process.stdout.write(chalk.gray("\n  Downloading "));
      try {
        const modelPath = await downloadDefaultModel((progress) => {
          const pct = Math.floor(progress.percent);
          if (pct !== lastPercent && pct % 5 === 0) {
            process.stdout.write(chalk.gray(`${pct}%… `));
            lastPercent = pct;
          }
        });
        console.log(chalk.green("\n  ✓ Model downloaded"));
        config.providers.local!.baseUrl = modelPath;
      } catch (err) {
        console.error(chalk.red(`\n  ✗ Download failed: ${(err as Error).message}`));
        rl.close(); process.exit(1);
      }
    }
  } else {
    blank();
    console.log(
      chalk.gray("  Get your API key here: ") +
        chalk.underline.cyan(`https://${chosen.url}`)
    );
    if (chosen.name === "google") {
      console.log(chalk.gray("  Google AI Studio has a free tier — no credit card required."));
    }
    blank();

    let key = "";
    while (!key) {
      const raw = await ask(rl, chalk.green("  Paste your API key: "));
      key = raw.trim();
      if (!key) console.log(chalk.red("  No key entered — please try again."));
    }

    process.stdout.write(chalk.gray("\n  Validating key…  "));
    const validation = await validateKeyDetailed(chosen.name, key);

    if (!validation.ok) {
      console.log(chalk.red("✗\n"));
      console.log(chalk.red("  Key validation failed."));
      if (validation.error) {
        console.log(chalk.gray(`  Reason: ${validation.error}`));
      }
      console.log(
        chalk.gray("\n  Try again with ") +
          chalk.cyan("cascade-agent login") +
          chalk.gray(".")
      );
      rl.close();
      process.exit(1);
    }

    console.log(chalk.green("✓ Key accepted"));
    config.providers[chosen.name]!.apiKey = key;
  }

  // ── Step 3: Pick a model ──────────────────────────────────────────────────

  const defaultModel = DEFAULT_MODELS[chosen.name];
  let chosenModel = defaultModel;

  // Local provider: model was already chosen/downloaded — no selection needed.
  if (chosen.name === "local") {
    chosenModel = defaultModel;
  } else {
    step(3, "Choose a model");
    blank();

    // Temporarily save key so createProvider can use it
    config.activeProvider = chosen.name;
    const tempProvider = createProvider(config, chosen.name);

    process.stdout.write(chalk.gray("  Fetching available models…  "));
    let models: string[] = [];
    try {
      models = await tempProvider.listModels();
      console.log(chalk.gray(`${models.length} found\n`));
    } catch {
      console.log(chalk.gray("(offline — will use default)\n"));
    }

    if (models.length > 0) {
      // Show numbered list with default highlighted
      const defaultIdx = models.indexOf(defaultModel);
      for (let i = 0; i < models.length; i++) {
        const isDefault = models[i] === defaultModel;
        const num = chalk.gray(`  ${String(i + 1).padStart(2)}.`);
        const id = isDefault ? chalk.cyan(models[i]) : chalk.white(models[i]);
        const tag = isDefault ? chalk.gray("  (recommended)") : "";
        console.log(`${num} ${id}${tag}`);
      }
      blank();

      while (true) {
        const raw = await ask(
          rl,
          chalk.green(`  Choose a model [1-${models.length}] or press Enter for recommended: `)
        );
        const trimmed = raw.trim();
        if (!trimmed) {
          chosenModel = defaultModel;
          break;
        }
        const n = parseInt(trimmed, 10);
        if (n >= 1 && n <= models.length) {
          chosenModel = models[n - 1];
          break;
        }
        if (models.includes(trimmed)) {
          chosenModel = trimmed;
          break;
        }
        console.log(chalk.red(`  Enter a number between 1 and ${models.length}, or press Enter.`));
      }
    } else {
      console.log(chalk.gray("  Could not fetch model list. Type a model ID or press Enter for the default."));
      blank();
      const raw = await ask(rl, chalk.green(`  Model [${defaultModel}]: `));
      chosenModel = raw.trim() || defaultModel;
    }
  }

  config.providers[chosen.name]!.model = chosenModel;

  // ── Save and confirm ──────────────────────────────────────────────────────

  config.activeProvider = chosen.name;
  saveConfig(config);

  blank();
  hr();
  blank();
  console.log(chalk.green("  You're all set!"));
  blank();
  console.log(
    chalk.gray("  Provider : ") + chalk.white(chosen.name)
  );
  console.log(
    chalk.gray("  Model    : ") + chalk.white(chosenModel)
  );
  console.log(
    chalk.gray("  Config   : ") + chalk.gray("~/.config/cascade-agent/config.json")
  );
  blank();
  console.log(
    chalk.gray("  You can change your model any time:  ") +
      chalk.cyan("cascade-agent model --list")
  );
  console.log(
    chalk.gray("  Add more providers:                  ") +
      chalk.cyan("cascade-agent login")
  );
  blank();
  hr();
  blank();

  rl.close();

  return createProvider(config, chosen.name, chosenModel);
}
