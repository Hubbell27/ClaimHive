/**
 * ClaimHive Demo launcher (Windows installer; also runs on Linux/macOS for testing).
 *
 *   node launcher.mjs start [--no-browser]   set up on first run, then start and open the browser
 *   node launcher.mjs stop                   stop everything
 *   node launcher.mjs reset                  stop and delete the demo data (a fresh demo on next start)
 *   node launcher.mjs logins                 open the demo sign-in details
 *   node launcher.mjs status
 *
 * Synthetic data only. Everything runs on this PC and listens on 127.0.0.1 only:
 * a private PostgreSQL (port 55432), the web app (http://localhost:3100) and the
 * background worker. The demo's data and settings live in
 * %LOCALAPPDATA%\ClaimHive Demo (or CLAIMHIVE_DEMO_HOME).
 */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WIN = process.platform === "win32";
// Installed layout: <install>\launcher.mjs, <install>\app, <install>\pgsql\bin. From a checkout: desktop\..\ is the app.
const APP = process.env.CLAIMHIVE_APP_DIR || (fs.existsSync(path.join(HERE, "app", "package.json")) ? path.join(HERE, "app") : path.resolve(HERE, ".."));
const PGBIN = process.env.CLAIMHIVE_PGBIN || path.join(HERE, "pgsql", "bin");
const HOME = process.env.CLAIMHIVE_DEMO_HOME || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"), "ClaimHive Demo");
const PGDATA = path.join(HOME, "pgdata");
const LOGS = path.join(HOME, "logs");
const STATE = path.join(HOME, "state.json");
const RUN = path.join(HOME, "run.json");
const LOGINS = path.join(HOME, "Demo logins.txt");
const exe = (name) => path.join(PGBIN, WIN ? `${name}.exe` : name);
const bin = (rel) => path.join(APP, "node_modules", rel);
const NEXT = bin("next/dist/bin/next"), TSX = bin("tsx/dist/cli.mjs"), PRISMA = bin("prisma/build/index.js");

const say = (m) => console.log(`[ClaimHive Demo] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2));
const secret = (n = 24) => crypto.randomBytes(n).toString("base64url");

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, ...opts });
  if (r.status !== 0) {
    const log = path.join(LOGS, "setup-error.log");
    fs.appendFileSync(log, `\n$ ${path.basename(cmd)} ${args.join(" ")}\n${r.stdout ?? ""}\n${r.stderr ?? ""}\n${r.error ?? ""}\n`);
    throw new Error(`${path.basename(cmd)} ${args[0] ?? ""} failed (details in ${log})`);
  }
  return r.stdout ?? "";
}

async function freePort(preferred) {
  for (let p = preferred; p < preferred + 50; p++) {
    const ok = await new Promise((res) => {
      const s = net.createServer().once("error", () => res(false)).once("listening", () => s.close(() => res(true)));
      s.listen(p, "127.0.0.1");
    });
    if (ok) return p;
  }
  throw new Error(`no free port near ${preferred}`);
}

async function healthy(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch { return false; }
}

function appEnv(state) {
  const { pgPort, pw } = state;
  const db = (user, pass) => `postgresql://${user}:${encodeURIComponent(pass)}@127.0.0.1:${pgPort}/claimhive`;
  return {
    ...process.env,
    APP_ENV: "local", KEY_PROVIDER: "local", MASTER_KEY: state.masterKey, LOG_LEVEL: "warn", NEXT_TELEMETRY_DISABLED: "1",
    MIGRATION_DATABASE_URL: db("claimhive_owner", pw.owner),
    DATABASE_URL: db("claimhive_app", pw.app),
    POOL_DATABASE_URL: db("claimhive_pool", pw.pool),
    APP_DB_PASSWORD: pw.app, POOL_DB_PASSWORD: pw.pool,
    BILLING_ISSUER_NAME: "ClaimHive Inc. (demo)",
  };
}

function pgRunning() {
  if (!fs.existsSync(path.join(PGDATA, "PG_VERSION"))) return false;
  return spawnSync(exe("pg_ctl"), ["-D", PGDATA, "status"], { windowsHide: true }).status === 0;
}

