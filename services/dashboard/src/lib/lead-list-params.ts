export type LeadListSearchParams = Record<string, string | undefined>;

export type LeadListFilterParams = {
  status?: string;
  state?: string;
  tradeType?: string;
  scoreMin?: number;
  scoreMax?: number;
  page: number;
};

function asNumber(value: string | undefined) {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseLeadListParams(params: LeadListSearchParams): LeadListFilterParams {
  return {
    status: params.status || undefined,
    state: params.state || undefined,
    tradeType: params.trade_type || undefined,
    scoreMin: asNumber(params.score_min),
    scoreMax: asNumber(params.score_max),
    page: Math.max(asNumber(params.page) ?? 1, 1),
  };
}
