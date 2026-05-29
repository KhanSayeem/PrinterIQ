import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  conversations,
  enrichments,
  leads,
  outreachSends,
  payments,
  qualifications,
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
};

const drizzleTables = {
  leads,
  enrichments,
  qualifications,
  conversations,
  outreach_sends: outreachSends,
  payments,
};

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
});
