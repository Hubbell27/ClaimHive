"use client";
/** Last-resort error page: never shows error details, only a reference for support. */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="card w-full max-w-md space-y-3">
        <p className="text-sm font-bold tracking-wide text-brand">ClaimHive</p>
        <h1 className="text-2xl font-bold">Something went wrong</h1>
        <p>Please try again. If it keeps happening, contact support.</p>
        {error.digest && <p className="text-sm text-stone-500">Reference: {error.digest}</p>}
        <button type="button" className="btn-secondary" onClick={reset}>Try again</button>
      </div>
    </main>
  );
}
