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
    if (process.env.SMOKE_SHOTS) await page.screenshot({ path: `${process.env.SMOKE_SHOTS}/admin.png`, fullPage: true });
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
    await page.waitForURL(/\/(app|onboarding\/pool)$/);
  }
  await page.waitForLoadState("networkidle");
  if (page.url().endsWith("/onboarding/pool")) {
    console.log("onboarding →", (await page.locator("main").innerText()).replace(/\s+/g, " ").slice(0, 300));
    if (process.env.SMOKE_SHOTS) await page.screenshot({ path: `${process.env.SMOKE_SHOTS}/onboarding.png`, fullPage: true });
    await page.click(`button[value=${process.env.SMOKE_POOL === "no" ? "no" : "yes"}]`);
    await page.waitForURL("**/app");
  }
  if (process.env.SMOKE_POOL) {
    await poolFlow(page);
    await browser.close();
    return;
  }
  if (process.env.SMOKE_IMPORTS) {
    await importFlow(page);
    await browser.close();
    return;
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
/** Phase 2: import every synthetic sample through the UI, map, review, then check Results and the PDF. */
async function importFlow(page: import("playwright").Page) {
  const shots = process.env.SMOKE_SHOTS;
  const text = async () => (await page.locator("main").innerText()).replace(/\s+/g, " ");
  const upload = async (file: string) => {
    const res = await page.request.get(`${base}/api/dev/samples/${file}`);
    if (res.status() !== 200) throw new Error(`sample ${file}: ${res.status()}`);
    await page.goto(`${base}/app/imports`);
    await page.setInputFiles("input[type=file]", { name: file, mimeType: "application/octet-stream", buffer: Buffer.from(await res.body()) });
    await page.click("form button[type=submit]");
    await page.waitForURL(/\/app\/imports\/[0-9a-f-]{36}$/);
    for (let i = 0; i < 40; i++) {
      const t = await text();
      if (/Done|Needs a check|Choose columns|Which column|Couldn't read/.test(t) && !/Waiting|Processing/.test(t.slice(0, 200))) break;
      await page.waitForTimeout(500);
      await page.reload();
    }
    // A new report layout is confirmed once on the mapping screen (ClaimHive's guesses pre-filled).
    if (process.env.SMOKE_ACCEPT_MAPPING !== "0" && /Which column/.test(await text()) && !/Not in this report Who/.test(await text())) {
      await page.click("form button[type=submit]");
      await page.waitForTimeout(3000);
      await page.reload();
    }
    console.log(file, "→", (await text()).slice(0, 230));
  };
  await upload("1-claims.837");
  await upload("2-remittance.835");
  await upload("3-appeal-payments.835");
  await upload("aging-dentrix-style.csv");
  await upload("aging-opendental-style.xlsx");
  await upload("aging-unusual-columns.csv");
  if (await page.locator("select[name=map_payer]").count()) {
    await page.selectOption("select[name=map_patientName]", "Who");
    await page.selectOption("select[name=map_payer]", "Ins");
    await page.selectOption("select[name=map_serviceDate]", "When");
    await page.selectOption("select[name=map_billed]", "Owed by ins");
    await page.click("form button[type=submit]");
    await page.waitForTimeout(3000);
    await page.reload();
    console.log("after mapping →", (await text()).slice(0, 200));
  }
  await upload("eob-clear.pdf");
  await upload("eob-hard-to-read.pdf");
  await page.goto(`${base}/app/review`);
  console.log("review queue →", (await text()).slice(0, 200));
  const item = page.locator("a[href^='/app/review/']").first();
  if (await item.count()) {
    await item.click();
    await page.waitForURL(/\/app\/review\/[0-9a-f-]{36}$/);
    if (shots) await page.screenshot({ path: `${shots}/review.png`, fullPage: true });
    await page.click("button[value=accept]");
    await page.waitForURL(/\/app\/review$/);
    console.log("after accept →", (await text()).slice(0, 120));
  }
  await page.goto(`${base}/app/results`);
  console.log("results →", (await text()).slice(0, 700));
  if (shots) await page.screenshot({ path: `${shots}/results.png`, fullPage: true });
  const month = new Date().toISOString().slice(0, 7);
  const pdf = await page.request.get(`${base}/api/reports/results?month=${month}`);
  const bytes = Buffer.from(await pdf.body());
  console.log("pdf", pdf.status(), pdf.headers()["content-type"], bytes.length, "bytes", bytes.subarray(0, 5).toString());
  if (shots) (await import("node:fs")).writeFileSync(`${shots}/results-${month}.pdf`, bytes);
  await page.goto(`${base}/app/claims?status=denied`);
  console.log("claims →", (await text()).slice(0, 300));
  await page.goto(`${base}/app/imports`);
  if (shots) await page.screenshot({ path: `${shots}/imports.png`, fullPage: true });
  await page.goto(`${base}/app`);
  if (shots) await page.screenshot({ path: `${shots}/dashboard.png`, fullPage: true });
}

/** Phase 3: patterns for a contributor, the Settings summary, stopping sharing. */
async function poolFlow(page: import("playwright").Page) {
  const shots = process.env.SMOKE_SHOTS;
  const text = async () => (await page.locator("main").innerText()).replace(/\s+/g, " ");
  for (let i = 0; i < 20; i++) { // the full sync runs in the worker
    await page.goto(`${base}/app/settings`);
    if (/Claims in the pool \d*[1-9]/.test(await text())) break;
    await page.waitForTimeout(1000);
  }
  console.log("settings →", (await text()).slice(0, 260));
  if (shots) await page.screenshot({ path: `${shots}/settings.png`, fullPage: true });
  await page.goto(`${base}/app/pool`);
  console.log("patterns →", (await text()).slice(0, 500));
  if (shots) await page.screenshot({ path: `${shots}/patterns.png`, fullPage: true });
  await page.selectOption("select[name=code]", "cat:restorative");
  await page.check("input[name=mine]");
  await page.selectOption("select[name=min]", "10");
  await page.click("form button[type=submit]");
  await page.waitForURL(/code=cat%3Arestorative/);
  console.log("filtered →", page.url().replace(base, ""), (await text()).slice(0, 400));
  if (shots) await page.screenshot({ path: `${shots}/patterns-filtered.png`, fullPage: true });
  await page.goto(`${base}/app/settings`);
  await page.click("button[value=no]");
  await page.waitForURL(/settings\?saved=1/);
  console.log("after stop →", (await text()).slice(0, 160));
  await page.goto(`${base}/app/pool`);
  console.log("patterns after stop →", (await text()).slice(0, 160));
}

main().catch((e) => { console.error(e); process.exit(1); });
