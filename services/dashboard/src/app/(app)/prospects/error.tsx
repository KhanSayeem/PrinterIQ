"use client";

import { RefreshCw } from "lucide-react";
import { ShadowModeBanner } from "@/components/ShadowModeBanner";

export default function ProspectsError({ reset }: { error: Error; reset: () => void }) {
  return (
    <>
      <div className="page-header prospects-page-header">
        <div className="page-title-wrap">
          <div className="page-title">Prospects</div>
          <div className="page-subtitle">Discovery run status unavailable</div>
        </div>
      </div>
      <ShadowModeBanner />
      <div className="prospect-route-error" role="alert">
        <strong>Could not load prospects</strong>
        <span>Check the dashboard database connection, then try again.</span>
        <button className="btn btn-ghost" type="button" onClick={reset}>
          <RefreshCw size={14} aria-hidden="true" />
          Try again
        </button>
      </div>
    </>
  );
}
