export default function SendingLoading() {
  return (
    <>
      <div className="page-header">
        <div className="page-title-wrap">
          <div className="page-title">Sending</div>
          <div className="page-subtitle">Reading the current daily limits from Instantly</div>
        </div>
      </div>
      <div className="send-rate-screen">
        <div className="metrics-grid">
          {Array.from({ length: 3 }).map((_, index) => (
            <div className="metric-card" key={index}>
              <span className="skeleton-block skeleton-label" />
              <span className="skeleton-block skeleton-value" />
              <span className="skeleton-block skeleton-small" />
            </div>
          ))}
        </div>
        <div className="ai-card send-rate-card">
          <span className="skeleton-block skeleton-title" />
          {Array.from({ length: 4 }).map((_, index) => (
            <span className="skeleton-block skeleton-ai-line" key={index} />
          ))}
        </div>
      </div>
    </>
  );
}