function startPg() {
  if (pgRunning()) return;
  run(exe("pg_ctl"), ["-D", PGDATA, "-l", path.join(LOGS, "postgres.log"), "-w", "-t", "90", "start"]);
}

function stopPg() {
  if (pgRunning()) spawnSync(exe("pg_ctl"), ["-D", PGDATA, "-m", "fast", "-w", "-t", "60", "stop"], { windowsHide: true, stdio: "ignore" });
}

/** First run: private database, schema, demo data and sign-ins. Each step is safe to re-run. */
async function setup() {
  fs.mkdirSync(LOGS, { recursive: true });
  let state = readJson(STATE);
  if (!state) {
    state = { version: 1, pgPort: await freePort(55432), webPort: await freePort(3100), masterKey: crypto.randomBytes(32).toString("base64"),
      pw: { owner: secret(), app: secret(), pool: secret() }, steps: {} };
    writeJson(STATE, state);
  }
  const done = (k) => { state.steps[k] = new Date().toISOString(); writeJson(STATE, state); };

  if (!fs.existsSync(path.join(PGDATA, "PG_VERSION"))) {
    say("Creating the demo database (first run only)…");
    fs.rmSync(PGDATA, { recursive: true, force: true });
    const pwfile = path.join(HOME, ".pw");
    fs.writeFileSync(pwfile, state.pw.owner, { mode: 0o600 });
    try {
      run(exe("initdb"), ["-D", PGDATA, "-U", "claimhive_owner", `--pwfile=${pwfile}`, "-A", "scram-sha-256", "-E", "UTF8", "--no-locale"]);
    } finally { fs.rmSync(pwfile, { force: true }); }
    fs.appendFileSync(path.join(PGDATA, "postgresql.conf"),
      `\n# ClaimHive Demo\nlisten_addresses = '127.0.0.1'\nport = ${state.pgPort}\nmax_connections = 60\n`);
  }
  startPg();
  const env = appEnv(state);

  if (!state.steps.database) {
    const req = createRequire(path.join(APP, "package.json"));
    const pg = req("pg");
    const c = new pg.Client({ connectionString: env.MIGRATION_DATABASE_URL.replace(/\/claimhive$/, "/postgres") });
    await c.connect();
    const exists = await c.query("SELECT 1 FROM pg_database WHERE datname = 'claimhive'");
    if (!exists.rowCount) await c.query("CREATE DATABASE claimhive");
    await c.end();
    done("database");
  }
  if (!state.steps.migrated) {
    say("Setting up the database tables…");
    run(process.execPath, [PRISMA, "migrate", "deploy"], { cwd: APP, env });
    run(process.execPath, [TSX, "scripts/set-role-passwords.ts"], { cwd: APP, env });
    done("migrated");
  }
  if (!state.steps.seeded) {
    say("Loading synthetic demo data (a few minutes, first run only)…");
    const out = run(process.execPath, [TSX, "scripts/seed-synthetic.ts"], { cwd: APP, env, maxBuffer: 64 * 1024 * 1024 });
    const logins = [...out.matchAll(/^(owner|biller): (\S+)\s+temporary password: (\S+)\s+\(practice: ([^)]+)\)/gm)]
      .map((m) => ({ role: m[1], email: m[2], password: m[3], practice: m[4] }));
    const staff = run(process.execPath, [TSX, "scripts/create-admin.ts", "staff@demo.claimhive.test", "Demo Staff"], { cwd: APP, env });
    const staffPw = /\(shown once\): (\S+)/.exec(staff)?.[1];
    if (!logins.length || !staffPw) throw new Error("the demo data loaded, but the sign-in details weren't found");
    const url = `http://localhost:${state.webPort}`;
    fs.writeFileSync(LOGINS, [
      "ClaimHive Demo: sign-in details (synthetic data only)", "",
      `Open ${url}`, "",
      ...logins.map((l) => `${l.role === "owner" ? "Practice owner" : "Biller"} (${l.practice})\n  Email:    ${l.email}\n  Password: ${l.password}\n`),
      `ClaimHive staff (admin console: billing, readiness)\n  Email:    staff@demo.claimhive.test\n  Password: ${staffPw}\n`,
      "These passwords work once. On first sign-in you choose a new password and set up",
      "two-step sign-in with an authenticator app (Microsoft Authenticator, Google Authenticator,",
      "1Password...). Scan the code shown, then type the 6-digit number.", "",
      "Start menu → ClaimHive Demo → \"Reset ClaimHive demo data\" starts over with fresh logins.",
      "Every name, claim and dollar in the demo is made up.",
    ].join(WIN ? "\r\n" : "\n"));
    done("seeded");
  }
  return state;
}

