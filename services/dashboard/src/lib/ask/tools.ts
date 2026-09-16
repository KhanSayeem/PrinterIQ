import "server-only";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { InstantlyHttpClient } from "@/clients/instantly";
import {
  getLeadDetail,
  getLeadFilterCounts,
  getLeadListPage,
  getPipelineAnalytics,
  getReplyInboxFilterCounts,
  getReplyInboxPage,
  getReplyIngestSignal,
  getRevenueAnalytics,
  getTodaySoFarSummary,
  normalizeRevenuePeriod,
} from "@/db/queries";
import { describeReplyIngestHealth } from "@/lib/reply-ingest-health";
import { REPLY_INBOX_FILTERS, type ReplyInboxFilter } from "@/lib/reply-inbox-params";
import { loadSendsToDate } from "@/lib/sends-to-date";
import { loadTodayInstantlySendTotals } from "@/lib/today-sends";
import { readInstantlyCampaignTargets } from "@/lib/instantly-campaigns";

import { askLeadPath } from "./dashboard-routes";
import { loadDeliverabilitySnapshot } from "./deliverability-snapshot";
import {
  HEALTH_CHECKS,
  HEALTH_COMMAND_TIMEOUT_MS,
  healthCheckNames,
  resolveHealthCheck,
  truncateOutput,
} from "./health-commands";
import { ASK_SQL_ROW_LIMIT, applyRowLimit, assertReadOnlySql, readOnlyDatabaseUrl } from "./readonly-sql";

/**
 * Everything the ask panel can read.
 *
 * Deliberately wide, because the question is never known in advance. Every
 * tool here is a read: the toolbox holds no tool that sends, pauses, writes or
 * deletes, so a wrong answer costs a wrong answer and nothing else.
 *
 * Each tool wraps a path the dashboard already renders, so the panel and the
 * page cannot drift into two different numbers. The one exception is
 * `sql_query`, the escape hatch for questions no fixed tool covers, and it is
 * guarded separately in readonly-sql.ts.
 */

const execFileAsync = promisify(execFile);

/** A JSON Schema object, as the Messages API expects it. */
export type AskToolSchema = {
  readonly type: "object";
  readonly properties: Record<string, unknown>;
  readonly required?: readonly string[];
  readonly additionalProperties: false;
};

export type AskToolContext = {
  readonly tenantId: string;
};

export type AskTool = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: AskToolSchema;
  readonly run: (input: Record<string, unknown>, context: AskToolContext) => Promise<unknown>;
};

const NO_INPUT: AskToolSchema = { type: "object", properties: {}, additionalProperties: false };

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`"${key}" is required and must be a non-empty string.`);
  }
  return value.trim();
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`"${key}" must be a string.`);
  }
  return value.trim();
}

function optionalNumber(
  input: Record<string, unknown>,
  key: string,
  { min, max }: { min: number; max: number },
): number | undefined {
  const value = input[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`"${key}" must be a number.`);
  }
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

