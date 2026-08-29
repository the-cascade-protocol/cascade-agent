/**
 * Tests for the vocabulary guidance in the system prompt.
 *
 * A system prompt is unusually easy to test vacuously: asserting that a string
 * appears in it proves only that someone typed the string, and such a test
 * passes just as happily when the guidance it "covers" is wrong. So almost
 * nothing here is a string search.
 *
 * Instead the tests EXTRACT the jq filters the prompt teaches — the literal
 * text a model copies out of it — and RUN them, with the real jq binary,
 * against fixtures shaped exactly like `cascade pod query --json` output. The
 * fixture property names are not taken from the prompt (that would be
 * circular); they are transcribed from the serializers that actually write
 * them, cited per record below. A filter that names a predicate no emitter
 * writes therefore yields null and fails here, which is precisely the failure
 * it would produce against a real pod: no error, no crash, just a confident
 * answer with the data missing.
 *
 * The load-bearing case is clinical v1.13. Four classes are deprecated in
 * favour of health: equivalents but are NOT removed, no emitter changed, and
 * the two spellings share no predicates. Every clinical fixture below is
 * therefore written in BOTH spellings, and a filter must return BOTH records
 * populated. Reverting any filter to a single namespace fails these tests.
 *
 * Run with: npx tsx src/tests/system-prompt.test.ts
 */
import assert from "assert";
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { getSystemPrompt } from "../system-prompt.js";

const PROMPT = getSystemPrompt();
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// ── Test harness (mirrors openai-compat.test.ts) ──────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${(err as Error).message}`);
    failed++;
  }
}

/**
 * Does the prompt name this exact term?
 *
 * Deliberately NOT `String.includes`: a plain substring test passes against a
 * renamed term (`clinical:LabResultXX` contains `clinical:LabResult`), which
 * makes a "the prompt still teaches X" assertion unfalsifiable. The lookahead
 * requires the term to end where it says it ends.
 */
