import Link from "next/link";
import { codeHref, findReason, type ReasonKind } from "@/lib/reference/reasons";

/** A reason code that opens its explanation on the Reason codes page. */
export function CodeLink({ kind, code, group, className }: { kind: ReasonKind; code: string; group?: string; className?: string }) {
  const r = findReason(kind, code);
  return (
    <Link href={codeHref(kind, code)} title={r ? r.label : "Look up this code"} className={`underline decoration-dotted underline-offset-2 hover:decoration-solid ${className ?? ""}`}>
      {group ? `${group}-` : ""}{code}
    </Link>
  );
}
