"use client";

import { signIn, signOut, useSession } from "next-auth/react";
import Link from "next/link";

export function SiteHeader() {
  const { data: s, status } = useSession();

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-900/80 px-4 backdrop-blur">
      <div className="flex items-center gap-6">
        <Link href="/" className="text-sm font-semibold tracking-tight text-white">
          Season Photo Blend
        </Link>
        <nav className="flex gap-4 text-sm text-zinc-400">
          <Link className="hover:text-white" href="/drive">
            Drive
          </Link>
          <Link className="hover:text-white" href="/editor">
            Editor
          </Link>
        </nav>
      </div>
      <div>
        {status === "loading" && (
          <span className="text-xs text-zinc-500">…</span>
        )}
        {status === "unauthenticated" && (
          <button
            type="button"
            onClick={() => signIn("google", { callbackUrl: "/drive" })}
            className="rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-900 hover:bg-white"
          >
            Sign in with Google
          </button>
        )}
        {status === "authenticated" && (
          <div className="flex items-center gap-3">
            <span className="max-w-[11rem] truncate text-xs text-zinc-500">
              {s?.user?.email}
            </span>
            <button
              type="button"
              onClick={() => signOut({ callbackUrl: "/" })}
              className="rounded-md border border-zinc-600 px-2 py-1 text-xs text-zinc-300 hover:border-zinc-500"
            >
              Sign out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
