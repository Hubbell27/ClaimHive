import type { Rule } from "@/lib/intel/engine";
import { explainRule } from "@/lib/intel/explain";

/** One rule, in plain English, with the evidence and what wins on appeal. */
export function RuleCard({ rule, mine, compact }: { rule: Rule; mine?: boolean; compact?: boolean }) {
  const t = explainRule(rule);
  return (
    <div className={compact ? "space-y-1 text-sm" : "card space-y-2"}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded px-2 py-0.5 text-xs font-semibold ${rule.stats.strength === "strong" ? "bg-red-100 text-red-900" : "bg-amber-100 text-amber-900"}`}>
          {rule.stats.strength === "strong" ? "Strong rule" : "Solid rule"}
        </span>
        {!compact && <h3 className="font-bold">{t.title}</h3>}
        {mine && <span className="text-xs text-stone-500">one of your insurers</span>}
      </div>
      <p className={compact ? "" : "text-base"}>{t.headline}</p>
      <p className="text-sm"><b>Before sending:</b> {t.fix}</p>
      {t.appeal && <p className="text-sm text-money-saved"><b>On appeal:</b> {t.appeal}</p>}
      {!compact && (
        <details className="text-xs text-stone-500">
          <summary className="cursor-pointer">Evidence</summary>
          <p className="mt-1">{t.evidence}</p>
          {rule.stats.gap && <p>The gap is {Math.round(rule.stats.gap.diff * 100)} points (95% range {Math.round(rule.stats.gap.lo * 100)}–{Math.round(rule.stats.gap.hi * 100)}). Even at the cautious end it clears ClaimHive&apos;s 15-point bar.</p>}
          {t.why && <p>{t.why}</p>}
          <p>&quot;95% range&quot; means we&apos;re 95% confident the true rate is in that range, given how many claims we&apos;ve seen.</p>
        </details>
      )}
    </div>
  );
}