export function buildAskTools(): readonly AskTool[] {
  return [
    {
      name: "sends_today",
      description:
        "How many emails went out so far today, counted for the Sydney sending day, plus today's bounces, replies and unsubscribes. Use this for any question about today's sending. Instantly's own daily analytics are bucketed by UTC, which splits an Australian sending day in two, so this figure is counted email by email instead.",
      inputSchema: NO_INPUT,
      run: async (_input, context) => {
        /**
         * The summary is built from the send totals, not beside them, so the
         * bounce and unsubscribe rates are measured against the same number of
         * sends the answer quotes.
         */
        const sendTotals = await loadTodayInstantlySendTotals();
        const summary = await getTodaySoFarSummary({ tenantId: context.tenantId, sendTotals });
        return { instantlySends: sendTotals, dashboardCounts: summary };
      },
    },
    {
      name: "sends_to_date",
      description:
        "Total sent, delivered and bounced since launch for the configured campaigns. Use this for lifetime sending totals rather than today's.",
      inputSchema: NO_INPUT,
      run: async () => loadSendsToDate(),
    },
    {
      name: "sending_accounts",
      description:
        "Mailbox by mailbox health: account status, warmup, sent today against daily limit, sends and bounces in the last 30 days, bounce rate, and every threshold breach. Use this for questions about deliverability, bounce rate, warmup or capacity.",
      inputSchema: NO_INPUT,
      run: async () => loadDeliverabilitySnapshot(),
    },
    {
      name: "leads_search",
      description:
        "Search the lead list with the same filters as the /leads page. Returns one page of leads with their status, score, state and trade type.",
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            description:
              "Pipeline status filter, for example qualified, contacted, replied, paid, archived.",
          },
          state: { type: "string", description: "Australian state code, for example VIC or NSW." },
          tradeType: { type: "string", description: "Trade type, for example plumber." },
          search: { type: "string", description: "Free text match on business name or email." },
          scoreMin: { type: "number", description: "Lowest qualification score to include." },
          scoreMax: { type: "number", description: "Highest qualification score to include." },
          unsubscribed: { type: "boolean", description: "True to show only unsubscribed leads." },
          page: { type: "number", description: "1 based page number." },
          pageSize: { type: "number", description: "Rows per page, up to 50." },
        },
        additionalProperties: false,
      },
      run: async (input, context) =>
        getLeadListPage({
          tenantId: context.tenantId,
          status: optionalString(input, "status"),
          state: optionalString(input, "state"),
          tradeType: optionalString(input, "tradeType"),
          search: optionalString(input, "search"),
          scoreMin: optionalNumber(input, "scoreMin", { min: 0, max: 100 }),
          scoreMax: optionalNumber(input, "scoreMax", { min: 0, max: 100 }),
          unsubscribed: typeof input.unsubscribed === "boolean" ? input.unsubscribed : undefined,
          page: optionalNumber(input, "page", { min: 1, max: 1_000 }),
          pageSize: optionalNumber(input, "pageSize", { min: 1, max: 50 }) ?? 20,
        }),
    },
    {
      name: "lead_counts",
      description:
        "How many leads sit in each bucket: all, qualified, contacted, replied, paid, archived, unsubscribed. Use this before searching, to see the shape of the list.",
      inputSchema: NO_INPUT,
      run: async (_input, context) => getLeadFilterCounts({ tenantId: context.tenantId }),
    },
    {
      name: "lead_detail",
      description:
        "Everything recorded about one lead: contact fields, score, status history, the whole conversation thread, preview and payment, plus the dashboard path of that lead's page so the operator can be pointed at it. Needs the lead id, which leads_search returns.",
      inputSchema: {
        type: "object",
        properties: { leadId: { type: "string", description: "The lead's uuid." } },
        required: ["leadId"],
        additionalProperties: false,
      },
      run: async (input, context) => {
        const leadId = requiredString(input, "leadId");
        const lead = await getLeadDetail({ tenantId: context.tenantId, leadId });

        /** The path is returned with the record so the answer can say where to look. */
        return { dashboardPath: askLeadPath(leadId), lead };
      },
    },
    {
      name: "replies_recent",
      description:
        "The reply inbox, newest first, with the classified intent, confidence and what the agent did. Use this to answer what has come in and what is waiting on a human.",
      inputSchema: {
        type: "object",
        properties: {
          filter: {
            type: "string",
            enum: [...REPLY_INBOX_FILTERS],
            description: "Which replies to show. needs_attention is the human queue.",
          },
          page: { type: "number", description: "1 based page number." },
          pageSize: { type: "number", description: "Rows per page, up to 50." },
        },
        additionalProperties: false,
      },
      run: async (input, context) => {
        const filter = optionalString(input, "filter");
        return getReplyInboxPage({
          tenantId: context.tenantId,
          filter: REPLY_INBOX_FILTERS.includes(filter as ReplyInboxFilter)
            ? (filter as ReplyInboxFilter)
            : undefined,
          page: optionalNumber(input, "page", { min: 1, max: 1_000 }),
          pageSize: optionalNumber(input, "pageSize", { min: 1, max: 50 }) ?? 20,
        });
      },
    },
    {
      name: "reply_counts",
      description: "How many replies sit under each inbox filter, including the needs attention queue.",
      inputSchema: NO_INPUT,
      run: async (_input, context) => getReplyInboxFilterCounts({ tenantId: context.tenantId }),
    },
    {
      name: "reply_ingest_health",
      description:
        "Whether inbound replies are still arriving. Returns the last inbound reply time and a verdict, so a quiet inbox can be told apart from a broken webhook. Use this whenever the answer would otherwise be a zero reply count.",
      inputSchema: NO_INPUT,
      run: async (_input, context) => {
        const signal = await getReplyIngestSignal({ tenantId: context.tenantId });
        return { signal, health: describeReplyIngestHealth(signal) };
      },
    },
    {
      name: "pipeline_funnel",
      description:
        "The funnel: imported, enriched, scored, qualified, contacted, replied, paid, with the conversion rate between stages.",
      inputSchema: NO_INPUT,
      run: async (_input, context) => getPipelineAnalytics({ tenantId: context.tenantId }),
    },
    {
      name: "revenue",
      description: "Money in for a period: today, this week or this month, with the payments behind it.",
      inputSchema: {
        type: "object",
        properties: {
          period: { type: "string", enum: ["today", "week", "month"], description: "Defaults to today." },
        },
        additionalProperties: false,
      },
      run: async (input, context) =>
        getRevenueAnalytics({
          tenantId: context.tenantId,
          period: normalizeRevenuePeriod(optionalString(input, "period")),
        }),
    },
    {
      name: "instantly_campaigns",
      description:
        "The configured Instantly campaigns with their live status and totals. Status codes are 1 active, 2 paused, 3 completed. Use this to answer whether sending is switched on.",
      inputSchema: NO_INPUT,
      run: async () => {
        const targets = readInstantlyCampaignTargets();
        if (targets.length === 0) {
          return {
            available: false,
            reason: "No Instantly campaign is configured for this dashboard.",
          };
        }

        const client = new InstantlyHttpClient();
        const campaigns = await Promise.all(
          targets.map(async (target) => {
            try {
              const campaign = await client.getCampaign(target.campaignId);
              return { configuredAs: target.label, campaign };
            } catch (error) {
              return {
                configuredAs: target.label,
                campaignId: target.campaignId,
                error: error instanceof Error ? error.message : "unknown error",
              };
            }
          }),
        );

        /**
         * Totals come from one filtered call rather than per campaign, because
         * Instantly ignores the campaign_id filter on its analytics endpoint
         * and would return every campaign in the workspace, including the dev
         * smoke campaign. getCampaignTotals filters the rows here instead.
         */
        const totals = await client.getCampaignTotals(targets.map((target) => target.campaignId));

        return { campaigns, totals };
      },
    },
    {
      name: "system_health",
      description: `Read the state of the server the workers run on. Pick one check by name: ${healthCheckNames().join(
        ", ",
      )}. ${HEALTH_CHECKS.map((check) => `"${check.name}" gives ${check.description}`).join(" ")}`,
      inputSchema: {
        type: "object",
        properties: {
          check: { type: "string", enum: healthCheckNames(), description: "Which check to run." },
        },
        required: ["check"],
        additionalProperties: false,
      },
      run: async (input) => {
        const check = resolveHealthCheck(requiredString(input, "check"));
        const [command, ...args] = check.argv;

        try {
          const { stdout, stderr } = await execFileAsync(command!, args, {
            timeout: HEALTH_COMMAND_TIMEOUT_MS,
            maxBuffer: 1024 * 1024,
            windowsHide: true,
          });
          return {
            check: check.name,
            command: check.argv.join(" "),
            output: truncateOutput(stdout || stderr || "(no output)"),
          };
        } catch (error) {
          return {
            check: check.name,
            command: check.argv.join(" "),
            available: false,
            reason: `The command failed: ${error instanceof Error ? error.message : "unknown error"}`,
          };
        }
      },
    },
    {
      name: "sql_query",
      description: `Run one read-only select against the production database, for questions the other tools do not cover. Rules: one statement, starting with select or with, no comments, no writes. At most ${ASK_SQL_ROW_LIMIT} rows come back. Prefer a purpose built tool above when one fits, because it matches what the dashboard shows.`,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "The select statement." },
          purpose: {
            type: "string",
            description: "One line saying what this query is for, shown to the operator.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      run: async (input, context) => {
        const query = requiredString(input, "query");
        assertReadOnlySql(query);

        const url = readOnlyDatabaseUrl();
        if (!url.available) {
          return { available: false, reason: url.reason };
        }

        const limited = applyRowLimit(query);
        const { runReadOnlyQuery } = await import("./sql-runner");
        const rows = await runReadOnlyQuery({ url: url.value, sql: limited });

        return {
          query: limited,
          tenantScope: `Rows are not tenant filtered automatically. This dashboard's tenant is ${context.tenantId}.`,
          rowCount: rows.length,
          truncated: rows.length >= ASK_SQL_ROW_LIMIT,
          rows,
        };
      },
    },
  ];
}

export function askToolNames(): string[] {
  return buildAskTools().map((tool) => tool.name);
}

/**
 * Runs one tool and never throws.
 *
 * A failed read comes back as a plain "not available" with its reason, so the
 * model reports what it could not read instead of treating a failure as a zero.
 */
export async function runAskTool(
  name: string,
  input: Record<string, unknown>,
  context: AskToolContext,
): Promise<{ readonly isError: boolean; readonly text: string }> {
  const tool = buildAskTools().find((candidate) => candidate.name === name);

  if (!tool) {
    return {
      isError: true,
      text: `not available: there is no tool called "${name}". Tools: ${askToolNames().join(", ")}.`,
    };
  }

  try {
    const result = await tool.run(input, context);
    return { isError: false, text: JSON.stringify(result, jsonSafe) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    console.error("Ask tool failed", { tool: name, reason });
    return { isError: true, text: `not available: ${reason}` };
  }
}

/** Dates and bigints are not JSON, and a Map would silently serialise as {}. */
function jsonSafe(_key: string, value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Map) {
    return Object.fromEntries(value);
  }
  return value;
}
