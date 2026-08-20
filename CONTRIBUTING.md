# Contributing to cascade-agent

`cascade-agent` is the natural language interface to the Cascade Protocol CLI, published as `@the-cascade-protocol/agent`. It wraps `cascade serve --mcp` and helps users query, validate and manage health Pods conversationally. Contributions are typically query patterns for vocabulary the agent does not know yet, a fix to the extraction or review pipeline, or test coverage.

## Before you start

- All open issues: <https://github.com/search?q=org%3Athe-cascade-protocol+is%3Aissue+is%3Aopen>
- Good first issues: <https://github.com/search?q=org%3Athe-cascade-protocol+is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22>

The "Known gaps" section of `CLAUDE.md` lists the classes the system prompt has no query patterns for. Those are the openings.

## Development setup

```bash
git clone https://github.com/the-cascade-protocol/cascade-agent.git
cd cascade-agent

npm ci --omit=optional   # not npm install, and never a symlinked node_modules
npm run build
```

CI runs Node 22.

`--omit=optional` is deliberate and is what CI proves: the package builds and tests with no optional dependencies and no native build step. If you add a dependency that breaks that, the clean-install path breaks with it.

To exercise the agent against a real Pod you also need [`cascade-cli`](https://github.com/the-cascade-protocol/cascade-cli) installed, since this package wraps its MCP server:

```bash
npm install -g @the-cascade-protocol/cli
```

## What must be green before review

```bash
npm ci --omit=optional
npm run build
npm test
```

`npm test` runs each suite in sequence and stops at the first failure, so a failure late in the chain hides everything after it. Read the whole run before concluding which suites passed.

This repository had **no CI at all until 2026-07-03**, which is how a stale test suite masked `npm test` failures for four months. Treat a green local run as a claim you need evidence for, not a default.

## Commit messages

```
feat(agent): add query patterns for Clinical v1.7 classes
feat(agent): update system prompt for Coverage v1.3
fix(agent): {description}
```

## Opening a pull request

1. Branch from `master`. This repository's default branch is `master`, not `main`.
2. Build and run the full suite.
3. Bump the version in `package.json` (patch for a system-prompt update).
4. Push and open a PR describing what changed in the system prompt, if anything, and which suites you ran.
5. If you could not run a suite, say so rather than leaving it implied.

### Updating the system prompt for new vocabulary

`src/system-prompt.ts` encodes everything the agent knows about Cascade vocabulary. When `spec` adds classes, the prompt is what makes them reachable:

- [ ] Add the class name and a one-line description to the "Supported Data Types" section
- [ ] Add at least one example `cascade pod query` invocation for the new type
- [ ] Add a jq example extracting a useful field from it
- [ ] Update the field reference tables
- [ ] Update `VOCAB_VERSIONS` to the vocabulary versions now reflected in the prompt
- [ ] Bump `package.json` (patch)

The pre-commit hook does **not** block a system-prompt-only change that leaves `VOCAB_VERSIONS` alone. Update it anyway; it is the only signal that says whether the agent knows about a vocabulary version or merely mentions it.

## Vocabulary changes

**Vocabulary is never authored here.** Class names and descriptions come from [`spec`](https://github.com/the-cascade-protocol/spec); read the TTL files when writing prompt content rather than paraphrasing from memory, because a class the agent describes incorrectly produces queries that silently return nothing.

If your change needs a class that does not exist yet, it starts in `spec`: read [`spec/CONTRIBUTING.md`](https://github.com/the-cascade-protocol/spec/blob/main/CONTRIBUTING.md) for the full seven-step propagation sequence. This repository is step 7, the last one.

## Protocol context

<https://cascadeprotocol.org/llms.txt> is the protocol index: install, quick start, data types, MCP server, security model, vocabulary versions, deployment sequence. About 95 lines, meant to be read in full.

Do not load `llms-full.txt` from that site. It is roughly 1.3 MB, larger than most working contexts, and as of 2026-08-20 its ontology section is known to be incomplete. Read the TTL files in `spec` instead.

## Questions?

Open an issue on this repository, or a [discussion on `spec`](https://github.com/the-cascade-protocol/spec/discussions) for questions about the vocabulary itself.
