import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as dbSchema from "./schema";
import {
  conversations,
  enrichments,
  leads,
  outreachSends,
  payments,
  qualifications,
  websitePreviews,
} from "./schema";

const schemaSql = readFileSync(resolve(process.cwd(), "../../database/schema.sql"), "utf8");

const requiredColumns = {
  leads: [
    "id",
    "tenant_id",
    "first_name",
    "last_name",
    "email",
    "phone",
    "business_name",
    "city",
    "state",
    "website_url",
    "linkedin_url",
    "vertical",
    "status",
    "is_deleted",
    "created_at",
    "updated_at",
  ],
  enrichments: ["id", "lead_id", "tenant_id", "cms_detected", "weaknesses", "analysed_at"],
  qualifications: [
    "id",
    "lead_id",
    "tenant_id",
    "score",
    "rationale",
    "top_weakness",
    "subject_line",
    "personalised_opener",
    "followup_1",
    "followup_2",
    "prompt_version",
    "qualified_at",
  ],
  conversations: [
    "id",
    "lead_id",
    "tenant_id",
    "direction",
    "channel",
    "body",
    "instantly_email_id",
    "instantly_account_id",
    "intent",
    "operator_override",
    "created_at",
  ],
  outreach_sends: [
    "id",
    "lead_id",
    "tenant_id",
    "channel",
    "step",
    "template_ref",
    "sent_at",
    "delivered",
    "opened",
    "replied",
    "created_at",
  ],
  payments: [
    "id",
    "lead_id",
    "tenant_id",
    "stripe_session_id",
    "amount_aud",
    "status",
    "paid_at",
    "created_at",
  ],
  website_previews: [
    "id",
    "lead_id",
    "tenant_id",
    "template_used",
    "preview_slug",
    "preview_url",
    "personalisation_data",
    "prompt_version",
    "cost_usd",
    "generated_at",
  ],
};

const drizzleTables = {
  leads,
  enrichments,
  qualifications,
  conversations,
  outreach_sends: outreachSends,
  payments,
  website_previews: websitePreviews,
};

const prospectStagingColumns = {
  discovery_runs: [
    "id",
    "tenant_id",
    "source",
    "source_request_id",
    "query_spec",
    "status",
    "shadow_mode",
    "discovered_count",
    "usable_count",
    "route_a_count",
    "route_b_count",
    "verified_contact_count",
    "provider_usage",
    "failure_code",
    "failure_detail",
    "submitted_at",
    "results_received_at",
    "review_ready_at",
    "created_at",
    "updated_at",
  ],
  business_prospects: [
    "id",
    "tenant_id",
    "discovery_run_id",
    "source",
    "source_business_id",
    "business_name",
    "normalized_name",
    "primary_category",
    "additional_categories",
    "phone",
    "normalized_phone",
    "full_address",
    "locality",
    "state",
    "postcode",
    "latitude",
    "longitude",
    "business_status",
    "rating",
    "review_count",
    "google_profile_url",
    "source_website_url",
    "normalized_domain",
    "website_ownership",
    "duplicate_evidence",
    "is_franchise",
    "matched_location_count",
    "route",
    "outcome_reason",
    "status",
    "lead_id",
    "validation_sample",
    "validation_cohort",
    "source_payload",
    "source_payload_expires_at",
    "created_at",
    "updated_at",
  ],
  prospect_assessments: [
    "id",
    "tenant_id",
    "discovery_run_id",
    "prospect_id",
    "assessment_type",
    "assessment_version",
    "eligible",
    "computed_route",
    "total_score",
    "category_scores",
    "rule_evidence",
    "forced_route_reason",
    "reviewer_id",
    "idempotency_key",
    "review_decision",
    "corrected_route",
    "review_note",
    "ai_summary",
    "prompt_version",
    "created_at",
  ],
  prospect_contacts: [
    "id",
    "tenant_id",
    "prospect_id",
    "provider",
    "input_fingerprint",
    "provider_request_id",
    "provider_organization_id",
    "provider_person_id",
    "person_name",
    "person_title",
    "email",
    "provider_email_status",
    "credits_consumed",
    "status",
    "match_evidence",
    "provider_payload",
    "provider_payload_expires_at",
    "created_at",
    "updated_at",
  ],
};

const prospectStagingExports = {
  discovery_runs: "discoveryRuns",
  business_prospects: "businessProspects",
  prospect_assessments: "prospectAssessments",
  prospect_contacts: "prospectContacts",
} as const;

