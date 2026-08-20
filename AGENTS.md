# AGENTS.md

Natural language interface to the Cascade Protocol CLI, published as `@the-cascade-protocol/agent`. Wraps `cascade serve --mcp`.

## Start here

- `CLAUDE.md` -- architecture, the system-prompt update discipline, and the current known vocabulary gaps.
- `CONTRIBUTING.md` -- setup, what must be green, PR conventions.
- `README.md` -- user-facing usage.

`CLAUDE.md` and this file describe the same repository. `CLAUDE.md` is loaded automatically by Claude Code; this file exists so any coding agent finds the same instructions.

## Protocol context

<https://cascadeprotocol.org/llms.txt> is the protocol index: install, quick start, data types, MCP server, security model, vocabulary versions, deployment sequence. About 95 lines, meant to be read in full.

Do **not** load `llms-full.txt` from that site. It is roughly 1.3 MB, larger than most working contexts, and as of 2026-08-20 its ontology section is known to be incomplete. Read the TTL files in [`spec`](https://github.com/the-cascade-protocol/spec) instead.

## Ground rules

- **`src/system-prompt.ts` is this repository's real payload.** It encodes what the agent knows about Cascade vocabulary. A class the prompt describes incorrectly produces queries that silently return nothing, which is worse than an error because nothing reports it.
- **Read the TTL in `spec` when writing prompt content.** Do not paraphrase a class from memory or from another repository's summary.
- **Vocabulary is not authored here.** This repository is the last step of the propagation sequence, never the first.
- **`npm ci --omit=optional` is the supported install path** and the one CI proves. A dependency that breaks the no-optional, no-native-build path breaks the clean install.
- Keep `VOCAB_VERSIONS` current even though the pre-commit hook does not force it on a prompt-only change. It is the only signal distinguishing "the agent knows this vocabulary" from "the agent mentions it".

## What must be green

```bash
npm ci --omit=optional
npm run build
npm test
```

Node 22. `npm test` chains its suites with `&&` and stops at the first failure, so read the whole run rather than the last line. This repository had no CI until 2026-07-03, and a stale suite masked failures for four months; treat a green run as a claim needing evidence.

## Conventions

- Commits: `feat(agent):`, `fix(agent):`, naming the vocabulary version where relevant.
- Bump `package.json` (patch for a system-prompt update).
- **The default branch is `master`, not `main`.** Branch from it; open a PR rather than pushing to it.
- Report anything you could not run in the PR body rather than only in a commit message.