function kill(pid) {
  if (!pid) return;
  if (WIN) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  else { try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } } }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function openUrl(url) {
  if (WIN) spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  else spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
}

async function start(openBrowser) {
  fs.mkdirSync(HOME, { recursive: true });
  const prev = readJson(RUN), st = readJson(STATE);
  if (prev && st && alive(prev.web) && await healthy(st.webPort)) {
    say(`Already running at http://localhost:${st.webPort}`);
    if (openBrowser) openUrl(`http://localhost:${st.webPort}`);
    return;
  }
  const state = await setup();
  const env = appEnv(state);
  const log = (n) => fs.openSync(path.join(LOGS, `${n}.log`), "a");
  const opts = { cwd: APP, env, windowsHide: true, detached: !WIN };
  const web = spawn(process.execPath, [NEXT, "start", "-H", "127.0.0.1", "-p", String(state.webPort)], { ...opts, stdio: ["ignore", log("web"), log("web")] });
  const worker = spawn(process.execPath, [TSX, "src/worker/index.ts"], { ...opts, stdio: ["ignore", log("worker"), log("worker")] });
  writeJson(RUN, { web: web.pid, worker: worker.pid, launcher: process.pid, startedAt: new Date().toISOString() });

  const url = `http://localhost:${state.webPort}`;
  say("Starting…");
  for (let i = 0; i < 120 && !(await healthy(state.webPort)); i++) {
    if (web.exitCode !== null) throw new Error(`the web app stopped (see ${path.join(LOGS, "web.log")})`);
    await sleep(1000);
  }
  if (!(await healthy(state.webPort))) throw new Error(`the web app didn't start (see ${path.join(LOGS, "web.log")})`);
  say(`Running at ${url}`);
  say(`Sign-in details: ${LOGINS}`);
  if (openBrowser) {
    openUrl(url);
    if (!state.steps.loginsShown) { openUrl(LOGINS); state.steps.loginsShown = new Date().toISOString(); writeJson(STATE, state); }
  }
  say("Close this window (or use \"Stop ClaimHive Demo\") to stop.");

  const shutdown = () => { say("Stopping…"); stop(); process.exit(0); };
  for (const s of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) process.on(s, shutdown);
  web.on("exit", (code) => { if (code !== null && code !== 0) { say(`The web app stopped unexpectedly (see ${path.join(LOGS, "web.log")}).`); shutdown(); } });
  await new Promise(() => {}); // stay up until closed
}

function stop() {
  const r = readJson(RUN);
  if (r) { kill(r.web); kill(r.worker); fs.rmSync(RUN, { force: true }); }
  stopPg();
  say("Stopped.");
}

async function main() {
  const [cmd = "start", ...flags] = process.argv.slice(2);
  switch (cmd) {
    case "start": return start(!flags.includes("--no-browser"));
    case "stop": return stop();
    case "reset": stop(); fs.rmSync(HOME, { recursive: true, force: true }); return say("Demo data deleted. The next start builds a fresh demo.");
    case "logins": return fs.existsSync(LOGINS) ? openUrl(LOGINS) : say("Start ClaimHive Demo once first; the sign-in details are created then.");
    case "status": { const st = readJson(STATE); const ok = st ? await healthy(st.webPort) : false; say(ok ? `Running at http://localhost:${st.webPort}` : "Not running."); return process.exit(ok ? 0 : 1); }
    default: say(`Unknown command "${cmd}". Use start, stop, reset, logins or status.`); process.exit(2);
  }
}

main().catch((e) => {
  say(`Problem: ${e.message}`);
  if (process.argv[2] !== "stop") stop();
  if (WIN && process.stdin.isTTY) { say("Press Enter to close."); process.stdin.once("data", () => process.exit(1)); } else process.exit(1);
});
