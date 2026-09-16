/**
 * Where things are in this dashboard.
 *
 * The panel could read every number and still not answer "where do I see that
 * reply", because the toolbox returns data and nothing described the app. It
 * answered "I don't have visibility into the dashboard's actual page structure
 * or URLs", which is a fair answer to a question it should never have had to
 * guess at.
 *
 * A test walks src/app/(app) and fails when a page is added or renamed without
 * being listed here, so this cannot quietly go stale.
 *
 * Client safe: no server only imports, so the panel can use it too.
 */

export type DashboardRoute = {
  readonly path: string;
  /** What the operator sees there, in their words rather than the code's. */
  readonly describes: string;
};

export const ASK_DASHBOARD_ROUTES: readonly DashboardRoute[] = [
  { path: "/", describes: "the home overview: today's sending, the funnel and the money in one screen" },
  {
    path: "/leads",
    describes:
      "the lead list, with filters for status, state, trade and score, and a search box that matches business name or email",
  },
  {
    path: "/leads/<leadId>",
    describes:
      "one lead's full record: contact details, score, status history, the whole conversation thread including replies sent and received, the website preview and any payment",
  },
  {
    path: "/replies",
    describes:
      "the reply inbox, filtered by intent or by the needs attention queue. A thread that has been answered no longer shows as needing attention",
  },
  { path: "/pipeline", describes: "the funnel stage by stage, with the conversion rate between stages" },
  { path: "/revenue", describes: "payments for today, this week and this month" },
  {
    path: "/sending",
    describes: "the send rate controls, the daily limits per mailbox and the campaign kill switch",
  },
  {
    path: "/deliverability",
    describes:
      "mailbox by mailbox health: account status, warmup, sent today against the daily limit, and bounces over the last 30 days",
  },
] as const;

/** The page for one lead, which is where its conversation thread lives. */
export function askLeadPath(leadId: string): string {
  return `/leads/${leadId}`;
}

/** The routes as prompt lines, so the model quotes a real path rather than inventing one. */
export function describeDashboardRoutes(): string {
  return ASK_DASHBOARD_ROUTES.map((route) => `- ${route.path} is ${route.describes}.`).join("\n");
}
