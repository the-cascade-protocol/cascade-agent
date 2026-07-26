/**
 * The closed `purpose` enum (D-RMA-13), VENDORED.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE CANONICAL LIST LIVES IN THE WORKBENCH REPO, NOT HERE.                 │
 * │   cascade-workbench/packages/contracts/src/purpose.ts                     │
 * │ This file is a copy carrying the version it was copied at. When the       │
 * │ canonical list changes, re-copy BOTH the list and the version.            │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Why a closed enum at all: the relay's whole privacy claim is that it keeps a
 * count and not a copy. A free-text field in an otherwise content-free payload
 * is how content eventually reaches a log by accident. So the relay validates
 * `x-cascade-purpose` against this list and REJECTS an unrecognized value
 * rather than storing it.
 *
 * DEPLOY ORDER RULE: the relay must learn a new purpose BEFORE any app release
 * sends it, or the new feature's requests bounce with `unknown-purpose`.
 */

/** The version of the canonical list this copy was taken from. */
export const PURPOSE_ENUM_VERSION = "1.0.0";

/**
 * Every purpose Workbench records on an egress line. The relay only ever sees
 * the model-call ones; the literature-fetch entries are HTTP egress the sidecar
 * makes directly, and they are listed here so the ledger has one vocabulary.
 */
export const CASCADE_PURPOSES = [
  // Assertions Ledger: extraction, routing, grounding, adversarial review.
  "assertion-extraction",
  "assertion-grounding",
  "claim-classify",
  "classify",
  "adversarial-skeptic",
  "disconfirmation",
  "record-verdict-rationale",
  "grounding",
  // Literature path (de-identified).
  "literature-search",
  "literature-synthesis",
  "literature-grounding",
  "literature-citation-fetch",
  "citation-stance-verify",
  "stance-verify",
  // Conversational + document surfaces.
  "companion-ask",
  "cloud-ask",
  "document-extraction",
  // Reports.
  "report-next-steps",
] as const;

export type CascadePurpose = (typeof CASCADE_PURPOSES)[number];

export function isCascadePurpose(v: unknown): v is CascadePurpose {
  return (
    typeof v === "string" && (CASCADE_PURPOSES as readonly string[]).includes(v)
  );
}
