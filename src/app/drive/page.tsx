import { SiteHeader } from "@/components/SiteHeader";
import { DriveView } from "@/components/DriveView";

export default function DrivePage() {
  return (
    <div className="flex min-h-0 min-h-screen flex-1 flex-col">
      <SiteHeader />
      <div className="min-h-0 flex-1 overflow-auto p-4 sm:p-6">
        <DriveView />
      </div>
    </div>
  );
}
