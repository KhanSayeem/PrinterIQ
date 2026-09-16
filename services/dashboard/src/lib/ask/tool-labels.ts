/**
 * Plain English for each tool, shown while it runs.
 *
 * "Reading mailbox health" says what the wait is for; "sending_accounts" only
 * says that a machine is busy. A test pins every tool to a label, so a new
 * tool cannot arrive with nothing to show.
 *
 * Client safe on purpose: the panel imports this, so it must not pull in the
 * server only toolbox.
 */

const TOOL_LABELS: Record<string, string> = {
  sends_today: "Counting today's sends",
  sends_to_date: "Adding up sends since launch",
  sending_accounts: "Reading mailbox health",
  leads_search: "Searching leads",
  lead_counts: "Counting leads",
  lead_detail: "Opening the lead",
  replies_recent: "Reading the reply inbox",
  reply_counts: "Counting replies",
  reply_ingest_health: "Checking the inbound reply path",
  pipeline_funnel: "Reading the funnel",
  revenue: "Adding up payments",
  instantly_campaigns: "Checking the campaigns",
  system_health: "Checking the server",
  sql_query: "Querying the database",
};

/** Labels shown before any tool has started, cycled while the model decides. */
export const ASK_THINKING_LABELS = ["Thinking", "Working out what to read"];

export function askToolLabel(name: string): string {
  return TOOL_LABELS[name] ?? `Reading ${name.replace(/_/g, " ")}`;
}

export function askToolLabelNames(): string[] {
  return Object.keys(TOOL_LABELS);
}
