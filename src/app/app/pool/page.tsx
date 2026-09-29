import Link from "next/link";
import { audit } from "@/lib/audit";
import { can, requirePractice } from "@/lib/auth/rbac";
import { poolInsights, type InsightFilter } from "@/lib/pool/insights";
import type { PatternSort } from "@/lib/pool/store";
import { CDT, CDT_BY_CODE } from "@/lib/reference/codes";

const pct = (x: number) => `${Math.round(x * 100)}%`;
const PLAN_LABEL: Record<string, string> = { PPO: "PPO", DHMO: "DHMO", INDEMNITY: "Indemnity", MEDICAID: "Medicaid", MEDICARE_ADVANTAGE: "Medicare Advantage", UNKNOWN: "Unknown" };
const CATEGORY_LABEL: Record<string, string> = {
  diagnostic: "Diagnostic", preventive: "Preventive", restorative: "Restorative", endodontic: "Endodontics", periodontic: "Periodontics",
  prosthodontic: "Prosthodontics", implant: "Implants", oral_surgery: "Oral surgery", adjunctive: "Adjunctive",
};
const SORTS: { key: PatternSort; label: string }[] = [
  { key: "rate", label: "Highest denial rate" }, { key: "volume", label: "Most procedures" }, { key: "payer", label: "Insurer A–Z" },
];
const MIN_SAMPLES = [1, 10, 25, 50, 100];

type Search = { payer?: string; code?: string; plan?: string; mine?: string; min?: string; sort?: string };

/** Only values we recognize are used; anything else in the URL is ignored. */
function parseFilter(q: Search): InsightFilter & { code?: string } {
  const code = q.code ?? "";
  return {
    payer: q.payer && q.payer.length <= 80 ? q.payer : undefined,
    cdt: /^D\d{4}$/.test(code) ? code : undefined,
    category: code.startsWith("cat:") && CATEGORY_LABEL[code.slice(4)] ? code.slice(4) : undefined,
    code: code || undefined,
    planType: q.plan && PLAN_LABEL[q.plan] ? q.plan : undefined,
    mine: q.mine === "1",
    minLines: MIN_SAMPLES.includes(Number(q.min)) ? Number(q.min) : 1,
    sort: SORTS.some((s) => s.key === q.sort) ? (q.sort as PatternSort) : "rate",
    limit: 200,
  };
}

export default async function PoolPage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await requirePractice("dashboard.view");
  const f = parseFilter(await searchParams);
  const insights = await poolInsights(ctx.practiceId, f);
  await audit({ action: "pool.view", actorUserId: ctx.userId, actorEmail: ctx.email, practiceId: ctx.practiceId,
    details: { allowed: insights.allowed, filtered: !!(f.payer || f.code || f.planType || f.mine || (f.minLines ?? 1) > 1) } });

  if (!insights.allowed) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">Insurer patterns</h1>
        <div className="card max-w-2xl space-y-2">
          <p className="font-semibold">Patterns from other practices are available to practices that share their de-identified data.</p>
          <p className="text-sm text-stone-600">Your own claims, denials and results are always on the Money, Claims and Results pages.</p>
          {can(ctx.role, "pool.opt_in")
            ? <Link href="/app/settings" className="btn-primary">See what sharing means</Link>
            : <p className="text-sm text-stone-600">Your practice owner can turn this on in Settings.</p>}
        </div>
      </div>
    );
  }
  const o = insights.options;
  const categories = [...new Set(o.cdts.map((c) => CDT_BY_CODE.get(c)?.category).filter(Boolean) as string[])];
  const active = !!(f.payer || f.code || f.planType || f.mine || (f.minLines ?? 1) > 1);
  const rows = insights.denialRates;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Insurer patterns</h1>
      <p className="max-w-3xl text-sm text-stone-600">
        How often each insurer denies each procedure, across practices that share de-identified data. A pattern appears only once
        at least {insights.minPractices} practices have contributed to it, and that rule is applied after your filters too.
      </p>

      <form className="card grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <label className="lg:col-span-2"><span className="label">Insurer</span>
          <select name="payer" defaultValue={f.payer ?? ""} className="field">
            <option value="">All insurers</option>
            {o.payers.map((p) => <option key={p} value={p}>{p}{o.myPayers.includes(p) ? " (yours)" : ""}</option>)}
          </select>
        </label>
        <label className="lg:col-span-2"><span className="label">Procedure</span>
          <select name="code" defaultValue={f.code ?? ""} className="field">
            <option value="">All procedures</option>
            <optgroup label="Type">
              {categories.map((c) => <option key={c} value={`cat:${c}`}>{CATEGORY_LABEL[c]}</option>)}
            </optgroup>
            <optgroup label="Code">
              {CDT.filter((c) => o.cdts.includes(c.code)).map((c) => <option key={c.code} value={c.code}>{c.code} {c.label}</option>)}
            </optgroup>
          </select>
        </label>
        <label><span className="label">Plan type</span>
          <select name="plan" defaultValue={f.planType ?? ""} className="field">
            <option value="">All plans</option>
            {o.planTypes.map((p) => <option key={p} value={p}>{PLAN_LABEL[p] ?? p}</option>)}
          </select>
        </label>
        <label><span className="label">Sample size</span>
          <select name="min" defaultValue={String(f.minLines ?? 1)} className="field">
            {MIN_SAMPLES.map((n) => <option key={n} value={n}>{n === 1 ? "Any" : `${n}+ procedures`}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 lg:col-span-2">
          <input type="checkbox" name="mine" value="1" defaultChecked={f.mine} className="h-5 w-5" />
          <span className="text-sm font-semibold">Only insurers my practice bills</span>
        </label>
        <label className="lg:col-span-2"><span className="label">Sort by</span>
          <select name="sort" defaultValue={f.sort} className="field">
            {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </label>
        <div className="flex items-end gap-2 lg:col-span-2">
          <button type="submit" className="btn-primary">Apply</button>
          {active && <Link href="/app/pool" className="btn-secondary">Clear</Link>}
        </div>
      </form>

      <p className="text-sm text-stone-500">{rows.length} pattern{rows.length === 1 ? "" : "s"}{rows.length === 200 ? " (showing the first 200)" : ""}</p>
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-stone-500"><th className="p-3">Insurer</th><th>Procedure</th><th className="text-right">Denied</th><th className="p-3">Evidence</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.payer}-${r.cdt}`} className="border-t">
                <td className="p-3">{r.payer}{o.myPayers.includes(r.payer) && <span className="ml-1 text-xs text-stone-400">yours</span>}</td>
                <td><span className="font-mono">{r.cdt}</span> <span className="text-stone-500">{CDT_BY_CODE.get(r.cdt)?.label ?? ""}</span></td>
                <td className={`text-right font-semibold ${r.rate >= 0.3 ? "text-money-lost" : ""}`}>{pct(r.rate)}</td>
                <td className="p-3 text-xs text-stone-500">{r.denied} of {r.lines} procedures denied · {r.practices} practices</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && (
          <p className="p-4 text-sm text-stone-500">
            {active ? "No pattern matches these filters with at least " + insights.minPractices + " practices behind it. Try widening them."
              : "Not enough practices have shared yet for any pattern to be shown."}
          </p>
        )}
      </div>
    </div>
  );
}
