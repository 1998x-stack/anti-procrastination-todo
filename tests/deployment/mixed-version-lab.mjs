#!/usr/bin/env node
/**
 * GOTCHA-026 reproducible experiment: can a browser end up running modules from
 * TWO DIFFERENT releases?
 *
 * Everything here runs against the REAL staging nginx origin and REAL deploy
 * scripts. The only synthetic part is a marker comment appended to published
 * files so that "which release did this byte come from" is observable, plus (in
 * part 2) an orchestrated SELECTION of which real release directory a module is
 * served from. No product code is fabricated: part 2 changes only the value of
 * `emptyState().schemaVersion` in one release to create a version skew, which is
 * exactly the shape of a real cross-release schema change.
 *
 * Part 1: hold the main.js request while a real deploy switches `current`, then
 *         let it through. Report which release each resource came from.
 * Part 2: serve index/main/store/invariants from release A and core.js from
 *         release B where B's schema differs. Observe whether the app fails
 *         closed, whether it silently wipes data, and what the user sees.
 *
 * Usage (never point SF_* at the live deployment root):
 *   SF_URL=http://127.0.0.1:18081 MIX_SHIM=<shim repo with .git> \
 *     node tests/deployment/mixed-version-lab.mjs
 */
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ORIGIN = process.env.SF_URL;
const SHIM = process.env.MIX_SHIM;
const ROOT = process.env.SF_DEPLOY_ROOT;
if (!ORIGIN || !SHIM || !ROOT) { console.error("set SF_URL, MIX_SHIM, SF_DEPLOY_ROOT"); process.exit(2); }
if (ROOT === "/home/ubuntu/apps/start-first") { console.error("REFUSING to experiment on the live deployment root"); process.exit(2); }

const results = [];
const record = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? "  -> " + detail : ""}`);
};

/** Append a marker to every published file so its origin release is visible. */
function mark(marker) {
  appendFileSync(join(SHIM, "code/frontend/main.js"), `\n// MIXMARK-${marker}\n`);
  appendFileSync(join(SHIM, "code/domain/core.js"), `\n// MIXMARK-${marker}\n`);
  appendFileSync(join(SHIM, "code/frontend/styles.css"), `\n/* MIXMARK-${marker} */\n`);
  // The marker must live INSIDE documentElement: a trailing comment after
  // </html> becomes a child of the Document and is invisible to
  // documentElement.outerHTML (learned the hard way on this lab's first runs).
  const indexPath = join(SHIM, "index.html");
  writeFileSync(indexPath, readFileSync(indexPath, "utf8").replace("</body>", `<!-- MIXMARK-${marker} --></body>`));
}
function deploy() {
  // SF_REPO_ROOT MUST be removed: an inherited value would make deploy.sh
  // publish the reviewed checkout instead of this shim, so the markers would
  // never appear (this happened on the first run of this lab).
  const env = { ...process.env };
  delete env.SF_REPO_ROOT;
  const out = execFileSync("bash", ["deploy/deploy.sh"], { cwd: SHIM, encoding: "utf8", env });
  const active = /ACTIVE: (\S+)/.exec(out);
  if (!active) throw new Error("deploy did not report an active release:\n" + out);
  return active[1];
}
const releases = () => readdirSync(join(ROOT, "releases")).sort();
const served = async (path) => (await fetch(ORIGIN + path)).text();

// ---------------------------------------------------------------------------
console.log("== part 1: is a cross-release mix reachable while a deploy is in flight? ==");
mark("A");
const REL_A = deploy();
console.log(`  release A = ${REL_A}`);

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();

let holdMain;
const mainHeld = new Promise(resolve => { holdMain = resolve; });
let releaseMain;
const mainGate = new Promise(resolve => { releaseMain = resolve; });

let htmlRelease = null;
await page.route("**/code/frontend/main.js", async route => {
  holdMain();
  await mainGate;                       // held until the deploy has switched current
  await route.continue();
});

await page.goto(ORIGIN + "/", { waitUntil: "commit" });
await mainHeld;                          // HTML parsed, module request in flight
// The parser finishes while the module request is held (defer only delays
// DOMContentLoaded), so wait for the document to contain release A's marker.
await page.waitForFunction(() => document.documentElement.outerHTML.includes("MIXMARK-A"), null, { timeout: 10000 })
  .catch(() => {});
const htmlNow = await page.content();
htmlRelease = htmlNow.includes("MIXMARK-A") ? "A" : "?";
record("HTML in the document came from release A", htmlRelease === "A",
  `screen=${await page.evaluate(() => document.querySelector("#app")?.dataset.screen ?? "unbooted")}`);

mark("B");
const REL_B = deploy();
console.log(`  release B = ${REL_B} (deployed while main.js was in flight)`);
record("deploy really switched current", REL_B !== REL_A, `${REL_A} -> ${REL_B}`);