const prospectCheckNames = {
  discovery_runs: [
    "discovery_runs_source_check",
    "discovery_runs_status_check",
    "discovery_runs_shadow_mode_check",
    "discovery_runs_discovered_count_check",
    "discovery_runs_usable_count_check",
    "discovery_runs_route_a_count_check",
    "discovery_runs_route_b_count_check",
    "discovery_runs_verified_contact_count_check",
  ],
  business_prospects: [
    "business_prospects_source_check",
    "business_prospects_review_count_check",
    "business_prospects_website_ownership_check",
    "business_prospects_matched_location_count_check",
    "business_prospects_route_check",
    "business_prospects_status_check",
    "business_prospects_validation_cohort_check",
  ],
  prospect_assessments: [
    "prospect_assessments_assessment_type_check",
    "prospect_assessments_computed_route_check",
    "prospect_assessments_total_score_check",
    "prospect_assessments_review_decision_check",
    "prospect_assessments_corrected_route_check",
    "prospect_assessment_shape_check",
  ],
  prospect_contacts: [
    "prospect_contacts_provider_check",
    "prospect_contacts_credits_consumed_check",
    "prospect_contacts_status_check",
  ],
} as const;

describe("dashboard Drizzle schema", () => {
  for (const [tableName, columns] of Object.entries(requiredColumns)) {
    it(`matches required ${tableName} columns from database/schema.sql`, () => {
      const createTableBlock = schemaSql.match(new RegExp(`CREATE TABLE ${tableName} \\(([^;]+)\\);`, "s"));
      expect(createTableBlock?.[1]).toBeTruthy();

      const drizzleColumnNames = Object.values(
        getTableColumns(drizzleTables[tableName as keyof typeof drizzleTables]),
      ).map((column) => column.name);

      for (const column of columns) {
        expect(createTableBlock?.[1]).toContain(column);
        expect(drizzleColumnNames).toContain(column);
      }
    });
  }

  for (const [tableName, columns] of Object.entries(prospectStagingColumns)) {
    it(`maps every ${tableName} column from database/schema.sql`, () => {
      const exportName = prospectStagingExports[tableName as keyof typeof prospectStagingExports];
      const table = (dbSchema as Record<string, unknown>)[exportName];

      expect(table, `missing ${exportName} export`).toBeTruthy();

      const createTableBlock = schemaSql.match(new RegExp(`CREATE TABLE ${tableName} \\(([^;]+)\\);`, "s"));
      expect(createTableBlock?.[1]).toBeTruthy();

      const drizzleColumnNames = Object.values(getTableColumns(table as Parameters<typeof getTableColumns>[0])).map(
        (column) => column.name,
      );

      expect(drizzleColumnNames).toEqual(expect.arrayContaining(columns));
      expect(drizzleColumnNames).toHaveLength(columns.length);
    });

    it(`maps every ${tableName} validation constraint`, () => {
      const exportName = prospectStagingExports[tableName as keyof typeof prospectStagingExports];
      const table = (dbSchema as Record<string, unknown>)[exportName];
      const checkNames = getTableConfig(table as Parameters<typeof getTableConfig>[0]).checks.map(
        (constraint) => constraint.name,
      );

      const expectedCheckNames = [
        ...prospectCheckNames[tableName as keyof typeof prospectCheckNames],
      ];
      expect(checkNames).toEqual(expect.arrayContaining(expectedCheckNames));
      expect(checkNames).toHaveLength(
        prospectCheckNames[tableName as keyof typeof prospectCheckNames].length,
      );
    });
  }

  it("maps tenant foreign keys, replay identities, and the active-run predicate", () => {
    const runConfig = getTableConfig(dbSchema.discoveryRuns);
    const businessConfig = getTableConfig(dbSchema.businessProspects);
    const assessmentConfig = getTableConfig(dbSchema.prospectAssessments);
    const contactConfig = getTableConfig(dbSchema.prospectContacts);

    expect(runConfig.uniqueConstraints.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "discovery_runs_tenant_id_id_key",
        "discovery_runs_source_request_key",
      ]),
    );
    expect(businessConfig.uniqueConstraints.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "business_prospects_tenant_id_id_key",
        "business_prospects_tenant_run_id_key",
        "business_prospects_source_identity_key",
      ]),
    );
    expect(
      runConfig.uniqueConstraints
        .find((constraint) => constraint.name === "discovery_runs_source_request_key")
        ?.columns.map((column) => column.name),
    ).toEqual(["tenant_id", "source", "source_request_id"]);
    expect(
      businessConfig.uniqueConstraints
        .find((constraint) => constraint.name === "business_prospects_source_identity_key")
        ?.columns.map((column) => column.name),
    ).toEqual(["tenant_id", "discovery_run_id", "source", "source_business_id"]);
    expect(
      contactConfig.uniqueConstraints
        .find((constraint) => constraint.name === "prospect_contacts_input_key")
        ?.columns.map((column) => column.name),
    ).toEqual(["tenant_id", "prospect_id", "provider", "input_fingerprint"]);

    const assessmentReplayIndexes = Object.fromEntries(
      assessmentConfig.indexes.map((index) => [
        index.config.name,
        index.config.columns.map((column) => (column as { name?: string }).name),
      ]),
    );
    expect(assessmentReplayIndexes.prospect_automated_assessment_version_idx).toEqual([
      "tenant_id",
      "prospect_id",
      "assessment_version",
    ]);
    expect(assessmentReplayIndexes.prospect_manual_assessment_idempotency_idx).toEqual([
      "tenant_id",
      "prospect_id",
      "idempotency_key",
    ]);
    for (const [indexName, assessmentType] of [
      ["prospect_automated_assessment_version_idx", "automated"],
      ["prospect_manual_assessment_idempotency_idx", "manual_review"],
    ] as const) {
      const replayIndex = assessmentConfig.indexes.find(
        (index) => index.config.name === indexName,
      );
      expect(replayIndex?.config.unique).toBe(true);
      expect(new PgDialect().sqlToQuery(replayIndex!.config.where!).sql).toBe(
        `"prospect_assessments"."assessment_type" = '${assessmentType}'`,
      );
    }
    expect(
      [...businessConfig.foreignKeys, ...assessmentConfig.foreignKeys, ...contactConfig.foreignKeys]
        .map((foreignKey) => foreignKey.getName()),
    ).toEqual(
      expect.arrayContaining([
        "fk_business_prospects_run_tenant",
        "fk_business_prospects_lead_tenant",
        "fk_prospect_assessments_run_tenant",
        "fk_prospect_assessments_prospect_run_tenant",
        "fk_prospect_contacts_prospect_tenant",
      ]),
    );
    const tenantForeignKeyColumns = Object.fromEntries(
      [...businessConfig.foreignKeys, ...assessmentConfig.foreignKeys, ...contactConfig.foreignKeys]
        .map((foreignKey) => {
          const reference = foreignKey.reference();
          return [
            foreignKey.getName(),
            [
              reference.columns.map((column) => column.name),
              reference.foreignColumns.map((column) => column.name),
            ],
          ];
        }),
    );
    expect(tenantForeignKeyColumns.fk_business_prospects_run_tenant).toEqual([
      ["tenant_id", "discovery_run_id"],
      ["tenant_id", "id"],
    ]);
    expect(tenantForeignKeyColumns.fk_business_prospects_lead_tenant).toEqual([
      ["tenant_id", "lead_id"],
      ["tenant_id", "id"],
    ]);
    expect(tenantForeignKeyColumns.fk_prospect_assessments_run_tenant).toEqual([
      ["tenant_id", "discovery_run_id"],
      ["tenant_id", "id"],
    ]);
    expect(tenantForeignKeyColumns.fk_prospect_assessments_prospect_run_tenant).toEqual([
      ["tenant_id", "discovery_run_id", "prospect_id"],
      ["tenant_id", "discovery_run_id", "id"],
    ]);
    expect(tenantForeignKeyColumns.fk_prospect_contacts_prospect_tenant).toEqual([
      ["tenant_id", "prospect_id"],
      ["tenant_id", "id"],
    ]);

    const activeRunIndex = runConfig.indexes.find(
      (index) => index.config.name === "discovery_runs_one_active_per_tenant_idx",
    );
    expect(activeRunIndex?.config.unique).toBe(true);
    expect(
      activeRunIndex?.config.columns.map((column) => (column as { name?: string }).name),
    ).toEqual(["tenant_id"]);
    const predicateSql = new PgDialect().sqlToQuery(activeRunIndex!.config.where!).sql;
    expect(predicateSql).toContain("status");
    const activeStatuses = [...predicateSql.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    expect(activeStatuses).toEqual(["created", "submitted", "polling", "persisted", "processing"]);
  });
});
