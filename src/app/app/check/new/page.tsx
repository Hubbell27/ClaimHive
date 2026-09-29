import Link from "next/link";
import { CheckForm } from "@/components/CheckForm";
import { requirePractice } from "@/lib/auth/rbac";
import { payerOptions } from "@/lib/precheck/entry";

export default async function NewCheck() {
  const ctx = await requirePractice("phi.edit");
  return (
    <div className="space-y-4">
      <p className="text-sm"><Link href="/app/check" className="underline">← Check a claim</Link></p>
      <h1 className="text-2xl font-bold">Check a claim before sending</h1>
      <CheckForm payers={await payerOptions(ctx.practiceId)} today={new Date().toISOString().slice(0, 10)} />
    </div>
  );
}