releaseMain();                           // now the browser fetches main.js
await page.waitForFunction(() => document.querySelector("#app")?.dataset.screen === "inbox", null, { timeout: 15000 })
  .catch(() => {});
const mainSrc = await served("/code/frontend/main.js");
const coreSrc = await served("/code/domain/core.js");
const cssSrc = await served("/code/frontend/styles.css");
record("the same document then executed main.js from release B", mainSrc.includes("MIXMARK-B") && htmlRelease === "A",
  `document HTML=release ${htmlRelease}, main.js=release ${mainSrc.includes("MIXMARK-B") ? "B" : "A"}, core.js=release ${coreSrc.includes("MIXMARK-B") ? "B" : "A"}, styles.css=release ${cssSrc.includes("MIXMARK-B") ? "B" : "A"}`);
record("the app still booted after the mix (these two releases are interface-compatible)",
  await page.evaluate(() => document.querySelector("#app")?.dataset.screen === "inbox"));

// Verify the marker actually shipped inside each release created by this run.
const inRelease = (rel, file, marker) => {
  const f = join(ROOT, "releases", rel, file);
  return existsSync(f) && readFileSync(f, "utf8").includes(`MIXMARK-${marker}`);
};
console.log(`  release of marker A = ${REL_A} (index.html marker present: ${inRelease(REL_A, "index.html", "A")}), marker B = ${REL_B}`);
record("the mixed state really spans two different release directories", REL_A !== REL_B);
record("release B was published with its own marker", inRelease(REL_B, "code/frontend/main.js", "B"));

// ---------------------------------------------------------------------------
console.log("\n== part 2: what does an incompatible skew do to the user? ==");
// Release A is rewritten so that its persisted schema version differs from B's.
const CORE_A = join(ROOT, "releases", REL_A, "code/domain/core.js");
const original = readFileSync(CORE_A, "utf8");
const skewed = original.replace('schemaVersion: 1,', 'schemaVersion: 97,');
record("created a cross-release schema skew in release A's core.js", skewed !== original);
writeFileSync(CORE_A, skewed);

const page2 = await context.newPage();
// Serve everything from release B except core.js, which comes from release A:
// the exact shape the in-flight mix in part 1 can produce under a schema change.
await page2.route("**/code/domain/core.js", route => route.fulfill({ body: skewed, contentType: "application/javascript" }));
const pageErrors = [];
page2.on("pageerror", e => pageErrors.push(e.message));
await page2.goto(ORIGIN + "/", { waitUntil: "load" });
await page2.waitForTimeout(600);

const state2 = await page2.evaluate(async () => {
  const app = document.querySelector("#app");
  const notice = document.querySelector(".notice")?.textContent?.trim() ?? null;
  return {
    screen: app?.dataset.screen ?? null,
    hasCaptureInput: !!document.querySelector("#capture-input"),
    notice,
    errorNotice: !!document.querySelector(".notice.error")
  };
});
console.log("  observed:", JSON.stringify(state2));
// A schema skew must fail closed (no silent wipe, no bogus success) -- record
// what the user actually gets rather than asserting a preferred outcome.
record("skew did not crash the page with an unhandled error", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
record("skew is surfaced in the UI (fail closed, not silent)", state2.errorNotice || state2.notice !== null, JSON.stringify(state2.notice));
record("skew did not silently present a working app that cannot save", !(state2.hasCaptureInput && !state2.errorNotice));

// The user's tasks must survive: put one in, then re-check under the skew.
writeFileSync(CORE_A, original);
const page3 = await context.newPage();
await page3.goto(ORIGIN + "/");
await page3.getByLabel("今天最难开始的是什么？").fill("混版本数据保全检查");
await page3.locator("#capture-form button[type=submit]").click();
await page3.getByText("现在先看这一件事").waitFor({ timeout: 10000 });
const before = await page3.evaluate(async () => {
  const { IndexedStateStore } = await import("/code/persistence/store.js");
  const repo = new IndexedStateStore(); const s = await repo.read(); repo.close();
  return s.tasks.length;
});
await page3.route("**/code/domain/core.js", route => route.fulfill({ body: skewed, contentType: "application/javascript" }));
await page3.reload({ waitUntil: "load" });
await page3.waitForTimeout(500);
const after = await page3.evaluate(async () => {
  const { IndexedStateStore } = await import("/code/persistence/store.js");
  try {
    const repo = new IndexedStateStore(); const s = await repo.read(); repo.close();
    return { tasks: s.tasks.length, readError: null };
  } catch (error) { return { tasks: null, readError: error.message }; }
});
record("existing tasks were not wiped by the skew", (after.tasks ?? before) === before && before === 1,
  `before=${before} after=${JSON.stringify(after)}`);

await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} mixed-version observations recorded`);
if (failed.length) console.log("failing observations:\n" + failed.map(f => " - " + f.name).join("\n"));
console.log(`\nreleases created by this experiment: ${REL_A}, ${REL_B}`);
