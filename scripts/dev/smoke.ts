/**
 * Browser smoke test (synthetic demo data only): login -> MFA enrolment ->
 * forced password change -> choose practice -> dashboard, patients, audit, export.
 * Usage: SMOKE_EMAIL=... SMOKE_PASSWORD=... npx tsx scripts/dev/smoke.ts
 */
import "dotenv/config";
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
  if (process.env.SMOKE_ADMIN && process.env.SMOKE_BILLING) {
    await adminBillingFlow(page);
    await browser.close();
    return;
  }
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
  await page.waitForLoadState("load");
  await page.waitForTimeout(1500);
  if (page.url().endsWith("/onboarding/pool")) {
    console.log("onboarding →", (await page.locator("main").innerText()).replace(/\s+/g, " ").slice(0, 300));
    if (process.env.SMOKE_SHOTS) await page.screenshot({ path: `${process.env.SMOKE_SHOTS}/onboarding.png`, fullPage: true });
    await page.click(`button[value=${process.env.SMOKE_POOL === "no" ? "no" : "yes"}]`);
    await page.waitForURL("**/app");
  }
  if (process.env.SMOKE_CODES) {
    await codesFlow(page);
    await browser.close();
    return;
  }
  if (process.env.SMOKE_SETUP) {
    await setupFlow(page);
    await browser.close();
    return;
  }
  if (process.env.SMOKE_BILLING) {
    await practiceBillingFlow(page);
    await browser.close();
    return;
  }
  if (process.env.SMOKE_APPEALS) {
    await appealsFlow(page);
    await browser.close();
    return;
  }
  if (process.env.SMOKE_PRECHECK) {
    await precheckFlow(page);
    await browser.close();
    return;
  }
  if (process.env.SMOKE_INTEL) {
    await intelFlow(page);
    await browser.close();
    return;
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

/** Phase 4: rules with evidence, rule matches on denied claims, recording an appeal. */
async function intelFlow(page: import("playwright").Page) {
  const shots = process.env.SMOKE_SHOTS;
  const text = async () => (await page.locator("main").innerText()).replace(/\s+/g, " ");
  await page.goto(`${base}/app/pool`);
  console.log("rules →", (await text()).slice(0, 900));
  if (shots) await page.screenshot({ path: `${shots}/rules.png`, fullPage: false });
  await page.goto(`${base}/app/claims?status=denied`);
  const hit = page.locator("td a.bg-amber-50").first();
  console.log("claims with a ClaimHive match:", await page.locator("td a.bg-amber-50").count());
  if (shots) await page.screenshot({ path: `${shots}/claims-denied.png`, fullPage: false });
  if (await hit.count()) {
    await hit.click();
    await page.waitForURL(/\/app\/claims\/[0-9a-f-]{36}$/);
    console.log("claim →", (await text()).slice(0, 700));
    const before = await page.locator("select[name=status]").inputValue();
    const target = before === "drafted" ? "sent" : "drafted";
    await page.selectOption("select[name=status]", target);
    const boxes = page.locator("input[name=attachments]");
    if (await boxes.count()) await boxes.first().check();
    await page.selectOption("select[name=argument]", "documentation");
    if (await page.locator("select[name=ruleKey] option").count() > 1) await page.selectOption("select[name=ruleKey]", { index: 1 });
    await page.click("form button[type=submit]");
    await page.waitForLoadState("load");
  await page.waitForTimeout(1500);
    await page.reload();
    const shown = await page.locator("select[name=status]").inputValue();
    if (shown !== target) throw new Error(`appeal form shows "${shown}" after saving "${target}"`);
    console.log(`appeal saved and shown as ${shown}`);
    if (shots) await page.screenshot({ path: `${shots}/claim.png`, fullPage: true });
  }
}

/** Phase 5: check one claim by hand, tick the fix, then check an 837 before sending. */
async function precheckFlow(page: import("playwright").Page) {
  const shots = process.env.SMOKE_SHOTS;
  const text = async () => (await page.locator("main").innerText()).replace(/\s+/g, " ");
  const settle = async () => { await page.waitForLoadState("load"); await page.waitForTimeout(1500); };
  await page.goto(`${base}/app/check/new`);
  await page.fill("input[name=firstName]", "Tess");
  await page.fill("input[name=lastName]", "Smokecheck");
  await page.fill("input[name=dob]", "1980-05-05");
  await page.selectOption("select[name=payer]", "Summit Dental Mutual");
  for (const i of [0, 1]) { await page.fill(`input[name=cdt_${i}]`, "D4341"); await page.fill(`input[name=fee_${i}]`, "250"); }
  if (shots) await page.screenshot({ path: `${shots}/check-form.png`, fullPage: true });
  await page.click("form button[type=submit]");
  await page.waitForURL(/\/app\/check\/[0-9a-f-]{36}$/);
  await settle();
  const before = await page.getByTestId("at-risk").innerText();
  console.log("check →", (await text()).slice(0, 700));
  if (shots) await page.screenshot({ path: `${shots}/check-result.png`, fullPage: true });
  const fix = page.getByRole("button", { name: /I've attached the perio chart/ });
  if (!(await fix.count())) throw new Error("expected the perio chart finding");
  await fix.click();
  await settle();
  await page.reload();
  const after = await page.getByTestId("at-risk").innerText();
  console.log(`at risk before fix: ${before} | after: ${after}`);
  if (after === before) throw new Error("risk did not change after the fix");
  if (shots) await page.screenshot({ path: `${shots}/check-fixed.png`, fullPage: true });

  // 837 before sending.
  const { generateDataset } = await import("../../src/lib/synthetic/generator");
  const { build837 } = await import("../../src/lib/synthetic/files");
  const [data] = generateDataset({ seed: Date.now() % 100000, practices: 1, patientsPerPractice: 25, claimPrefix: "SMK" });
  await page.goto(`${base}/app/check`);
  await page.setInputFiles("input[type=file]", { name: "outgoing.837", mimeType: "text/plain", buffer: Buffer.from(build837(data)) });
  await page.getByRole("button", { name: "Check these claims" }).click();
  await page.waitForURL(/\/app\/imports\/[0-9a-f-]{36}$/);
  for (let i = 0; i < 30 && !/Money at risk/.test(await text()); i++) { await page.waitForTimeout(2000); await page.reload(); }
  console.log("837 check →", (await text()).slice(0, 600));
  if (shots) await page.screenshot({ path: `${shots}/check-batch.png`, fullPage: true });
  await page.goto(`${base}/app/check`);
  console.log("hub →", (await text()).slice(0, 400));
  if (shots) await page.screenshot({ path: `${shots}/check-hub.png`, fullPage: true });
}

/** Phase 6: draft a letter from a denied claim, edit, approve, download, mark sent. */
async function appealsFlow(page: import("playwright").Page) {
  const shots = process.env.SMOKE_SHOTS;
  const text = async () => (await page.locator("main").innerText()).replace(/\s+/g, " ");
  const settle = async () => { await page.waitForLoadState("load"); await page.waitForTimeout(1500); };
  await page.goto(`${base}/app/claims?status=denied`);
  const hit = page.locator("td a.bg-amber-50").first(); // a denied claim with a ClaimHive rule match
  await (await hit.count() ? hit : page.locator("tbody a").first()).click();
  await page.waitForURL(/\/app\/claims\/[0-9a-f-]{36}$/);
  await settle();
  if (!(await page.locator("input[name=enclosures]:checked").count())) await page.locator("input[name=enclosures]").first().check();
  if (shots) await page.screenshot({ path: `${shots}/appeal-request.png`, fullPage: true });
  await page.getByRole("button", { name: "Draft the letter" }).click();
  await page.waitForURL(/\/app\/appeals\/[0-9a-f-]{36}$/);
  for (let i = 0; i < 30 && !(await page.locator("textarea[name=body]").count()); i++) { await page.waitForTimeout(2000); await page.reload(); }
  console.log("letter →", (await text()).slice(0, 900));
  await page.fill("textarea[name=recipient]", "Appeals Department\nPO Box 1000\nSpringfield, IL 62701");
  const body = page.locator("textarea[name=body]");
  await body.fill((await body.inputValue()).replace("Sincerely,", "Thank you for your prompt review.\n\nSincerely,"));
  await page.getByRole("button", { name: "Save changes" }).click();
  await settle();
  if (shots) await page.screenshot({ path: `${shots}/appeal-draft.png`, fullPage: true });
  await page.getByRole("button", { name: /Approve version/ }).click();
  await settle();
  await page.reload();
  console.log("approved →", (await text()).slice(0, 300));
  const pdf = await page.request.get(page.url().replace("/app/appeals/", "/api/appeals/") + "/pdf");
  const bytes = await pdf.body();
  console.log("pdf", pdf.status(), pdf.headers()["content-type"], bytes.length, "bytes");
  if (shots) {
    const fs = await import("node:fs");
    fs.writeFileSync(`${shots}/appeal.pdf`, bytes);
    await page.screenshot({ path: `${shots}/appeal-approved.png`, fullPage: true });
  }
  await page.getByRole("button", { name: "I've sent it to the insurer" }).click();
  await settle();
  await page.goto(`${base}/app/appeals`);
  console.log("appeals →", (await text()).slice(0, 500));
  if (shots) await page.screenshot({ path: `${shots}/appeals.png`, fullPage: false });
}

/** Phase 7 (staff): build last month's drafts, review the demo practice's draft, issue it, export for QuickBooks. */
async function adminBillingFlow(page: import("playwright").Page) {
  const shots = process.env.SMOKE_SHOTS;
  const text = async () => (await page.locator("main").innerText()).replace(/\s+/g, " ");
  const { prisma } = await import("../../src/lib/db");
  const demo = await prisma().membership.findFirstOrThrow({ where: { user: { email: "owner@demo.claimhive.test" } }, select: { practiceId: true } });
  await page.goto(`${base}/admin/billing`);
  await page.getByRole("button", { name: "Build or refresh drafts" }).click();
  await page.waitForURL(/msg=/);
  console.log("drafts →", (await text()).slice(0, 400));
  if (shots) await page.screenshot({ path: `${shots}/admin-billing.png`, fullPage: false });
  await page.locator(`a[href^="/admin/billing/${demo.practiceId}/"]`).first().click();
  await page.waitForURL(/\/admin\/billing\/[0-9a-f-]{36}\/[0-9a-f-]{36}/);
  console.log("draft →", (await text()).slice(0, 500));
  if (shots) await page.screenshot({ path: `${shots}/admin-draft.png`, fullPage: false });
  await page.getByRole("button", { name: "Issue statement" }).click();
  await page.waitForURL(/msg=/);
  console.log("issued →", (await text()).slice(0, 200));
  const month = new URL(page.url()).pathname && (await page.locator('a[href^="/admin/billing?month="]').first().getAttribute("href"))!.split("=")[1];
  const qbo = await page.request.get(`${base}/api/admin/billing/quickbooks?month=${month}`);
  const body = await qbo.text();
  console.log("quickbooks", qbo.status(), body.split("\r\n").filter(Boolean).length - 1, "rows;", body.split("\r\n")[0]);
}

/** Phase 7 (practice): see the rate, the accruing estimate and the issued statement; download it. */
async function practiceBillingFlow(page: import("playwright").Page) {
  const shots = process.env.SMOKE_SHOTS;
  const text = async () => (await page.locator("main").innerText()).replace(/\s+/g, " ");
  await page.goto(`${base}/app/billing`);
  console.log("billing →", (await text()).slice(0, 600));
  if (shots) await page.screenshot({ path: `${shots}/billing.png`, fullPage: true });
  const link = page.locator('a[href^="/app/billing/"]').first();
  if (!(await link.count())) throw new Error("no issued statement for the demo practice");
  await link.click();
  await page.waitForURL(/\/app\/billing\/[0-9a-f-]{36}$/);
  if (shots) await page.screenshot({ path: `${shots}/statement.png`, fullPage: false });
  const pdf = await page.request.get(page.url().replace("/app/billing/", "/api/billing/statements/") + "?format=pdf");
  console.log("statement pdf", pdf.status(), (await pdf.body()).length, "bytes");
  if (shots) (await import("node:fs")).writeFileSync(`${shots}/statement.pdf`, await pdf.body());
}

/** Phase 8: the owner's setup checklist and the 12-month report (page + PDF). */
async function setupFlow(page: import("playwright").Page) {
  const shots = process.env.SMOKE_SHOTS;
  const text = async () => (await page.locator("main").innerText()).replace(/\s+/g, " ");
  await page.goto(`${base}/app/setup`);
  console.log("setup →", (await text()).slice(0, 700));
  if (shots) await page.screenshot({ path: `${shots}/setup.png`, fullPage: true });
  await page.goto(`${base}/app/report`);
  console.log("report →", (await text()).slice(0, 700));
  if (shots) await page.screenshot({ path: `${shots}/report.png`, fullPage: false });
  const pdf = await page.request.get(`${base}/api/reports/opportunity`);
  console.log("report pdf", pdf.status(), (await pdf.body()).length, "bytes");
  if (shots) (await import("node:fs")).writeFileSync(`${shots}/report.pdf`, await pdf.body());
  await page.goto(`${base}/app/setup`);
  console.log("setup after →", (await text()).slice(0, 200));
  const health = await page.request.get(`${base}/api/health`);
  console.log("health", health.status(), await health.text());
}

/** Reason codes: search, and follow a code link from a denied claim. */
async function codesFlow(page: import("playwright").Page) {
  const shots = process.env.SMOKE_SHOTS;
  const text = async () => (await page.locator("main").innerText()).replace(/\s+/g, " ");
  await page.goto(`${base}/app/codes`);
  if (shots) await page.screenshot({ path: `${shots}/codes.png`, fullPage: false });
  await page.fill("input[name=q]", "x-ray");
  await page.getByRole("button", { name: "Search" }).click();
  await page.waitForURL(/q=x-ray/);
  console.log("search x-ray →", (await text()).slice(0, 400));
  if (shots) await page.screenshot({ path: `${shots}/codes-search.png`, fullPage: false });
  await page.goto(`${base}/app/claims?status=denied`);
  await page.locator("tbody a").first().click();
  await page.waitForURL(/\/app\/claims\/[0-9a-f-]{36}$/);
  const code = page.locator('a[href^="/app/codes?q="]').first();
  console.log("claim code link:", await code.innerText(), await code.getAttribute("href"));
  await code.click();
  await page.waitForURL(/\/app\/codes/);
  await page.waitForTimeout(800);
  console.log("followed →", (await text()).slice(0, 300));
  if (shots) await page.screenshot({ path: `${shots}/codes-from-claim.png`, fullPage: false });
}

main().catch((e) => { console.error(e); process.exit(1); });
