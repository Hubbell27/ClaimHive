/** Reporting periods: the last 12 months, or one calendar month (YYYY-MM). All UTC dates. */
export interface Period { key: string; label: string; from: Date; to: Date }

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function monthPeriod(key: string): Period | undefined {
  const m = key.match(/^(\d{4})-(\d{2})$/);
  if (!m) return undefined;
  const y = +m[1], mo = +m[2] - 1;
  if (mo < 0 || mo > 11 || y < 2000 || y > 2100) return undefined;
  return { key, label: `${MONTHS[mo]} ${y}`, from: new Date(Date.UTC(y, mo, 1)), to: new Date(Date.UTC(y, mo + 1, 0)) };
}

export function last12(now = new Date()): Period {
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), now.getUTCDate() + 1));
  return { key: "12m", label: "Last 12 months", from, to };
}

export function recentMonths(n = 12, now = new Date()): Period[] {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    return monthPeriod(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`)!;
  });
}

export function resolvePeriod(key: string | undefined, now = new Date()): Period {
  return (key && monthPeriod(key)) || last12(now);
}
