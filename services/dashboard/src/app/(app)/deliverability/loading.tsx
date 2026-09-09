export default function DeliverabilityLoading() {
  return (
    <>
      <div className="page-header">
        <div className="page-title-wrap">
          <div className="page-title">Deliverability</div>
          <div className="page-subtitle">Loading sending account health</div>
        </div>
      </div>
      <div className="funnel-content">
        <div className="metrics-grid">
          {Array.from({ length: 3 }).map((_, index) => (
            <div className="metric-card" key={index}>
              <span className="skeleton-block skeleton-label" />
              <span className="skeleton-block skeleton-value" />
              <span className="skeleton-block skeleton-small" />
            </div>
          ))}
        </div>
        <div className="deliv-mailboxes">
          {Array.from({ length: 4 }).map((_, index) => (
            <div className="deliv-card" key={index}>
              <span className="skeleton-block skeleton-title" />
              <span className="skeleton-block skeleton-small" />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
