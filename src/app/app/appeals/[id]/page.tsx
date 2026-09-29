import Link from "next/link";
import { notFound } from "next/navigation";
import { AutoRefresh } from "@/components/AutoRefresh";
import { LetterEditor } from "@/components/LetterEditor";
import { audit } from "@/lib/audit";
import { can, requirePractice } from "@/lib/auth/rbac";
import { markLetterSentAction, retryLetterAction } from "@/lib/actions/appeals";
import { ERROR_TEXT, letterDetail, MISSING, profileGaps } from "@/lib/appeals/letters";
import { prisma } from "@/lib/db";

export default async function LetterPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requirePractice("phi.view");
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const d = await letterDetail(ctx, id);
  if (!d) notFound();
  await audit({ action: "phi.view", actorUserId: ctx.userId, actorEmail: ctx.email, practiceId: ctx.practiceId, resourceType: "appeal_letter", resourceId: id });
  const l = d.letter;
  const practice = await prisma().practice.findUniqueOrThrow({ where: { id: ctx.practiceId } });
  const gaps = profileGaps(practice);
  const edit = can(ctx.role, "phi.edit");
  const missing = [...new Set([...d.body.matchAll(new RegExp(MISSING, "g"))].map((m) => m[0].slice(5, -1)))];
  const re: [string, string][] = [["Patient", d.patient.name], ["Date of birth", d.patient.dob || "—"], ["Member ID", d.patient.memberId || "—"],
    ["Claim number", d.claimNumber || "—"], ["Date of service", d.serviceDate], ["Denied", d.deniedAt || "—"]];

  return (
    <div className="space-y-4">
      {l.status === "generating" && <AutoRefresh />}
      <p className="text-sm"><Link href="/app/appeals" className="underline">← Appeals</Link> · <Link href={`/app/claims/${l.claimId}`} className="underline">the claim</Link></p>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-bold">Appeal letter: {d.patient.name}</h1>
        <p className="text-sm text-stone-500">{l.claim.payer.name} · {l.writer === "ai" ? `written by AI (${l.model}) from de-identified details` : l.writer === "template" ? "ClaimHive standard letter" : ""}</p>
      </div>

      {l.status === "generating" && <p className="card">Writing the letter… this usually takes under a minute.</p>}
      {l.status === "failed" && (
        <div className="card space-y-2 border-red-300 bg-red-50">
          <p className="font-semibold">The letter couldn&apos;t be written.</p>
          <p className="text-sm">{ERROR_TEXT[l.errorCode ?? ""] ?? "Something went wrong. Try again."}</p>
          {edit && (
            <form action={retryLetterAction} className="flex flex-wrap gap-2">
              <input type="hidden" name="letterId" value={l.id} />
              {l.errorCode !== "identifier_in_request" && <button name="useTemplate" value="no" className="btn-primary">Try again</button>}
              <button name="useTemplate" value="yes" className="btn-secondary">Use ClaimHive&apos;s standard letter</button>
            </form>
          )}
        </div>
      )}
      {l.status === "superseded" && <p className="card text-sm">A newer letter replaced this one. <Link className="underline" href={`/app/claims/${l.claimId}`}>Go to the claim</Link>.</p>}

      {(l.status === "draft" || l.status === "approved") && (<>
        <div className={`card text-sm ${l.status === "approved" ? "border-green-300 bg-green-50" : "border-amber-300 bg-amber-50"}`}>
          {l.status === "approved"
            ? <p><b>Approved</b> (version {l.approvedVersion}, {l.approvedAt?.toLocaleString("en-US")}){l.sentAt ? ` · marked sent ${l.sentAt.toLocaleDateString("en-US")}` : ""}.</p>
            : <p><b>Draft: needs your review.</b> Check every detail, edit anything that&apos;s wrong, then approve. ClaimHive never sends letters.</p>}
          {gaps.length > 0 && <p className="mt-1">Before approving, add the practice&apos;s {gaps.join(", ")} in <Link className="underline" href="/app/settings">Settings</Link> (owners).</p>}
        </div>
        <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
          {edit && !l.sentAt ? (
            <LetterEditor key={l.version} letterId={l.id} body={d.body} recipient={l.recipient ?? ""} enclosures={l.enclosures}
              version={l.version} approved={l.status === "approved"} missing={missing} />
          ) : (
            <pre className="card whitespace-pre-wrap font-serif text-[15px]">{d.body}</pre>
          )}
          <aside className="space-y-3">
            <div className="card space-y-1 text-sm">
              <p className="font-semibold">Printed above the letter</p>
              {re.map(([k, v]) => <p key={k}><span className="text-stone-500">{k}:</span> {v}</p>)}
              <p className="pt-1 text-xs text-stone-500">From the claim. Letterhead, date and signature come from Settings.</p>
            </div>
            {l.status === "approved" && (
              <div className="card space-y-2">
                <a className="btn-primary w-full" href={`/api/appeals/${l.id}/pdf`}>Download PDF</a>
                {edit && !l.sentAt && (
                  <form action={markLetterSentAction}>
                    <input type="hidden" name="letterId" value={l.id} />
                    <button className="btn-secondary w-full">I&apos;ve sent it to the insurer</button>
                  </form>
                )}
                <p className="text-xs text-stone-500">Send it by mail, fax or the insurer&apos;s portal, with the enclosures. When the payment shows on an 835, ClaimHive records the win.</p>
              </div>
            )}
            {d.template && (
              <details className="card text-sm">
                <summary className="cursor-pointer font-semibold">What the writer returned</summary>
                <p className="mt-2 text-xs text-stone-500">Before patient and practice details were filled in. {l.writer === "ai" ? "The request sent to the AI had no names, dates or ID numbers." : ""}</p>
                <pre className="mt-2 whitespace-pre-wrap text-xs">{d.template}</pre>
              </details>
            )}
          </aside>
        </div>
      </>)}
    </div>
  );
}