function mentions(term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}(?![A-Za-z0-9])`).test(PROMPT);
}

/** Run a jq filter over a JSON value and return the parsed result. */
function jq(filter: string, input: unknown): unknown {
  const out = execFileSync("jq", ["-c", filter], {
    input: JSON.stringify(input),
    encoding: "utf8",
  });
  const lines = out.trim().split("\n").filter(Boolean);
  return lines.length === 1 ? JSON.parse(lines[0]) : lines.map((l) => JSON.parse(l));
}

// ── Fixtures ──────────────────────────────────────────────────────────────────
//
// Property names below are transcribed from the emitters, NOT from the prompt.
//
//   health: spelling  — cascade-cli src/lib/fhir-converter/converters-clinical.ts
//                       and src/lib/ccda-converter/sections/{labs,problems,medications}.ts
//                       (the FHIR and C-CDA import paths)
//   clinical: spelling — cascade-sdk-swift Clinical/Serializers/ClinicalRecordSerializers.swift
//                       (the pod export path) and cascade-cli src/commands/pod/extract.ts
//                       (the AI document-extraction path)
//
// Both are live. Neither is a provenance signal: cascade:dataProvenance is.

interface Rec {
  id: string;
  type: string;
  properties: Record<string, string>;
}

const CONDITIONS: Rec[] = [
  {
    // Import path (FHIR/C-CDA). No health:snomedSemanticTag — it is optional and
    // most imported pods carry none, which is why requiring == "disorder" empties
    // the result set on a real pod.
    id: "urn:cascade:condition:import-1",
    type: "health:ConditionRecord",
    properties: {
      "health:conditionName": "Essential hypertension",
      "health:clinicalStatus": "active",
      "health:onsetDate": "2020-01-15",
      "core:dataProvenance": "https://ns.cascadeprotocol.org/core/v1#EHRVerified",
    },
  },
  {
    // Export/extract path — the DEPRECATED but still-emitted spelling.
    id: "urn:cascade:condition:export-1",
    type: "clinical:Condition",
    properties: {
      "clinical:conditionName": "Type 2 diabetes mellitus",
      "clinical:clinicalStatus": "active",
      "clinical:onsetDate": "2018-06-01",
      "core:dataProvenance": "https://ns.cascadeprotocol.org/core/v1#EHRVerified",
    },
  },
  {
    // Must be EXCLUDED: contextual finding, not a disorder.
    id: "urn:cascade:condition:finding-1",
    type: "health:ConditionRecord",
    properties: {
      "health:conditionName": "Lives alone",
      "health:clinicalStatus": "active",
      "health:snomedSemanticTag": "finding",
    },
  },
  {
    // Must be EXCLUDED: resolved.
    id: "urn:cascade:condition:resolved-1",
    type: "health:ConditionRecord",
    properties: {
      "health:conditionName": "Acute bronchitis",
      "health:clinicalStatus": "resolved",
    },
  },
];

// The source-axis and interpretation properties below carry the core v3.5 /
// health v2.7 / clinical v1.15 cases:
//
//   import-1 and export-1 are ONE organization arriving through two transports,
//   in two ingestion batches, under two different display labels. They agree on
//   nothing but cascade:sourceIdentity, which is exactly why that is the only
//   axis a reconciler may key on.
//   import-2 carries NO sourceIdentity: the "origin unknown" case, which shares
//   an ingestion batch with import-1 and must not be merged into its origin.
//   import-1 and export-2 carry a source interpretation code that is in neither
//   bound value set; export-1 and import-2 carry a ratified code and no source
//   code, which is the ordinary case and is not a finding.
const LAB_RESULTS: Rec[] = [
  {
    id: "urn:cascade:labresult:import-1",
    type: "health:LabResultRecord",
    properties: {
      "health:testName": "Hemoglobin A1c",
      "health:resultValue": "7.1",
      "health:resultUnit": "%",
      "health:performedDate": "2026-03-01",
      "health:interpretation": "H",
      "health:interpretationSourceCode": "elevated",
      "core:sourceIdentity": "org:meridian",
      "clinical:sourceEHR": "Meridian Health System",
      "core:sourceSystem": "apple-health-export",
    },
  },
  {
    // Deprecated spelling: different predicate for EVERY field.
    id: "urn:cascade:labresult:export-1",
    type: "clinical:LabResult",
    properties: {
      "clinical:testName": "Hemoglobin A1c",
      "clinical:value": "6.4",
      "clinical:unit": "%",
      "clinical:effectiveDate": "2025-09-12",
      "clinical:interpretation": "N",
      "core:sourceIdentity": "org:meridian",
      "clinical:sourceEHR": "Meridian Health",
      "core:sourceSystem": "ccda-import-2026-02",
    },
  },
  {
    // Deprecated spelling, non-numeric result: clinical:valueString, not clinical:value.
    id: "urn:cascade:labresult:export-2",
    type: "clinical:LabResult",
    properties: {
      "clinical:testName": "Hemoglobin A1c",
      "clinical:valueString": "not detected",
      "clinical:unit": "",
      "clinical:effectiveDate": "2025-01-04",
      "clinical:interpretation": "ND",
      "clinical:interpretationSourceCode": "NOT DETECTED by local assay",
      "core:sourceIdentity": "org:northlake",
      "clinical:sourceEHR": "Northlake Clinic",
      "core:sourceSystem": "ccda-import-2026-02",
    },
  },
  {
    // Must be EXCLUDED by the A1c filter.
    id: "urn:cascade:labresult:import-2",
    type: "health:LabResultRecord",
    properties: {
      "health:testName": "Serum creatinine",
      "health:resultValue": "0.9",
      "health:resultUnit": "mg/dL",
      "health:performedDate": "2026-03-01",
      "health:interpretation": "N",
      "clinical:sourceEHR": "Meridian Health System",
      "core:sourceSystem": "apple-health-export",
    },
  },
];

/**
 * Vital signs (clinical:VitalSign). Two records carry a value; two carry NO
 * value and a cascade:dataAbsentReason saying why, with two DIFFERENT reasons.
 * A pod that only ever said "unknown" could not tell those two apart, which is
 * what core v3.6 and the 15-code value set fixed.
 */
const VITAL_SIGNS: Rec[] = [
  {
    id: "urn:cascade:vital:1",
    type: "clinical:VitalSign",
    properties: {
      "clinical:vitalType": "Blood Pressure",
      "clinical:value": "128/82",
      "clinical:unit": "mmHg",
      "clinical:interpretation": "A",
      // The word the source actually used. Not in either bound value set, so it
      // rides here verbatim rather than being dropped or forced into the enum.
      "clinical:interpretationSourceCode": "elevated",
    },
  },
  {
    id: "urn:cascade:vital:2",
    type: "clinical:VitalSign",
    properties: {
      "clinical:vitalType": "Body Weight",
      "core:dataAbsentReason": "asked-declined",
    },
  },
  {
    id: "urn:cascade:vital:3",
    type: "clinical:VitalSign",
    properties: {
      "clinical:vitalType": "Oxygen Saturation",
      "core:dataAbsentReason": "not-asked",
    },
  },
  {
    id: "urn:cascade:vital:4",
    type: "clinical:VitalSign",
    properties: {
      "clinical:vitalType": "Heart Rate",
      "clinical:value": "68",
      "clinical:unit": "bpm",
      "clinical:interpretation": "N",
    },
  },
];

/**
 * Procedures. ONE class, clinical:Procedure, and two live name predicates
 * during the clinical v1.15 migration window: the canonical
 * clinical:procedureName, and health:procedureName as written by a C-CDA import
 * path onto records it types clinical:Procedure.
 */
const PROCEDURES: Rec[] = [
  {
    // C-CDA import path: the name is on the health: predicate.
    id: "urn:cascade:procedure:ccda-1",
    type: "clinical:Procedure",
    properties: {
      "health:procedureName": "Colonoscopy",
      "clinical:procedureDate": "2024-05-14",
      "clinical:bodySite": "Colon",
    },
  },
  {
    // Canonical spelling.
    id: "urn:cascade:procedure:canonical-1",
    type: "clinical:Procedure",
    properties: {
      "clinical:procedureName": "Appendectomy",
      "clinical:procedureDate": "2019-11-02",
      "clinical:bodySite": "Appendix",
    },
  },
];

/**
 * Encounters, clinical v1.16. TRANSCRIBED FROM REAL `cascade pod query
 * --encounters --json` OUTPUT (cascade-cli 0.21.0), not from the prompt, and
 * three properties of that output are load-bearing here:
 *
 *   1. The bucket holds BOTH `clinical:Encounter` and the
 *      `clinical:EncounterParticipant` sub-nodes that hang off them, because
 *      `pod-data-types.ts` routes the participation into `encounters.ttl` and
 *      the read path does not filter sub-nodes out. Two visits with three
 *      participants come back as FIVE records.
 *   2. `clinical:hasParticipant` is REPEATABLE, and `pod-read.ts` flattens a
 *      repeated predicate by joining the values with ", ". So the edge arrives
 *      as one delimited string, not a list, and must be split to be followed.
 *   3. Core-vocabulary predicates arrive prefixed `core:`, never `cascade:`:
 *      `shortenIRI` resolves `core:` first because both prefixes are bound to
 *      the same namespace in `CASCADE_NAMESPACES`.
 *
 * A filter that reads `clinical:providerName` instead of traversing gets ONE
 * name per visit and cannot say what role it played — which is the v1.16
 * regression this fixture exists to catch.
 */
const ENCOUNTERS: Rec[] = [
  {
    id: "urn:cascade:encounter:1",
    type: "clinical:Encounter",
    properties: {
      "clinical:encounterClass": "AMB",
      "clinical:encounterClassDisplay": "ambulatory",
      "clinical:encounterClassSystem": "http://terminology.hl7.org/CodeSystem/v3-ActCode",
      "clinical:encounterStart": "2026-03-04T14:30:00Z",
      // Repeatable + free text: joined, and NOT safely splittable.
      "clinical:encounterReason": "Chest pain, Medication review",
      // The single summary slot. Retained, but it names only ONE of the three
      // people below and does not say which role that one played.
      "clinical:providerName": "Dr. Alice Nguyen",
      "clinical:facilityName": "Meridian Cardiology",
      "clinical:sourceRecordId": "enc-99123",
      "clinical:businessIdentifier": "http://meridian.example/visit|VN-4471",
      "clinical:hasParticipant": "urn:cascade:participant:1, urn:cascade:participant:2",
      "core:dataProvenance": "https://ns.cascadeprotocol.org/core/v1#EHRVerified",
    },
  },
  {
    // An ADMISSION: admitSource/dischargeDisposition are present, which is the
    // only structured signal separating this from an office visit.
    id: "urn:cascade:encounter:2",
    type: "clinical:Encounter",
    properties: {
      "clinical:encounterClass": "IMP",
      "clinical:encounterClassDisplay": "inpatient encounter",
      "clinical:encounterStart": "2025-11-18T02:10:00Z",
      "clinical:admitSource": "Emergency department",
      "clinical:dischargeDisposition": "Home or Self Care",
      "clinical:providerName": "Dr. Carla Reyes",
      "clinical:sourceRecordId": "enc-99124",
      "clinical:hasParticipant": "urn:cascade:participant:3",
      "core:dataProvenance": "https://ns.cascadeprotocol.org/core/v1#EHRVerified",
    },
  },
  {
    id: "urn:cascade:participant:1",
    type: "clinical:EncounterParticipant",
    properties: {
      "clinical:participantName": "Dr. Alice Nguyen",
      "clinical:participantRole": "attender",
      "clinical:participantRoleCode": "ATND",
      "clinical:participantSpecialty": "Cardiology",
    },
  },
  {
    // The REFERRER. Never surfaced by clinical:providerName, and the person a
    // "who sent me to cardiology" question is actually about.
    id: "urn:cascade:participant:2",
    type: "clinical:EncounterParticipant",
    properties: {
      "clinical:participantName": "Dr. Ben Ortiz",
      "clinical:participantRole": "referrer",
      "clinical:participantRoleCode": "REF",
      "clinical:participantSpecialty": "Internal Medicine",
    },
  },
  {
    // Specialty absent: the source did not state one. Not a finding.
    id: "urn:cascade:participant:3",
    type: "clinical:EncounterParticipant",
    properties: {
      "clinical:participantName": "Dr. Carla Reyes",
      "clinical:participantRole": "admitter",
      "clinical:participantRoleCode": "ADM",
    },
  },
];

/**
 * Clinical documents, clinical v1.16. The two status predicates are
 * INDEPENDENT, and the fixture is built so that reading the wrong one gives the
 * wrong answer in BOTH directions:
 *
 *   document:1  status "final"   + documentReferenceStatus "superseded"
 *               A perfectly final note whose reference has been replaced. Read
 *               clinical:status and you call a stale document current.
 *   document:2  status "amended" + documentReferenceStatus "current"
 *               Corrected content that IS the live version. Read
 *               clinical:status and "amended" looks like a supersession, so you
 *               hide the document the user actually needs.
 *
 * Also: documentAuthorName is repeatable and comma-joined, and the
 * authenticator is a THIRD person who wrote none of it.
 */
const DOCUMENTS: Rec[] = [
  {
    id: "urn:cascade:document:1",
    type: "clinical:ClinicalDocument",
    properties: {
      "clinical:documentTitle": "Cardiology consultation note",
      "clinical:documentDate": "2026-03-04",
      "clinical:status": "final",
      "clinical:documentReferenceStatus": "superseded",
      "clinical:providerName": "Dr. Alice Nguyen",
      "clinical:documentAuthorName": "Dr. Alice Nguyen, Dr. Ben Ortiz",
      "clinical:authenticatorName": "Dr. Carla Reyes",
      "clinical:sourceEHR": "Meridian Health System",
    },
  },
  {
    id: "urn:cascade:document:2",
    type: "clinical:ClinicalDocument",
    properties: {
      "clinical:documentTitle": "Discharge summary",
      "clinical:documentDate": "2025-11-20",
      "clinical:status": "amended",
      "clinical:documentReferenceStatus": "current",
      "clinical:documentAuthorName": "Dr. Carla Reyes",
      "clinical:sourceEHR": "Meridian Health System",
    },
  },
];

/** Insurance plans, coverage v1.5. One cancelled, one active, one silent. */
const INSURANCE: Rec[] = [
  {
    id: "urn:cascade:coverage:1",
    type: "coverage:InsurancePlan",
    properties: {
      "coverage:planName": "Meridian PPO Gold",
      "coverage:coverageType": "EHCPOL",
      "coverage:status": "cancelled",
    },
  },
  {
    id: "urn:cascade:coverage:2",
    type: "coverage:InsurancePlan",
    properties: {
      "coverage:planName": "Northlake HMO",
      "coverage:coverageType": "primary",
      "coverage:status": "active",
    },
  },
  {
    // Pre-v1.5 record: the property is new, so most existing records lack it.
    // Absent must read as "not stated", never as active.
    id: "urn:cascade:coverage:3",
    type: "coverage:InsurancePlan",
    properties: { "coverage:planName": "Legacy Dental", "coverage:coverageType": "dental" },
  },
];

/**
 * Lab reports with a core v3.7 attachment sub-node sharing the bucket.
 *
 * NOTE: cascade-cli 0.21.0 emits NO cascade:Attachment node on any path — core
 * v3.7 has no producer yet — so this fixture is a forward-looking shape, and
 * the prompt says as much rather than telling the agent to expect one.
 */
const LAB_REPORTS: Rec[] = [
  {
    id: "urn:cascade:labreport:1",
    type: "clinical:LaboratoryReport",
    properties: {
      "clinical:panelName": "Comprehensive Metabolic Panel",
      "core:hasAttachment": "urn:cascade:attachment:1",
    },
  },
  {
    id: "urn:cascade:attachment:1",
    type: "core:Attachment",
    properties: {
      "core:attachmentPath": "attachments/sha-256/3f786850e387550fdab836ed7e6dc881de23001b",
      "core:attachmentMediaType": "application/pdf",
      "core:contentHash": "3f786850e387550fdab836ed7e6dc881de23001b",
      "core:hashAlgorithm": "sha-256",
    },
  },
];

const MEDICATIONS: Rec[] = [
  {
    // clinical:Medication is NOT deprecated, but its predicates are clinical:,
    // not health: — converters-clinical.ts writes clinical:drugName / :dosage /
    // :status / :rxNormCode, and ccda medications.ts writes health:startDate.
    id: "urn:cascade:medication:1",
    type: "clinical:Medication",
    properties: {
      "clinical:drugName": "Lisinopril 10 MG Oral Tablet",
      "clinical:dosage": "10 mg once daily",
      "clinical:status": "active",
      "clinical:rxNormCode": "http://www.nlm.nih.gov/research/umls/rxnorm/314076",
      "health:startDate": "2024-02-01",
      "health:doseUnit": "mg",
    },
  },
  {
    // MedicationAdministration is the one path that writes health:medicationName
    // (converters-clinical.ts convertMedicationAdministration).
    id: "urn:cascade:medication:2",
    type: "clinical:MedicationAdministration",
    properties: {
      "health:medicationName": "Metformin 500 MG Oral Tablet",
      "health:doseQuantity": "500 mg",
      "health:startDate": "2023-11-20",
    },
  },
  {
    // Must be EXCLUDED: no longer taken.
    id: "urn:cascade:medication:3",
    type: "clinical:Medication",
    properties: {
      "clinical:drugName": "Amoxicillin 500 MG Oral Capsule",
      "clinical:dosage": "500 mg three times daily",
      "clinical:status": "stopped",
      "health:startDate": "2022-04-02",
    },
  },
];

/**
 * One record per spelling for every concept named in the prompt's two-spellings
 * predicate table, so a table row can be checked by resolving it against both.
 */
const SPELLING_PAIR_FIXTURE: Record<"health" | "clinical", Record<string, string>> = {
  health: {
    "health:conditionName": "Essential hypertension",
    "health:clinicalStatus": "active",
    "health:onsetDate": "2020-01-15",
    "health:testName": "Hemoglobin A1c",
    "health:resultValue": "7.1",
    "health:resultUnit": "%",
    "health:performedDate": "2026-03-01",
    "health:allergen": "Penicillin G",
    "health:vaccineName": "Influenza, seasonal, injectable",
    "health:administrationDate": "2025-10-08",
  },
  clinical: {
    "clinical:conditionName": "Type 2 diabetes mellitus",
    "clinical:clinicalStatus": "active",
    "clinical:onsetDate": "2018-06-01",
    "clinical:testName": "Hemoglobin A1c",
    "clinical:value": "6.4",
    "clinical:valueString": "not detected",
    "clinical:unit": "%",
    "clinical:effectiveDate": "2025-09-12",
    "clinical:allergen": "Penicillin G",
    "clinical:vaccineName": "Influenza, seasonal, injectable",
    "clinical:occurrenceDate": "2025-10-08",
  },
};

/** Wrap records in the `cascade pod query --json` envelope. */
function envelope(bucket: string, records: Rec[]): unknown {
  return {
    dataTypes: {
      [bucket]: { count: records.length, file: `clinical/${bucket}.ttl`, records },
    },
  };
}

const BUCKET_FIXTURES: Record<string, unknown> = {
  conditions: envelope("conditions", CONDITIONS),
  "lab-results": envelope("lab-results", LAB_RESULTS),
  "vital-signs": envelope("vital-signs", VITAL_SIGNS),
  procedures: envelope("procedures", PROCEDURES),
  medications: envelope("medications", MEDICATIONS),
  encounters: envelope("encounters", ENCOUNTERS),
  documents: envelope("documents", DOCUMENTS),
  insurance: envelope("insurance", INSURANCE),
  "lab-reports": envelope("lab-reports", LAB_REPORTS),
  "social-history": envelope("social-history", [
    {
      id: "urn:cascade:socialhistory:1",
      type: "health:SocialHistoryRecord",
      properties: {
        "health:smokingStatus": "former smoker",
        "health:alcoholUse": "occasional",
        "health:exerciseFrequency": "3x weekly",
        "health:occupationalExposure": "none reported",
      },
    },
  ]),
  "clinical-social-history": envelope("clinical-social-history", [
    {
      id: "urn:cascade:clinicalsocialhistory:1",
      type: "clinical:SocialHistoryRecord",
      properties: {
        "clinical:socialHistoryCategory": "smokingStatus",
        "health:smokingStatus": "former smoker",
        "clinical:packsPerYear": "12",
      },
    },
  ]),
  conflicts: envelope("conflicts", [
    {
      id: "urn:cascade:conflict:1",
      type: "cascade:UserResolution",
      properties: {
        "cascade:conflictId": "c-001",
        "cascade:resolution": "kept-source-a",
        "cascade:userNote": "the clinic record is the current one",
      },
    },
  ]),
  notes: envelope("notes", [
    {
      id: "urn:cascade:note:1",
      type: "oa:Annotation",
      properties: {
        "oa:motivatedBy": "workbench:followUp",
        "oa:hasTarget": "urn:cascade:condition:import-1",
        "ical:status": "NEEDS-ACTION",
        "ical:due": "2026-09-01",
        "prov:wasAttributedTo": "urn:cascade:caregiver:1",
      },
    },
  ]),
  assertions: envelope("assertions", [
    {
      id: "urn:cascade:assertion:1",
      type: "evidence:Assertion",
      properties: {
        "evidence:settled": "evidence:NeedsEvidence",
        "evidence:assertionText": "the new medication may explain the fatigue",
        "evidence:reason": "evidence:NeedsLiterature",
        "evidence:direction": "evidence:None",
        "evidence:basis": "evidence:None",
      },
    },
  ]),
};

// ── Filter extraction ─────────────────────────────────────────────────────────

/** Every literal jq filter the prompt teaches, in prompt order. */
function extractJqFilters(): string[] {
  const re = /\|\s*jq\s+'([\s\S]*?)'/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(PROMPT)) !== null) out.push(m[1]);
  return out;
}

/** Which fixture bucket a filter reads, or undefined if it is a template. */
function bucketOf(filter: string): string | undefined {
  const m = filter.match(/\.dataTypes(?:\.([a-zA-Z-]+)|\["([^"]+)"\])/);
  if (!m) return undefined;
  return m[1] ?? m[2];
}

// ── Tests ─────────────────────────────────────────────────────────────────────

function main(): void {
  console.log("\nsystem-prompt.test.ts — vocabulary guidance, executed not asserted-about\n");

  // jq is the instrument for most of what follows. If it is missing, every
  // filter test below would "pass" by never running, which is the exact class
  // of vacuous green this suite exists to prevent. Fail loudly instead.
  test("jq is available (a missing jq must fail, never silently skip)", () => {
    const version = execFileSync("jq", ["--version"], { encoding: "utf8" }).trim();
    assert.ok(/^jq-/.test(version), `unexpected jq version banner: ${version}`);
  });

  const filters = extractJqFilters();

  test("the prompt teaches jq filters, and all but the documented template are runnable", () => {
    assert.ok(filters.length >= 10, `expected >= 10 jq filters in the prompt, found ${filters.length}`);
    const templates = filters.filter((f) => f.includes(".dataTypes.TYPE"));
    assert.strictEqual(
      templates.length,
      1,
      "exactly one filter may be a <TYPE> placeholder (the field-discovery recipe); " +
        `found ${templates.length}`
    );
    const unroutable = filters.filter(
      (f) => !f.includes(".dataTypes.TYPE") && !BUCKET_FIXTURES[bucketOf(f) ?? ""]
    );
    assert.deepStrictEqual(
      unroutable.map(bucketOf),
      [],
      "every non-template filter must address a bucket this suite has a fixture for; " +
        "an unfixtured bucket is an untested filter"
    );
  });

  test("every jq filter in the prompt parses and runs (no syntax errors shipped)", () => {
    for (const filter of filters) {
      if (filter.includes(".dataTypes.TYPE")) continue;
      const bucket = bucketOf(filter)!;
      // Throws on a jq parse error or a runtime error such as
      // `null (null) cannot be matched, as it is not a string`.
      jq(filter, BUCKET_FIXTURES[bucket]);
    }
  });

  // ── The clinical v1.13 both-spellings requirement ──────────────────────────

  test("conditions: the taught filter returns BOTH the health: and the deprecated clinical: record, named", () => {
    const filter = filters.find((f) => f.includes(".dataTypes.conditions"))!;
    const rows = jq(filter, BUCKET_FIXTURES.conditions) as Array<{ name: string | null }>;
    const names = rows.map((r) => r.name);
    assert.ok(
      names.includes("Essential hypertension"),
      `import-path (health:ConditionRecord) condition missing; got ${JSON.stringify(names)}`
    );
    assert.ok(
      names.includes("Type 2 diabetes mellitus"),
      "export-path (clinical:Condition) condition missing or unnamed — a filter that reads " +
        `only health: predicates produces exactly this; got ${JSON.stringify(names)}`
    );
    assert.ok(
      !names.includes(null),
      `no row may come back with a null name; got ${JSON.stringify(names)}`
    );
  });

  test("conditions: the filter is not vacuous — the finding and the resolved condition are excluded", () => {
    const filter = filters.find((f) => f.includes(".dataTypes.conditions"))!;
    const rows = jq(filter, BUCKET_FIXTURES.conditions) as Array<{ name: string }>;
    const names = rows.map((r) => r.name);
    assert.ok(!names.includes("Lives alone"), "a snomedSemanticTag=finding record must be filtered out");
    assert.ok(!names.includes("Acute bronchitis"), "a resolved condition must be filtered out");
    assert.strictEqual(rows.length, 2, `expected exactly the 2 active disorders, got ${JSON.stringify(names)}`);
  });

  test("lab results: the taught filter reads value/unit/date across BOTH spellings", () => {
    const filter = filters.find(
      (f) => f.includes('.dataTypes["lab-results"]') && f.includes("sort_by(.date)") && !f.includes("a1c")
    )!;
    const rows = jq(filter, BUCKET_FIXTURES["lab-results"]) as Array<{
      test: string | null;
      value: string | null;
      date: string | null;
    }>;
    assert.strictEqual(rows.length, 4, "all four lab records must survive the filter");
    for (const row of rows) {
      assert.ok(row.test !== null, `a lab row came back with a null test name: ${JSON.stringify(row)}`);
      assert.ok(row.value !== null, `a lab row came back with a null value: ${JSON.stringify(row)}`);
      assert.ok(row.date !== null, `a lab row came back with a null date: ${JSON.stringify(row)}`);
    }
    // clinical:valueString is the non-numeric fallback and must not be dropped.
    assert.ok(
      rows.some((r) => r.value === "not detected"),
      "a clinical:valueString result must be read, not reported as absent"
    );
  });

  test("lab results: the HbA1c example finds A1c under BOTH spellings and excludes the creatinine", () => {
    const filter = filters.find((f) => f.includes("a1c"))!;
    const rows = jq(filter, BUCKET_FIXTURES["lab-results"]) as Array<{ test: string; value: string }>;
    assert.strictEqual(rows.length, 3, `expected the 3 A1c results, got ${JSON.stringify(rows)}`);
    assert.ok(
      rows.some((r) => r.value === "7.1") && rows.some((r) => r.value === "6.4"),
      "both the health: and the clinical: spelled A1c results must appear"
    );
    assert.ok(!rows.some((r) => r.test === "Serum creatinine"), "the non-A1c lab must be excluded");
  });

  test("medications: the taught filters name predicates the emitters actually write", () => {
    for (const filter of filters.filter((f) => f.includes(".dataTypes.medications"))) {
      const rows = jq(filter, BUCKET_FIXTURES.medications) as Array<{ name: string | null }>;
      const names = rows.map((r) => r.name);
      assert.ok(
        names.includes("Lisinopril 10 MG Oral Tablet"),
        "a clinical:Medication must be named via clinical:drugName — naming it via " +
          `health:medicationName yields null; got ${JSON.stringify(names)}`
      );
      assert.ok(
        names.includes("Metformin 500 MG Oral Tablet"),
        `the health:medicationName fallback must also resolve; got ${JSON.stringify(names)}`
      );
      assert.ok(!names.includes(null), `no medication row may be unnamed; got ${JSON.stringify(names)}`);
    }
  });

  test("medications: the doctor-visit filter excludes a stopped medication (not vacuous)", () => {
    const filter = filters.find(
      (f) => f.includes(".dataTypes.medications") && f.includes("entered-in-error")
    )!;
    const rows = jq(filter, BUCKET_FIXTURES.medications) as Array<{ name: string }>;
    assert.ok(
      !rows.some((r) => r.name.startsWith("Amoxicillin")),
      "a clinical:status=stopped medication must not be presented as current"
    );
    assert.strictEqual(rows.length, 2, `expected the 2 current medications, got ${JSON.stringify(rows)}`);
  });

  test("the prompt never tells the agent to filter on health:isActive (no emitter writes it)", () => {
    assert.ok(
      !PROMPT.includes('"health:isActive"'),
      "health:isActive is written by no Cascade emitter; filtering on it silently returns []"
    );
  });

  // ── The two-spellings predicate table ──────────────────────────────────────

  test("the two-spellings table lists a health: AND a clinical: predicate for every concept, and both resolve", () => {
    const section = PROMPT.split("THE PROPERTY NAMES ALSO DIFFER")[1];
    assert.ok(section, "the prompt must carry the predicate-difference table");
    const table = section.split("Always read with a fallback")[0];
    const rows = table
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.includes("health:") && l.includes("clinical:"));
    assert.ok(rows.length >= 8, `expected >= 8 table rows, found ${rows.length}`);

    for (const row of rows) {
      const healthProps = [...row.matchAll(/health:[A-Za-z]+/g)].map((m) => m[0]);
      const clinicalProps = [...row.matchAll(/clinical:[A-Za-z]+/g)].map((m) => m[0]);
      assert.ok(healthProps.length >= 1 && clinicalProps.length >= 1, `row names only one spelling: ${row}`);
      // Every predicate the row names must exist on the corresponding fixture:
      // a row naming a predicate no emitter writes would resolve to null here.
      const expr =
        "(" +
        [...healthProps, ...clinicalProps].map((p) => `.["${p}"]`).join(" // ") +
        ")";
      for (const spelling of ["health", "clinical"] as const) {
        const value = jq(expr, SPELLING_PAIR_FIXTURE[spelling]);
        assert.ok(
          value !== null,
          `table row "${row}" resolves to null on a ${spelling}:-spelled record — ` +
            "the pairing is wrong or one side names a predicate nothing emits"
        );
      }
    }
  });

  test("all four deprecated clinical classes are named alongside their health: replacement", () => {
    const pairs: Array<[string, string]> = [
      ["clinical:Condition", "health:ConditionRecord"],
      ["clinical:LabResult", "health:LabResultRecord"],
      ["clinical:Allergy", "health:AllergyRecord"],
      ["clinical:Immunization", "health:ImmunizationRecord"],
    ];
    for (const [deprecated, replacement] of pairs) {
      assert.ok(
        mentions(deprecated),
        `${deprecated} is deprecated but NOT removed and is still emitted; dropping it from ` +
          "the prompt makes the agent blind to every export-path and extract-path record"
      );
      assert.ok(mentions(replacement), `${replacement} missing from the prompt`);
    }
    assert.ok(
      /NOT removed/i.test(PROMPT),
      "the prompt must state that the deprecated classes are not removed, or a model will " +
        "reasonably infer it can stop reading them"
    );
  });

  // ── core v3.4 export manifest ──────────────────────────────────────────────

  test("the manifest count properties are classified correctly: records are counts, days are not", () => {
    // Parse the two lists straight out of the prompt, then apply them to a
    // synthetic manifest whose true totals are known.
    const countsBlock = PROMPT.split("Counts:")[1]?.split("Each is rdfs:subPropertyOf")[0];
    assert.ok(countsBlock, "the prompt must enumerate the RecordSummary count properties");
    // Capture EVERY cascade: term in the block, not only those already spelled
    // *Count. Filtering to *Count here would let a day property be smuggled into
    // the record-count list without this test noticing — which is the mistake.
    const recordCountProps = [...countsBlock.matchAll(/cascade:([a-zA-Z]+)/g)].map((m) => m[1]);

    const daysBlock = PROMPT.split("DAY COUNTS ARE NOT RECORD COUNTS")[1]?.split("count DAYS")[0];
    assert.ok(daysBlock, "the prompt must call out the day-count properties separately");
    const dayProps = [...daysBlock.matchAll(/cascade:([a-zA-Z]+)/g)].map((m) => m[1]);

    // Completeness against core v3.4.
    assert.deepStrictEqual(
      [...recordCountProps].sort(),
      [
        "allergyCount",
        "conditionCount",
        "coverageCount",
        "immunizationCount",
        "labResultCount",
        "medicationCount",
        "supplementCount",
      ],
      "the seven core v3.4 RecordSummary count properties"
    );
    assert.deepStrictEqual(
      [...dayProps].sort(),
      ["activityDays", "bloodPressureDays", "heartRateDays", "sleepDays", "vitalSignDays"],
      "the five core v3.4 day-count properties"
    );
    assert.strictEqual(
      recordCountProps.filter((p) => dayProps.includes(p)).length,
      0,
      "no property may be presented as both a record count and a day count"
    );

    // A synthetic clinical+wellness summary. The day figures are deliberately
    // large: misfiling one as a record count inflates the total, which is the
    // real-world harm (telling someone they have 4,015 records, not 26).
    const summary: Record<string, number> = {
      conditionCount: 6,
      medicationCount: 9,
      allergyCount: 2,
      labResultCount: 5,
      immunizationCount: 3,
      coverageCount: 1,
      supplementCount: 0,
      vitalSignDays: 365,
      heartRateDays: 730,
      bloodPressureDays: 180,
      activityDays: 1200,
      sleepDays: 1540,
    };
    const total = recordCountProps.reduce((n, p) => n + (summary[p] ?? 0), 0);
    assert.strictEqual(
      total,
      26,
      `record total must be 26; got ${total}. A *Days property counted as records causes this.`
    );
  });

  test("the manifest classes and the cross-provenance scenario terms are taught", () => {
    for (const term of [
      "cascade:ExportManifest",
      "cascade:RecordSummary",
      "cascade:InteractionScenario",
      "cascade:requiresCrossProvenance",
      "cascade:provenanceLayers",
      "cascade:sampleCount",
      "cascade:loincCode",
      "manifest.ttl",
    ]) {
      assert.ok(mentions(term), `core v3.4 term missing from the prompt: ${term}`);
    }
    assert.ok(
      mentions("cascade:date") && mentions("health:date"),
      "cascade:date has an equivalent health:date spelling; teaching only one repeats the " +
        "single-spelling mistake in a second place"
    );
  });

  // ── health v2.5 ────────────────────────────────────────────────────────────

  test("all six health v2.5 wellness containers are taught as HealthProfile subclasses", () => {
    const containers = [
      "health:ActivityData",
      "health:SleepData",
      "health:HeartRateData",
      "health:BloodPressureData",
      "health:HRVData",
      "health:BodyMeasurements",
    ];
    for (const c of containers) assert.ok(mentions(c), `missing wellness container: ${c}`);
    // The subclass axiom must sit with the container list, not somewhere else in
    // the prompt: a reader has to see the two together to act on them.
    const start = PROMPT.indexOf("health:ActivityData");
    const block = PROMPT.slice(Math.max(0, start - 400), start + 400);
    assert.ok(
      /subClassOf health:HealthProfile/.test(block),
      "the containers must be stated as subclasses of health:HealthProfile — that axiom is " +
        "what makes a HealthProfile query return them"
    );
    for (const c of containers) {
      assert.ok(block.includes(c), `${c} is named somewhere, but not with the subclass axiom`);
    }
  });

  test("the namespace boundary is taught as historical, with dataProvenance as the only origin signal", () => {
    const block = PROMPT.split("NAMESPACE BOUNDARY")[1]?.split("\n  •")[0] ?? "";
    assert.ok(block.length > 0, "the prompt must carry the namespace-boundary rule");
    assert.ok(/HISTORICAL/.test(block), "the boundary must be called historical, not semantic");
    assert.ok(
      /cascade:dataProvenance/.test(block),
      "the rule is only actionable if it names cascade:dataProvenance as the replacement signal"
    );
  });

  // ── clinical v1.10-v1.12 graph edges ───────────────────────────────────────

  test("the graph edges are taught, including that the superproperty returns both indication families", () => {
    for (const edge of [
      "clinical:hasEncounter",
      "clinical:indicationReference",
      "clinical:parsedIndicationReference",
      "clinical:linkedCondition",
    ]) {
      assert.ok(mentions(edge), `missing graph edge: ${edge}`);
    }
    const block = PROMPT.split("clinical:parsedIndicationReference is rdfs:subPropertyOf")[1] ?? "";
    assert.ok(block.length > 0, "the subproperty relationship must be stated explicitly");
    assert.ok(
      /TRAVERSE THE SUPERPROPERTY/.test(PROMPT),
      "traversing clinical:indicationReference returns both stated and parsed edges; if the " +
        "prompt does not say so the agent will query the two separately or miss one"
    );
    assert.ok(
      /Indication \(from record text\)/.test(PROMPT),
      "a parsed indication must be presented differently from a source-stated one"
    );
  });

  test("linkedConditionIds is taught as deprecated AND as unfollowable by a graph query", () => {
    // The term is cited in more than one place now (the query-JSON flattening
    // rule names it as the precedent for "a delimited literal is not a list"),
    // so anchor on the DEFINITIONAL occurrence rather than the first one. A
    // passing mention elsewhere must not be able to satisfy this test.
    const defined = PROMPT.indexOf("clinical:linkedConditionIds is DEPRECATED");
    assert.notStrictEqual(
      defined,
      -1,
      "clinical:linkedConditionIds must be marked deprecated where it is defined"
    );
    const block = PROMPT.slice(defined);
    assert.ok(
      /no graph query can follow/.test(block),
      "the reason matters: it is one delimited literal, so an agent that treats it as an edge " +
        "silently finds nothing"
    );
  });

  test("the taught linkedConditionIds split survives BOTH delimiters seen in the wild", () => {
    // The vocabulary comment says space-separated; the serializer that actually
    // writes the literal emits commas. A recipe that trusts either one alone
    // returns a single bogus id containing the whole string, and reports one
    // link where there are two.
    const recipe = PROMPT.match(/clinical:linkedConditionIds"\]\s*\|\s*(split\([^\n]*\))/);
    assert.ok(recipe, "the prompt must give a concrete split recipe, not just a warning");
    const filter = `.["clinical:linkedConditionIds"] | ${recipe![1]}`;
    for (const literal of [
      "3f2a-aaa 9c1b-bbb", // as the vocabulary comment describes it
      "3f2a-aaa,9c1b-bbb", // as the emitter actually writes it
      "3f2a-aaa, 9c1b-bbb", // and with a following space
    ]) {
      const ids = jq(filter, { "clinical:linkedConditionIds": literal }) as string[];
      assert.deepStrictEqual(
        ids,
        ["3f2a-aaa", "9c1b-bbb"],
        `the split recipe must recover 2 ids from ${JSON.stringify(literal)}`
      );
    }
    assert.ok(
      /DELIMITER IS NOT\s+RELIABLY DOCUMENTED/.test(PROMPT),
      "the prompt must say the delimiter is unreliable — an agent told only 'space-separated' " +
        "will write a whitespace split and silently mis-parse every real record"
    );
  });

  // ── clinical v1.15 procedure-name migration window ─────────────────────────

  test("procedures: the taught filter names procedures written under BOTH predicates", () => {
    const filter = filters.find((f) => f.includes(".dataTypes.procedures"))!;
    assert.ok(filter, "the prompt must teach a procedures query");
    const rows = jq(filter, BUCKET_FIXTURES.procedures) as Array<{ name: string | null }>;
    const names = rows.map((r) => r.name);
    assert.ok(
      names.includes("Appendectomy"),
      `the canonical clinical:procedureName record must be named; got ${JSON.stringify(names)}`
    );
    assert.ok(
      names.includes("Colonoscopy"),
      "the C-CDA import record names the procedure on health:procedureName; a filter reading " +
        `only the canonical spelling reports it as unnamed. got ${JSON.stringify(names)}`
    );
    assert.ok(!names.includes(null), `no procedure row may be unnamed; got ${JSON.stringify(names)}`);
  });

  test("procedures: the both-spellings fallback is load-bearing, not decoration", () => {
    // Prove the failure the prompt exists to prevent: each single-predicate
    // filter leaves one real procedure unnamed. If this ever stops holding, the
    // fixture has drifted and the test above has gone vacuous.
    for (const predicate of ["clinical:procedureName", "health:procedureName"]) {
      const rows = jq(
        `[.dataTypes.procedures.records[] | {name: .properties["${predicate}"]}]`,
        BUCKET_FIXTURES.procedures
      ) as Array<{ name: string | null }>;
      assert.ok(
        rows.some((r) => r.name === null),
        `a filter reading only ${predicate} must leave a real procedure unnamed`
      );
    }
  });

  test("the canonical procedure spelling is named as canonical, and the health: one as legacy", () => {
    const block = PROMPT.split("Procedure names:")[1]?.split("## Common Task Workflows")[0] ?? "";
    assert.ok(block.length > 0, "the prompt must carry the procedure-name migration-window rule");
    assert.ok(
      /clinical:procedureName\s+CANONICAL/.test(block),
      "clinical:procedureName is the only defined spelling and must be stated as canonical"
    );
    assert.ok(
      /Never WRITE the health: spelling/.test(block),
      "the health: spelling is accepted for reading only; an agent told merely that both exist " +
        "will emit the one that is being migrated out"
    );
    assert.ok(
      mentions("health:procedureName") && mentions("clinical:procedureName"),
      "both predicates must be named or a query written from the prompt misses half the pod"
    );
  });

  // ── core v3.5 source axes ──────────────────────────────────────────────────

  test("source axes: the taught filter groups on ORIGIN, uniting one organization across batches", () => {
    const filter = filters.find((f) => f.includes("core:sourceIdentity"))!;
    assert.ok(filter, "the prompt must teach a records-from-one-organization query");
    const groups = jq(filter, BUCKET_FIXTURES["lab-results"]) as Array<{
      origin: string;
      labels: Array<string | null>;
      records: number;
    }>;
    const meridian = groups.find((g) => g.origin === "org:meridian");
    assert.ok(meridian, `expected an org:meridian group; got ${JSON.stringify(groups)}`);
    assert.strictEqual(
      meridian!.records,
      2,
      "the FHIR-path and C-CDA-path records of one organization must land in ONE group even " +
        "though their ingestion batches and their display labels both differ"
    );
    assert.ok(
      meridian!.labels.length === 2,
      "the two display labels of that one organization must survive as labels, not be treated " +
        `as two organizations; got ${JSON.stringify(meridian!.labels)}`
    );
    assert.ok(
      groups.some((g) => g.origin === "origin unknown"),
      "a record with no cascade:sourceIdentity must be reported as origin unknown, never " +
        "silently folded into a neighbouring organization"
    );
  });

  test("source axes: grouping on the INGESTION batch instead would merge two organizations", () => {
    // The concrete harm the prompt warns about, demonstrated on the same fixture:
    // key on cascade:sourceSystem and one batch carries two different origins.
    const byBatch = jq(
      '[.dataTypes["lab-results"].records[] | {batch: .properties["core:sourceSystem"], ' +
        'origin: .properties["core:sourceIdentity"]}] | group_by(.batch) ' +
        "| map({batch: .[0].batch, origins: ([.[].origin] | unique | length)})",
      BUCKET_FIXTURES["lab-results"]
    ) as Array<{ batch: string; origins: number }>;
    assert.ok(
      byBatch.some((b) => b.origins > 1),
      "the fixture must contain a batch spanning more than one origin, or the warning that " +
        `cascade:sourceSystem is not a reconciliation key is untested here; got ${JSON.stringify(byBatch)}`
    );
  });

  test("the three source axes are taught with sourceSystem ruled out as an origin", () => {
    for (const term of ["core:sourceIdentity", "clinical:sourceEHR", "core:sourceSystem"]) {
      assert.ok(mentions(term), `source axis missing from the prompt: ${term}`);
    }
    const block = PROMPT.split("THE THREE SOURCE AXES")[1]?.split("\n  • ")[0] ?? "";
    assert.ok(block.length > 0, "the prompt must carry the three-axis rule");
    assert.ok(
      /NEVER an origin and NEVER a reconciliation key/.test(block),
      "cascade:sourceSystem is the INGESTION axis; if the prompt does not rule it out explicitly " +
        "an agent will reach for it, because it is the older and more familiar predicate"
    );
    for (const scheme of ["org:", "ns:", "transport:"]) {
      assert.ok(block.includes(scheme), `the ${scheme} value scheme must be taught`);
    }
    assert.ok(
      /origin unknown/.test(block),
      "two transport: values mean origin unknown and must not be read as a shared source"
    );
  });

  // ── core v3.6 data-absent reasons ──────────────────────────────────────────

  test("the prompt enumerates all 15 data-absent-reason codes, and no others", () => {
    const block = PROMPT.split(
      "15 codes of http://terminology.hl7.org/CodeSystem/data-absent-reason:"
    )[1]?.split("SCOPE:")[0];
    assert.ok(block, "the prompt must enumerate the data-absent-reason value set");
    const codes = block!
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => l.split(/\s{2,}/)[0]);
    assert.deepStrictEqual(
      [...codes].sort(),
      [
        "as-text",
        "asked-declined",
        "asked-unknown",
        "error",
        "masked",
        "negative-infinity",
        "not-a-number",
        "not-applicable",
        "not-asked",
        "not-performed",
        "not-permitted",
        "positive-infinity",
        "temp-unknown",
        "unknown",
        "unsupported",
      ],
      "the 15 codes of http://terminology.hl7.org/CodeSystem/data-absent-reason. A short list " +
        "makes the agent map a real code onto a neighbouring one; a long list invents codes " +
        "the shape rejects"
    );
  });

  test("an absent value with a reason is taught as an answer, never as no data", () => {
    const block = PROMPT.split("WHY A VALUE IS ABSENT")[1]?.split("\n  • ")[0] ?? "";
    assert.ok(block.length > 0, "the prompt must carry the data-absent-reason rule");
    assert.ok(
      /never report it as "no data",\s+"nothing found" or an empty\s+result/.test(block),
      "the whole point of the property is that the record is NOT an empty result; the prompt " +
        "must say so in those words or the agent reports a documented refusal as missing data"
    );
    assert.ok(
      /NullFlavor/.test(block) && /importer defect/.test(block),
      "a raw HL7 v3 NullFlavor code in this property is an importer defect, not a code to " +
        "interpret; without that the agent will helpfully decode UNK and hide the bug"
    );
  });

  test("vital signs: the taught filter surfaces valueless records WITH their distinct reasons", () => {
    const filter = filters.find((f) => f.includes("core:dataAbsentReason"))!;
    assert.ok(filter, "the prompt must teach a data-absent-reason query");
    const rows = jq(filter, BUCKET_FIXTURES["vital-signs"]) as Array<{
      type: string;
      value: string | null;
      absent: string | null;
    }>;
    assert.strictEqual(
      rows.length,
      2,
      `expected the 2 valueless vitals, got ${JSON.stringify(rows)}`
    );
    for (const row of rows) {
      assert.ok(
        row.absent !== null,
        `a valueless record came back with no reason: ${JSON.stringify(row)}. Reporting that ` +
          "row is reporting 'no data' for a record that explains itself"
      );
    }
    assert.deepStrictEqual(
      rows.map((r) => r.absent).sort(),
      ["asked-declined", "not-asked"],
      "the two reasons are different clinical facts and must not collapse into one"
    );
  });

  // ── health v2.7 / clinical v1.15 interpretationSourceCode ──────────────────

  test("interpretation: the taught filter returns the normalized code AND the source's own word", () => {
    const filter = filters.find((f) => f.includes("interpretationSourceCode"))!;
    assert.ok(filter, "the prompt must teach reading interpretationSourceCode alongside interpretation");
    const rows = jq(filter, BUCKET_FIXTURES["lab-results"]) as Array<{
      test: string | null;
      interpretation: string | null;
      sourceWord: string | null;
    }>;
    assert.strictEqual(rows.length, 4, "every lab record must survive the filter");
    for (const row of rows) {
      assert.ok(
        row.interpretation !== null,
        `an interpretation came back null: ${JSON.stringify(row)}. Reading one namespace only ` +
          "produces exactly this"
      );
    }
    // health: spelling, source code present.
    assert.ok(
      rows.some((r) => r.interpretation === "H" && r.sourceWord === "elevated"),
      `the health:-spelled pair (H, elevated) must both be read; got ${JSON.stringify(rows)}`
    );
    // clinical: spelling, source code present.
    assert.ok(
      rows.some((r) => r.interpretation === "ND" && r.sourceWord === "NOT DETECTED by local assay"),
      "the clinical:-spelled source code must be read too, and VERBATIM: it is deliberately " +
        `unconstrained, so no case folding and no normalization. got ${JSON.stringify(rows)}`
    );
    // No source code is the ordinary case, not an error.
    assert.ok(
      rows.some((r) => r.interpretation !== null && r.sourceWord === null),
      "a record whose source code was already ratified carries no interpretationSourceCode, " +
        "and that must read as ordinary rather than as missing data"
    );
  });

  test("the interpretation value set is taught as 74 values, and its three parts add up", () => {
    const block = PROMPT.split("THE SOURCE'S OWN WORD")[1]?.split("\n  • ")[0] ?? "";
    assert.ok(block.length > 0, "the prompt must carry the interpretationSourceCode rule");
    const total = block.match(/(\d+)-value set/);
    assert.ok(total, "the prompt must state the size of the bound value set");
    const parts = [
      Number(block.match(/(\d+) selectable HL7 v3 ObservationInterpretation codes/)?.[1]),
      Number(block.match(/ALL (\d+)\s+data-absent-reason codes/)?.[1]),
      Number(block.match(/(\d+) retained pre-v2\.6 words/)?.[1]),
    ];
    assert.ok(
      parts.every((n) => Number.isInteger(n)),
      `the prompt must break the value set into its three parts; parsed ${JSON.stringify(parts)}`
    );
    assert.strictEqual(
      parts.reduce((a, b) => a + b, 0),
      Number(total![1]),
      `the stated parts ${JSON.stringify(parts)} must sum to the stated total ${total![1]}`
    );
    assert.strictEqual(
      Number(total![1]),
      74,
      "health v2.7 / clinical v1.15 took the interpretation value set from 60 to 74"
    );
  });

  test("the retired claim that vital-sign interpretation is unconstrained is gone", () => {
    // It was true through clinical v1.14 and is false from v1.15. A stale note
    // here does not merely under-inform: it actively tells the agent to expect
    // free text where a value set now applies.
    assert.ok(
      !/Vital-sign clinical:interpretation is still\s+unconstrained/.test(PROMPT),
      "clinical v1.15 bound clinical:VitalSignShape's interpretation to the same value set the " +
        "lab shapes use; the prompt must not still say it is unconstrained"
    );
    assert.ok(
      mentions("clinical:interpretationSourceCode") && mentions("health:interpretationSourceCode"),
      "both spellings of the new property must be taught"
    );
  });

  // ── clinical v1.16 encounter participants ──────────────────────────────────

  test("participants: the taught filter recovers EVERY member of the care team, with roles", () => {
    const filter = filters.find((f) => f.includes("clinical:hasParticipant"))!;
    assert.ok(filter, "the prompt must teach a participant-traversal query");
    const rows = jq(filter, BUCKET_FIXTURES.encounters) as Array<{
      date: string;
      team: Array<{ name: string | null; role: string | null; specialty: string | null }>;
    }>;
    assert.strictEqual(
      rows.length,
      2,
      `the filter must return the 2 ENCOUNTERS, not the 5 bucket entries; got ${JSON.stringify(rows)}`
    );
    const all = rows.flatMap((r) => r.team);
    assert.strictEqual(
      all.length,
      3,
      "all three participations must be resolved. A filter that forgets to split the " +
        `", "-joined clinical:hasParticipant recovers only one per visit; got ${JSON.stringify(all)}`
    );
    for (const p of all) {
      assert.ok(p.name !== null, `a participant resolved to a null name: ${JSON.stringify(p)}`);
      assert.ok(p.role !== null, `a participant resolved with no role: ${JSON.stringify(p)}`);
    }
    // The referrer is the whole point: providerName never names them.
    assert.ok(
      all.some((p) => p.name === "Dr. Ben Ortiz" && p.role === "referrer"),
      "the referrer must be recovered; reading clinical:providerName alone returns only " +
        `the attender and cannot say which role it was. got ${JSON.stringify(all)}`
    );
    assert.ok(
      all.some((p) => p.name === "Dr. Alice Nguyen" && p.specialty === "Cardiology"),
      "participantSpecialty must be read where the source states it"
    );
  });

  test("participants: reading clinical:providerName instead loses two of the three, and every role", () => {
    // The regression the section exists to prevent, demonstrated on the same
    // fixture. If this ever stops holding the fixture has drifted and the test
    // above has gone vacuous.
    const summary = jq(
      '[.dataTypes.encounters.records[] | select(.type == "clinical:Encounter") ' +
        '| .properties["clinical:providerName"]]',
      BUCKET_FIXTURES.encounters
    ) as string[];
    assert.strictEqual(summary.length, 2, "one summary name per encounter");
    assert.ok(
      !summary.includes("Dr. Ben Ortiz"),
      "clinical:providerName must be shown NOT to surface the referrer — that is why a " +
        "who-was-involved question has to traverse participants"
    );
  });

  test("participants: the prompt states providerName is retained but insufficient", () => {
    for (const term of [
      "clinical:hasParticipant",
      "clinical:EncounterParticipant",
      "clinical:participantName",
      "clinical:participantRole",
      "clinical:participantRoleCode",
      "clinical:participantSpecialty",
    ]) {
      assert.ok(mentions(term), `clinical v1.16 participant term missing: ${term}`);
    }
    assert.ok(
      /must traverse the participants/i.test(PROMPT),
      "the prompt must say that a who-was-involved question traverses participants; without " +
        "that instruction a model reads the single providerName slot and answers confidently"
    );
  });

  // ── clinical v1.16 the two document statuses ───────────────────────────────

  test("documents: the taught filter reads CURRENCY from documentReferenceStatus, not status", () => {
    const filter = filters.find((f) => f.includes("clinical:documentReferenceStatus"))!;
    assert.ok(filter, "the prompt must teach a document-currency query");
    const rows = jq(filter, BUCKET_FIXTURES.documents) as Array<{
      title: string;
      currency: string;
      contentStatus: string;
    }>;
    // document:1 is status "final" but documentReferenceStatus "superseded":
    // a filter reading clinical:status keeps it, which is the wrong answer.
    assert.ok(
      !rows.some((r) => r.title === "Cardiology consultation note"),
      "a document whose REFERENCE is superseded must be excluded even though its content " +
        `status is "final"; got ${JSON.stringify(rows)}`
    );
    // document:2 is status "amended" but documentReferenceStatus "current":
    // treating "amended" as a supersession hides the live document.
    assert.ok(
      rows.some((r) => r.title === "Discharge summary" && r.contentStatus === "amended"),
      "an AMENDED document whose reference is current must be KEPT — amended means the " +
        `content was corrected, not that the reference was replaced; got ${JSON.stringify(rows)}`
    );
    assert.strictEqual(rows.length, 1, `expected exactly the 1 current document, got ${JSON.stringify(rows)}`);
  });

  test("documents: the two statuses are taught as independent, with the shared error code called out", () => {
    const block = PROMPT.split("DOCUMENTS CARRY TWO STATUSES")[1]?.split("\n      AUTHORSHIP")[0] ?? "";
    assert.ok(block.length > 0, "the prompt must carry the two-status rule");
    assert.ok(
      /clinical:documentReferenceStatus/.test(block) && /clinical:status/.test(block),
      "both predicates must be named in the same block or the distinction is unusable"
    );
    for (const value of ["current", "superseded", "entered-in-error"]) {
      assert.ok(block.includes(value), `the documentReferenceStatus value set must list ${value}`);
    }
    assert.ok(
      /amended/.test(block),
      'the prompt must address "amended", the value most likely to be misread as a supersession'
    );
    assert.ok(
      /BOTH value sets/.test(block),
      '"entered-in-error" is in both value sets and means different things in each; the ' +
        "prompt must say so, or the agent will report one as the other"
    );
  });

  test("documents: authorship and attestation are taught as different facts", () => {
    assert.ok(
      mentions("clinical:documentAuthorName") && mentions("clinical:authenticatorName"),
      "both v1.16 attribution predicates must be taught"
    );
    const rows = jq(
      "[.dataTypes.documents.records[] | {authors: .properties[\"clinical:documentAuthorName\"], " +
        'signer: .properties["clinical:authenticatorName"]}]',
      BUCKET_FIXTURES.documents
    ) as Array<{ authors: string; signer: string | null }>;
    // The signer wrote none of it: reporting the author as the signer asserts
    // something the source did not say.
    const signed = rows.find((r) => r.signer !== null)!;
    assert.ok(
      !signed.authors.includes(signed.signer!),
      "the fixture's authenticator must NOT be among that document's authors, or the " +
        "wrote-it/signed-it distinction is untested here"
    );
  });

  // ── clinical v1.16 identifiers ─────────────────────────────────────────────

  test("the two identifier spaces are taught as non-joining", () => {
    assert.ok(
      mentions("clinical:businessIdentifier") && mentions("clinical:sourceRecordId"),
      "both identifier predicates must be named"
    );
    const block = PROMPT.split("TWO IDENTIFIERS THAT DO NOT JOIN")[1]?.split("\n      DOCUMENTS")[0] ?? "";
    assert.ok(block.length > 0, "the prompt must carry the identifier rule");
    assert.ok(
      /token form/.test(block) && block.includes("{system}|{value}"),
      "the FHIR token form is what makes a business identifier comparable across transports; " +
        "the prompt must give it"
    );
    assert.ok(
      /logical id/i.test(block),
      "sourceRecordId must be identified as the server-assigned logical id, or an agent will " +
        "reach for it as a cross-system key"
    );
  });

  // ── coverage v1.5 ──────────────────────────────────────────────────────────

  test("coverage: the taught filter reports plan status, and absent reads as not stated", () => {
    const filter = filters.find((f) => f.includes("coverage:status"))!;
    assert.ok(filter, "the prompt must teach a coverage-status query");
    const rows = jq(filter, BUCKET_FIXTURES.insurance) as Array<{ plan: string; status: string }>;
    assert.strictEqual(rows.length, 3, "every plan must be reported");
    assert.ok(
      rows.some((r) => r.plan === "Meridian PPO Gold" && r.status === "cancelled"),
      "a cancelled plan must be reported as cancelled — reading it as active is a wrong " +
        `answer to "am I covered", not a missing one; got ${JSON.stringify(rows)}`
    );
    assert.ok(
      rows.some((r) => r.plan === "Legacy Dental" && r.status === "not stated"),
      "a pre-v1.5 record carries no status, and that must surface as 'not stated' rather " +
        `than defaulting to active; got ${JSON.stringify(rows)}`
    );
  });

  // ── the three query-JSON flattening losses ─────────────────────────────────

  test("core-vocabulary filters read the core: prefix the CLI actually emits", () => {
    // cascade-cli binds BOTH `core:` and `cascade:` to the core namespace and
    // `shortenIRI` resolves `core:` first, so every core property arrives as
    // core:*. A filter naming only cascade:* returns null on every real record.
    const coreReaders = filters.filter((f) => /"cascade:[a-zA-Z]+"/.test(f));
    for (const filter of coreReaders) {
      const props = [...filter.matchAll(/"cascade:([a-zA-Z]+)"/g)].map((m) => m[1]);
      for (const prop of props) {
        assert.ok(
          filter.includes(`"core:${prop}"`),
          `a filter reads .properties["cascade:${prop}"] without a "core:${prop}" alternative. ` +
            "The CLI emits core:, so this returns null on every record and reports stated " +
            "data as absent"
        );
      }
    }
    assert.ok(
      /NEVER cascade:/.test(PROMPT),
      "the prompt must state the core:/cascade: rule explicitly"
    );
  });

  test("the sub-node bucket-count inflation is taught, and the taught count filter is right", () => {
    const block = PROMPT.split("Sub-nodes share a bucket")[1]?.split("## Common Task Workflows")[0] ?? "";
    assert.ok(block.length > 0, "the prompt must carry the sub-node rule");
    const filter = filters.find((f) => f.includes('select(.type == "clinical:Encounter")'))!;
    assert.ok(filter, "the prompt must teach how to count visits without counting participants");
    const n = jq(filter, BUCKET_FIXTURES.encounters) as number;
    assert.strictEqual(
      n,
      2,
      "the taught count must return the 2 VISITS. The bucket holds 5 entries, so " +
        "`records | length` answers 5 — the inflation this rule exists to prevent"
    );
    assert.strictEqual(
      (BUCKET_FIXTURES.encounters as { dataTypes: { encounters: { count: number } } }).dataTypes
        .encounters.count,
      5,
      "the fixture must reproduce the inflated bucket count, or the rule is untested here"
    );
  });

  test("the ', ' join is taught as splittable for IRIs and NOT for free text", () => {
    const block = PROMPT.split("JOINED INTO ONE STRING")[1]?.split("### 3.")[0] ?? "";
    assert.ok(block.length > 0, "the prompt must carry the multi-value join rule");
    assert.ok(
      /SPLITTING IS SAFE ONLY FOR IRIs AND CODES/.test(block),
      "the prompt must say which values may be split; an unqualified 'split on comma' " +
        "shatters a free-text value that legitimately contains one"
    );
    assert.ok(
      /Chest pain, unspecified/.test(block),
      "the prompt must give the concrete counter-example of a single reason containing a comma"
    );
    // And prove it: the taught encounter filter must NOT split the reason.
    const filter = filters.find((f) => f.includes("clinical:hasParticipant"))!;
    const rows = jq(filter, BUCKET_FIXTURES.encounters) as Array<{ reason: string | null }>;
    assert.ok(
      rows.some((r) => r.reason === "Chest pain, Medication review"),
      "the taught filter must pass the joined reason through intact rather than splitting it"
    );
  });

  test("core v3.7 attachments are taught WITH the fact that no producer writes them yet", () => {
    for (const term of [
      "cascade:Attachment",
      "cascade:hasAttachment",
      "cascade:attachmentPath",
      "cascade:attachmentMediaType",
    ]) {
      assert.ok(mentions(term), `core v3.7 attachment term missing: ${term}`);
    }
    const block = PROMPT.split("POD ATTACHMENTS")[1]?.split("\n  • Coverage v1.5")[0] ?? "";
    assert.ok(block.length > 0, "the prompt must carry the attachment rule");
    assert.ok(
      /NO PRODUCER WRITES THESE YET/.test(block),
      "cascade-cli 0.21.0 emits no cascade:Attachment on any path. Without saying so the " +
        "agent hunts for attachments that cannot exist and reports their absence as a gap"
    );
    // The predicates a DocumentReference import actually writes today.
    for (const actual of ["clinical:contentType", "clinical:documentUrl"]) {
      assert.ok(block.includes(actual), `the current flattened spelling ${actual} must be given`);
    }
    // And the taught traversal must still work on a pod that does carry them.
    const filter = filters.find((f) => f.includes("core:hasAttachment"))!;
    const rows = jq(filter, BUCKET_FIXTURES["lab-reports"]) as Array<{
      report: string | null;
      attachments: Array<{ path: string | null; type: string | null }>;
    }>;
    assert.strictEqual(rows.length, 1, "the attachment sub-node must not be reported as a report");
    assert.strictEqual(rows[0].attachments.length, 1, "the attachment must be resolved");
    assert.strictEqual(rows[0].attachments[0].type, "application/pdf");
  });

  // ── drift guard ────────────────────────────────────────────────────────────

  test("VOCAB_VERSIONS and the prompt's namespace block state the same versions", () => {
    const file = readFileSync(path.join(REPO_ROOT, "VOCAB_VERSIONS"), "utf8");
    const declared: Record<string, string> = {};
    for (const line of file.split("\n")) {
      const m = line.match(/^([a-z]+)=([0-9.]+)$/);
      if (m) declared[m[1]] = m[2];
    }
    assert.deepStrictEqual(
      { core: declared.core, health: declared.health, clinical: declared.clinical },
      { core: "3.8", health: "2.8", clinical: "1.16" },
      "VOCAB_VERSIONS must record the ratified versions this prompt teaches"
    );
    assert.strictEqual(
      declared.coverage,
      "1.5",
      "coverage v1.5 added coverage:status, which the prompt now teaches"
    );
    for (const [ns, version] of Object.entries(declared)) {
      const line = PROMPT.split("\n").find((l) => l.trim().startsWith(`${ns}:`) && l.includes("ns.cascadeprotocol.org"));
      if (!line) continue; // coverage/checkup/pots rows the prompt may abbreviate
      assert.ok(
        line.includes(`v${version}`),
        `prompt says "${line.trim()}" but VOCAB_VERSIONS says ${ns}=${version} — a half-done ` +
          "sync leaves the agent quoting a version it does not implement"
      );
    }
  });

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
