import { ShieldCheck } from "lucide-react";

export function ShadowModeBanner() {
  return (
    <div className="shadow-mode-banner" role="status">
      <ShieldCheck size={16} aria-hidden="true" />
      <div>
        <strong>Shadow mode</strong>
        <span>Staged prospects cannot create leads, previews, or outreach.</span>
      </div>
    </div>
  );
}
