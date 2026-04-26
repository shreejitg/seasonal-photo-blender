import { SiteHeader } from "@/components/SiteHeader";

export default function Home() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SiteHeader />
      <main className="mx-auto flex max-w-2xl flex-1 flex-col justify-center gap-6 px-6 py-12">
        <h1 className="text-3xl font-semibold text-white sm:text-4xl">
          Find and blend your Drive photos
        </h1>
        <p className="text-zinc-400">
          Connect Google Drive, describe what you are looking for in natural language, rank
          images with on-device CLIP (or optional Gemini), reorder the timeline, align and
          match exposure, then export one blended still.
        </p>
        <ul className="list-inside list-disc text-sm text-zinc-500">
          <li>Read-only access to your images; secrets stay on the server.</li>
          <li>Model download on first use for local scoring (can be large).</li>
        </ul>
        <p className="text-sm text-zinc-500">
          Sign in on the <span className="text-zinc-300">Drive</span> page to get started.
        </p>
      </main>
    </div>
  );
}
