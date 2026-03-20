# Cascade Agent

A natural language command-line interface for the [Cascade Protocol](https://cascadeprotocol.org) — ask in plain English, get health data work done.

```
▶ Convert all FHIR files in ~/records to Cascade RDF and save them to ~/output

  ⚙ shell $ mkdir -p ~/output && for f in ~/records/*.json; do cascade convert ...
  ↳ (command succeeded — 1201 files converted)

Done. 1,201 patient records converted and saved to ~/output as .ttl files.
```

---

## What it does

Cascade Agent sits between you and the [Cascade Protocol CLI](https://cascadeprotocol.org/docs/) (`cascade`). Instead of remembering exact commands and flags, you describe what you want in plain English and the agent figures out the right sequence of CLI calls to make it happen.

It understands tasks like:

- *"Convert all the FHIR bundles in this folder to Cascade RDF/Turtle"*
- *"Validate these .ttl files and tell me which ones have errors"*
- *"Initialize a new data pod at ~/my-health-data"*
- *"How many condition records are in this patient file?"*
- *"Show me the medications from this FHIR record"*

The agent streams responses in real time, shows you every command it runs, and maintains context across a conversation so you can follow up naturally.

---

## The Cascade Protocol

[Cascade Protocol](https://cascadeprotocol.org) is an open standard for secure, interoperable personal health data. It provides:

- **Semantic vocabularies** for clinical records, wellness data, medications, lab results, insurance, and more — built on [FHIR](https://hl7.org/fhir/), [SNOMED CT](https://www.snomed.org), [LOINC](https://loinc.org), and [W3C RDF](https://www.w3.org/RDF/)
- **Local-first storage** — all data stays on your device, encrypted at rest with AES-256-GCM
- **W3C PROV-O provenance** on every record so you always know where data came from
- **A CLI and SDKs** for Swift (iOS/macOS), TypeScript, and Python

Cascade Agent specifically wraps the [Cascade CLI](https://cascadeprotocol.org/docs/) — the command-line tool for converting, validating, and managing health data pods.

**Relevant docs:**
- [Cascade Protocol Overview](https://cascadeprotocol.org/docs/)
- [Clinical Vocabulary (v1.7)](https://cascadeprotocol.org/docs/) — EHR records, medications, labs, conditions
- [Health Vocabulary (v2.3)](https://cascadeprotocol.org/docs/) — device data, wellness observations
- [Security & Compliance](https://cascadeprotocol.org/docs/) — HIPAA alignment, local-first architecture
- [CLI Reference](https://cascadeprotocol.org/docs/) — full command documentation

---

## Requirements

- **Node.js** 18 or later
- **Cascade Protocol CLI** installed globally:
  ```bash
  npm install -g @the-cascade-protocol/cli
  ```
- An API key from at least one supported AI provider (see [Providers](#providers))

---

## Installation

```bash
# From the repository
npm install
npm run build
npm install -g .

# Or link for development
npm link
```

---

## Quick start

### 1. Add your API key

```bash
cascade-agent login
```

The interactive prompt walks you through choosing a provider and entering your key. Keys are saved to `~/.config/cascade-agent/config.json`.

You can also skip the prompt with an environment variable:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...
export GOOGLE_AI_API_KEY=AI...
```

### 2. Start the REPL

```bash
cascade-agent
```

### 3. Or run a one-shot command

```bash
cascade-agent "Convert all FHIR files in ~/Downloads/records to Cascade RDF"
```

---

## Usage

### Interactive REPL

```bash
cascade-agent                   # uses active provider and model
cascade-agent -p google         # use Google Gemini for this session
cascade-agent -p ollama         # use a local Ollama model
```

Inside the REPL:

| Command | Action |
|---------|--------|
| *any text* | Send a request to the agent |
| `clear` | Reset the conversation history |
| `help` | Show usage examples |
| `exit` | Quit |

### One-shot mode

```bash
cascade-agent "validate ~/health-data/patient.ttl"
cascade-agent -p openai -m gpt-4o "how many lab results in this record?"
```

---

## Providers

Cascade Agent supports four AI providers. Use whichever you have access to — including free options.

| Provider | Command | Free tier? | Default model |
|----------|---------|------------|---------------|
| **Anthropic** (Claude) | `-p anthropic` | No — [console.anthropic.com](https://console.anthropic.com/settings/keys) | `claude-opus-4-6` |
| **OpenAI** (GPT) | `-p openai` | No — [platform.openai.com](https://platform.openai.com/api-keys) | `gpt-4o` |
| **Google** (Gemini) | `-p google` | **Yes** — [aistudio.google.com](https://aistudio.google.com/app/apikey) | `gemini-2.0-flash` |
| **Ollama** (local) | `-p ollama` | **Yes** — runs on your machine | `llama3.2` |

> **Note:** AI provider subscriptions (Claude.ai, ChatGPT Plus, Gemini Advanced) are separate from API access and cannot be used directly with this tool. You need an API key from the developer console of each provider. Google AI Studio offers a free API key with generous rate limits.

### Configure a provider

```bash
cascade-agent login                    # interactive setup
cascade-agent login --provider google  # configure a specific provider
```

### Switch the active provider

```bash
cascade-agent provider                 # list all providers (shows which are configured)
cascade-agent provider openai          # set OpenAI as active
```

### Choose a model

```bash
cascade-agent model                    # show current model and shortcuts
cascade-agent model flash              # gemini-2.0-flash
cascade-agent model opus               # claude-opus-4-6
cascade-agent model --provider openai o3
```

**Model shortcuts:**

| Shortcut | Resolves to |
|----------|-------------|
| `opus` | `claude-opus-4-6` |
| `sonnet` | `claude-sonnet-4-6` |
| `haiku` | `claude-haiku-4-5` |
| `gpt4o` | `gpt-4o` |
| `o3` | `o3` |
| `flash` | `gemini-2.0-flash` |
| `pro` | `gemini-1.5-pro` |

Any full model ID is also accepted (e.g. `cascade-agent model gemini-1.5-flash-8b`).

---

## What the agent can do

The agent has access to two tools it can invoke on your behalf:

### `shell`
Runs bash commands — primarily the `cascade` CLI, but also general file operations like `ls`, `find`, `mkdir`, `wc`. For batch jobs it will write a shell loop rather than making individual calls per file, so converting thousands of records is a single tool call.

Cascade CLI operations the agent knows about:

```bash
cascade convert --from fhir --to cascade <file.json>   # FHIR → RDF/Turtle
cascade validate <file.ttl>                            # SHACL validation
cascade pod init <path>                                # create a data pod
cascade pod list                                       # list pods
cascade capabilities                                   # show all commands
```

### `read_file`
Reads the contents of a file (up to 20 KB) so the agent can inspect records, check validation output, or answer questions about specific data.

---

## Configuration file

Settings are stored at `~/.config/cascade-agent/config.json`:

```json
{
  "activeProvider": "google",
  "providers": {
    "anthropic": { "apiKey": "sk-ant-...", "model": "claude-sonnet-4-6" },
    "openai":    { "apiKey": "sk-...",     "model": "gpt-4o" },
    "google":    { "apiKey": "AI...",      "model": "gemini-2.0-flash" },
    "ollama":    { "baseUrl": "http://localhost:11434", "model": "llama3.2" }
  }
}
```

Environment variables take precedence over stored keys:

| Variable | Provider |
|----------|----------|
| `ANTHROPIC_API_KEY` | Anthropic |
| `OPENAI_API_KEY` | OpenAI |
| `GOOGLE_AI_API_KEY` | Google |

---

## Project structure

```
src/
├── cli.ts                  Entry point — commands: login, provider, model, REPL/one-shot
├── config.ts               Config file read/write, model aliases
├── agent.ts                Thin orchestration layer
├── repl.ts                 Interactive readline REPL
├── tools.ts                Tool definitions (shell, read_file) + execution
├── system-prompt.ts        Shared system prompt for all providers
└── providers/
    ├── types.ts            Provider interface and shared types
    ├── anthropic.ts        Anthropic Claude implementation
    ├── openai-compat.ts    OpenAI / Google / Ollama implementation
    └── index.ts            Factory function + default models
```

---

## Links

- [Cascade Protocol](https://cascadeprotocol.org) — protocol home
- [Documentation](https://cascadeprotocol.org/docs/) — vocabularies, CLI reference, security
- [Cascade Protocol Schemas](https://cascadeprotocol.org/docs/cascade-protocol-schemas.md) — full ontology reference
- [Security & Compliance](https://cascadeprotocol.org/docs/) — HIPAA, GDPR, local-first architecture
