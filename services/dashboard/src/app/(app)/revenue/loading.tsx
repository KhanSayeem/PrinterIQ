export default function RevenueLoading() {
  return (
    <>
      <div className="page-header">
        <div className="page-title-wrap">
          <div className="page-title">Revenue</div>
          <div className="page-subtitle">Loading revenue data</div>
        </div>
      </div>
      <div className="revenue-content">
        <div className="rev-tabs">
          {Array.from({ length: 3 }).map((_, index) => (
            <span className="skeleton-block skeleton-tab" key={index} />
          ))}
        </div>
        <div className="metrics-grid">
          {Array.from({ length: 4 }).map((_, index) => (
            <div className="metric-card" key={index}>
              <span className="skeleton-block skeleton-label" />
              <span className="skeleton-block skeleton-value" />
              <span className="skeleton-block skeleton-small" />
            </div>
          ))}
        </div>
        <div className="ai-card">
          <span className="skeleton-block skeleton-title" />
          {Array.from({ length: 3 }).map((_, index) => (
            <div className="ai-row" key={index}>
              <span className="skeleton-block skeleton-dot" />
              <span className="skeleton-block skeleton-ai-line" />
              <span className="skeleton-block skeleton-cost" />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
