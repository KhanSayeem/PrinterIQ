import { ShadowModeBanner } from "@/components/ShadowModeBanner";

export default function ProspectsLoading() {
  return (
    <>
      <div className="page-header prospects-page-header">
        <div className="page-title-wrap">
          <div className="page-title">Prospects</div>
          <div className="page-subtitle">Loading discovery run</div>
        </div>
      </div>
      <ShadowModeBanner />
      <div className="prospects-loading" role="status" aria-live="polite">
        <span className="skeleton-block prospect-loading-title" />
        <span>Loading discovery run status...</span>
        <div className="prospect-loading-grid">
          {Array.from({ length: 5 }).map((_, index) => (
            <span className="skeleton-block prospect-loading-count" key={index} />
          ))}
        </div>
      </div>
    </>
  );
}
