export default function PipelineLoading() {
  return (
    <>
      <div className="page-header">
        <div className="page-title-wrap">
          <div className="page-title">Funnel</div>
          <div className="page-subtitle">Loading pipeline data</div>
        </div>
      </div>
      <div className="funnel-content">
        <div className="stage-grid">
          {Array.from({ length: 7 }).map((_, index) => (
            <div className="stage-card" key={index}>
              <span className="skeleton-block skeleton-label" />
              <span className="skeleton-block skeleton-value" />
              <span className="skeleton-block skeleton-small" />
            </div>
          ))}
        </div>
        <div className="funnel-bars">
          <span className="skeleton-block skeleton-title" />
          {Array.from({ length: 5 }).map((_, index) => (
            <div className="fbar-row" key={index}>
              <span className="skeleton-block skeleton-small" />
              <div className="fbar-track">
                <span className="skeleton-block skeleton-track" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
