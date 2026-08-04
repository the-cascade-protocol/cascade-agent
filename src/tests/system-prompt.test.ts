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
      "cascade:dataProvenance": "cascade:EHRVerified",
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
      "cascade:dataProvenance": "cascade:EHRVerified",
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

const LAB_RESULTS: Rec[] = [
  {
    id: "urn:cascade:labresult:import-1",
    type: "health:LabResultRecord",
    properties: {
      "health:testName": "Hemoglobin A1c",
      "health:resultValue": "7.1",
      "health:resultUnit": "%",
      "health:performedDate": "2026-03-01",
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
  medications: envelope("medications", MEDICATIONS),
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
    const block = PROMPT.split("clinical:linkedConditionIds")[1] ?? "";
    assert.ok(block.length > 0, "clinical:linkedConditionIds must be addressed");
    assert.ok(/DEPRECATED/.test(block), "it must be marked deprecated");
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
      { core: "3.4", health: "2.5", clinical: "1.13" },
      "VOCAB_VERSIONS must record the ratified versions this prompt teaches"
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
