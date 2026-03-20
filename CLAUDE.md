# cascade-agent — Agent Context

## Repository Purpose

Natural language interface for the Cascade Protocol CLI.
Wraps `cascade serve --mcp` via the MCP shell tool; helps users query, validate, and manage health Pods conversationally.
Package: `@the-cascade-protocol/agent`

## Key Architecture

- `src/system-prompt.ts` — The agent's system prompt; defines its vocabulary knowledge, query patterns, and jq examples
- `src/index.ts` — Agent entry point

## MANDATORY: Deployment Discipline

The agent's system prompt encodes its knowledge of Cascade vocabulary. When vocabularies are updated, the system prompt must be updated to include:
- New class names and their descriptions
- Example query patterns for new classes (using `cascade pod query`)
- Example jq filters for extracting new record types
- Updated field reference tables

### When vocabulary classes are added to spec/SDKs, you MUST update `src/system-prompt.ts`:

- [ ] Add the new class name and a one-line description to the "Supported Data Types" section
- [ ] Add at least one example `cascade pod query` invocation for the new type
- [ ] Add a jq example showing how to extract a useful field from the new type
- [ ] Update `VOCAB_VERSIONS` to reflect the vocabulary versions now in the system prompt
- [ ] Bump `package.json` version (patch bump)

The pre-commit hook will NOT block system-prompt-only changes without updating `VOCAB_VERSIONS`, but you should update it as part of every vocabulary-awareness update.

### Current vocabulary versions in system prompt

Check `VOCAB_VERSIONS` at the repo root. Compare against `spec/VOCAB_VERSIONS` to see what the agent doesn't yet know about.

### Known gaps (as of 2026-03-20)

See `VOCAB_VERSIONS` comments. The agent currently has no query patterns for:
- Encounter, MedicationAdministration, ImplantedDevice, ImagingStudy (Clinical v1.7)
- ClaimRecord, BenefitStatement, DenialNotice (Coverage v1.3)
- FHIR passthrough properties (Core v2.8)

## Commit Conventions

```
feat(agent): add query patterns for Clinical v1.7 classes
feat(agent): update system prompt for Coverage v1.3
fix(agent): {description}
```

## Related Repositories

- **spec** — Authoritative vocabulary. Read TTL files when adding class descriptions to the system prompt.
- **cascade-cli** — The underlying tool this agent wraps; its commands are the agent's vocabulary.
