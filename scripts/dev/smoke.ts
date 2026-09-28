/**
 * Browser smoke test (synthetic demo data only): login -> MFA enrolment ->
 * forced password change -> choose practice -> dashboard, patients, audit, export.
 * Usage: SMOKE_EMAIL=... SMOKE_PASSWORD=... npx tsx scripts/dev/smoke.ts
 */
import { chromium } from "playwright";
import { codeAt, currentStep } from "../../src/lib/auth/totp";

const base = process.env.SMOKE_URL ?? "http://localhost:3000";
const email = process.env.SMOKE_EMAIL!;
const temp = process.env.SMOKE_PASSWORD!;
const newPw = "Synthetic-Smoke-Pass-2026!";

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
  const page = await browser.newPage();
  await page.goto(`${base}/login`);
  await page.fill("input[name=email]", email);
  await page.fill("input[name=password]", temp);
  await page.click("form button");
  await page.waitForURL("**/mfa");
  const secret = (await page.locator("code").innerText()).replace(/\s/g, "");
  await page.fill("input[name=code]", codeAt(secret, currentStep()));
  await page.click("form button");
  await page.waitForURL("**/change-password");
  await page.fill("input[name=current]", temp);
  await page.fill("input[name=next]", newPw);
  await page.fill("input[name=confirm]", newPw);
  await page.click("form button");
  await page.waitForURL(/\/(choose-practice|app)$/);
  if (process.env.SMOKE_ADMIN) {
    const a = await page.goto(`${base}/admin`);
    console.log("admin console", a?.status(), (await page.locator("main").innerText()).replace(/\s+/g, " ").slice(0, 200));
    await page.goto(`${base}/app/patients`);
    console.log("admin -> /app/patients lands on", page.url());
    const exp = await page.request.get(`${base}/api/export/patients`, { maxRedirects: 0 });
    console.log("admin export", exp.status(), exp.headers()["location"]);
    await browser.close();
    return;
  }
  if (page.url().endsWith("/choose-practice")) {
    await page.locator("form button").first().click();
    await page.waitForURL("**/app");
  }
  console.log("dashboard:", (await page.locator("main").innerText()).replace(/\s+/g, " ").slice(0, 400));
  for (const p of ["patients", "members", "audit", "settings"]) {
    const r = await page.goto(`${base}/app/${p}`);
    console.log(p, r?.status(), (await page.locator("main").innerText()).replace(/\s+/g, " ").slice(0, 160));
  }
  const exp = await page.request.get(`${base}/api/export/patients`);
  console.log("export", exp.status(), (await exp.text()).split("\n").length, "lines");
  const admin = await page.goto(`${base}/admin`);
  console.log("admin as practice user ->", admin?.status(), page.url());
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
