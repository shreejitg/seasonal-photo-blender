import { SiteHeader } from "@/components/SiteHeader";
import { EditorView } from "@/components/EditorView";

export default function EditorPage() {
  return (
    <div className="flex min-h-screen min-h-0 flex-1 flex-col">
      <SiteHeader />
      <div className="min-h-0 flex-1 overflow-auto p-4 sm:p-6">
        <EditorView />
      </div>
    </div>
  );
}
