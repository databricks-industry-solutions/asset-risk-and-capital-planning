// End-to-end walkthrough of the ARMOR Capital Planner, as a utility capital planner would use it.
// Node 22 + Chrome CDP, no npm deps. Screenshots every step; fails on any console error or exception.
//   node smoke.mjs [url] [outdir]      (TOKEN env = bearer token for a deployed Databricks App; ONLY=ask runs just step 6)
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
const BASE = (process.argv[2] || "http://localhost:8770/").replace(/\/$/, "");
const OUT = process.argv[3] || "/tmp/armor_shots";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9335", `--user-data-dir=${mkdtempSync("/tmp/cs-")}`, "--window-size=1600,1000",
  "--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, id = 0; const pend = new Map(), errors = [], warns = [];
async function connect() { for (let k = 0; k < 40; k++) { try { const t = await (await fetch("http://127.0.0.1:9335/json")).json(); const p = t.find((x) => x.type === "page"); if (p) return p.webSocketDebuggerUrl; } catch {} await sleep(250); } throw new Error("no chrome"); }
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (e) => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; };
const shot = async (n) => { const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`${OUT}/${n}.png`, Buffer.from(r.data, "base64")); };
async function waitFor(expr, ms, label) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await ev(expr)) return; } catch {} await sleep(500); } throw new Error("timeout: " + label); }
const go = (path) => ev(`(() => { window.history.pushState({}, '', '${path}'); window.dispatchEvent(new PopStateEvent('popstate')); return true; })()`);
const click = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error('missing ${sel}'); e.click(); return true; })()`);
const text = (sel) => ev(`(document.querySelector(${JSON.stringify(sel)})||{}).innerText || ''`);
const flat = (s) => s.replace(/\n+/g, " | ");
const step = (s) => console.log("\n## " + s);
try {
  ws = new WebSocket(await connect()); await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (m) => { const d = JSON.parse(m.data);
    if (d.id && pend.has(d.id)) { pend.get(d.id)[d.error ? "rej" : "res"](d.error || d.result); pend.delete(d.id); }
    if (d.method === "Fetch.requestPaused") send("Fetch.continueRequest", { requestId: d.params.requestId, headers: [...Object.entries(d.params.request.headers).map(([name, value]) => ({ name, value })), { name: "Authorization", value: `Bearer ${process.env.TOKEN}` }] });
    if (d.method === "Runtime.exceptionThrown") errors.push("EXCEPTION " + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text).slice(0, 300));
    if (d.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(d.params.type)) (d.params.type === "error" ? errors : warns).push(d.params.args.map((a) => a.value ?? a.description).join(" ").slice(0, 300));
    if (d.method === "Log.entryAdded" && d.params.entry.level === "error") errors.push("LOG " + d.params.entry.text + " " + (d.params.entry.url || ""));
  };
  await send("Runtime.enable"); await send("Log.enable"); await send("Page.enable");
  if (process.env.TOKEN) await send("Fetch.enable", { patterns: [{ urlPattern: `${BASE}/*` }] });
  await send("Page.navigate", { url: BASE + "/" });
  await waitFor("!!window.__armorError || document.getElementById('status')?.dataset.ready === '1'", 600000, "engine ready");
  if (await ev("window.__armorError || ''")) throw new Error("load error: " + (await ev("window.__armorError")));

  if (process.env.ONLY !== "ask") {
  step("1. Service territory risk: all classes, then per class");
  await waitFor("!!document.querySelector('#wave .recharts-bar-rectangle') && !!document.querySelector('#anchors table')", 120000, "portfolio");
  await sleep(2000);
  console.log("all classes:", flat(await text("#portfolio-kpis")));
  console.log("info hovers on page:", await ev("document.querySelectorAll('#portfolio [aria-label=definition]').length"));
  await shot("w00_territory_all");
  for (const c of ["recloser", "transformer", "pole"]) {
    await ev(`window.__armorPortfolio.setCls('${c}')`); await sleep(2500);
    console.log(c + ":", flat(await text("#portfolio-kpis")));
  }
  console.log("anchors:", flat(await text("#anchors")));
  console.log("pareto:", flat(await ev("document.querySelector('#pareto').parentElement.innerText")).slice(-160));
  await shot("w01_portfolio"); await ev("document.getElementById('ages').scrollIntoView({block:'center'})"); await sleep(800); await shot("w02_portfolio_ages");
  await ev("document.getElementById('feeder-register').scrollIntoView()"); await sleep(800); await shot("w03_register");
  await waitFor("!!document.querySelector('#feeder-register tbody tr td.font-mono')", 60000, "feeder table");
  const topFeeder = (await ev("document.querySelector('#feeder-register tbody tr td.font-mono').innerText")).trim();
  console.log("riskiest feeder:", topFeeder);

  step("2. Risk map: zoomed-out feeder view, then click the riskiest feeder in the table");
  await go("/map"); await waitFor("!!window.__armorMap && !!document.getElementById('kpi-strip')", 240000, "map"); await sleep(5000);
  console.log("map kpis:", flat(await text("#kpi-strip")), "| feeder view:", await ev("window.__armorMap.aggregated"));
  await shot("w04_map");
  await go("/"); await waitFor("!!document.querySelector('#feeder-register tbody tr td.font-mono')", 60000, "register");
  await ev("document.querySelector('#feeder-register tbody tr td.font-mono').closest('tr').click()");
  await waitFor("!!document.getElementById('feeder-tray')", 60000, "feeder tray from table"); await sleep(3500);
  console.log("feeder tray:", flat(await text("#feeder-tray")).slice(0, 220));
  await shot("w05_feeder_tray");
  await ev("window.__armorMap.setColorBy('matrix')"); await sleep(2500);
  console.log("risk matrix counts (top row = most likely):", JSON.stringify(await ev("window.__armorMap.matrixCounts && window.__armorMap.matrixCounts.slice().reverse()")));
  await shot("w05b_matrix");
  await ev("document.querySelector('#risk-matrix [data-cell=\"4-4\"]').click()"); await sleep(2000);
  console.log("top-right matrix cell:", flat(await text("#kpi-strip")));
  await shot("w05c_matrix_cell");
  await ev("window.__armorMap.setCell(null); window.__armorMap.setColorBy('risk')"); await sleep(1500);
  const worst = await ev("window.__armorMap.topPole()");
  let t0 = Date.now();
  await ev(`window.__armorMap.openAsset(${JSON.stringify(worst)})`);
  await waitFor("(document.getElementById('asset-body')||{}).innerText?.includes('Consequence')", 60000, "asset");
  console.log(`asset drawer opened in ${Date.now() - t0} ms`); await sleep(1500);
  console.log("asset:", worst, "| chain:", flat(await text("#risk-chain")));
  // more clicks: how long a pole's drawer takes to fill, from click to content (point lookups)
  const others = await ev("(() => { const ids = []; for (const k of [11, 2222, 33333, 77777]) { const id = window.__armorMap.idAt?.(k); if (id) ids.push(id); } return ids; })()");
  for (const id of others) {
    await ev("window.__armorMap.openAsset(null)"); await sleep(300);
    // timed in the page: from the click to the drawer showing its content (10 ms polling)
    const ms = await ev(`new Promise((done) => { const t0 = performance.now(); window.__armorMap.openAsset(${JSON.stringify(id)});
      const h = setInterval(() => { const b = document.getElementById('asset-body'); if (b && b.innerText.includes('Forecast if nothing is done')) { clearInterval(h); done(Math.round(performance.now() - t0)); } }, 10);
      setTimeout(() => { clearInterval(h); done(-1); }, 30000); })`);
    console.log(`asset drawer ${id}: ${ms} ms`);
  }
  await ev(`window.__armorMap.openAsset(${JSON.stringify(worst)})`); await sleep(1500);
  console.log("drawer mentions 'demo':", await ev("document.getElementById('asset-body').innerText.toLowerCase().includes('demo')"));
  await shot("w06_asset");
  await ev("document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))"); await sleep(600);
  await ev(`window.__armorMap.setFeeders(new Set()); window.__armorMap.setTray(null); window.__armorMap.selectAround(${JSON.stringify(topFeeder)})`); await sleep(3500);
  console.log("area selection:", flat(await text("#kpi-strip")));
  await shot("w07_selection");
  await ev("[...document.querySelectorAll('#kpi-strip button')].find(b => b.innerText.includes('Save')).click()"); await sleep(500);
  await ev("[...document.querySelectorAll('#kpi-strip button')].find(b => b.innerText.includes('Plan this')).click()");

  step("3a. Plan: just the selected area");
  await waitFor("!!document.getElementById('plan-kpis')", 180000, "area plan"); await sleep(2000);
  console.log("area plan:", flat(await text("#plan-kpis")));
  await shot("w08_plan_area");
  await ev("[...document.querySelectorAll('#plan button')].find(b => b.innerText === 'clear').click()");
  await sleep(1500); await waitFor("!window.__armorPlan.busy && !!document.getElementById('plan-kpis')", 180000, "fleet plan");

  step("3b. Plan: whole fleet at $15M/yr, then $25M/yr, then the full-budget strategy");
  await sleep(1500); console.log("$15M:", flat(await text("#plan-kpis")));
  await shot("w09_plan"); await ev("document.getElementById('outcome-chart').scrollIntoView({block:'center'})"); await sleep(1000); await shot("w10_plan_charts");
  await waitFor("!!document.querySelector('#frontier .recharts-line')", 300000, "frontier");
  await ev("document.getElementById('frontier').scrollIntoView({block:'center'})"); await sleep(1500); await shot("w11_plan_map_frontier");
  await ev("window.__armorPlan.setBudget(25e6)"); await sleep(1500); await waitFor("!window.__armorPlan.busy", 180000, "25M"); await sleep(1500);
  console.log("$25M:", flat(await text("#plan-kpis")));
  await ev("window.__armorPlan.setStrategy('value_full')"); await sleep(1500); await waitFor("!window.__armorPlan.busy && !!document.getElementById('plan-kpis')", 300000, "full budget"); await sleep(1500);
  console.log("$25M full budget:", flat(await text("#plan-kpis")), "| strategy:", await text("#strategy"));
  await ev("document.getElementById('capital-chart').scrollIntoView({block:'center'})"); await sleep(1000); await shot("w12_plan_full_budget");
  await ev("window.__armorPlan.save('Full budget at $25M')"); await sleep(300);
  await ev("window.__armorPlan.setStrategy('value')"); await sleep(1500); await waitFor("!window.__armorPlan.busy", 300000, "back to value");
  await ev("window.__armorPlan.setBudget(15e6)"); await sleep(1500); await waitFor("!window.__armorPlan.busy", 180000, "15M again"); await sleep(1500);
  await ev("document.getElementById('work-plan').scrollIntoView()"); await sleep(1000);
  console.log("work plan:", flat(await ev("document.querySelector('#work-plan').innerText")).slice(0, 300));
  await shot("w13_work_plan");

  step("3c. Plan over time: year strip, map time slider, project on the map");
  await ev("document.getElementById('year-strip').scrollIntoView({block:'start'})"); await sleep(500);
  await click("#year-tile-2"); await sleep(1200);
  console.log("year 2 tile:", flat(await text("#year-tile-2")), "| view:", JSON.stringify(await ev("window.__armorPlan.view")));
  if ((await ev("window.__armorPlan.view.year")) !== 2) errors.push("year tile did not set the plan year");
  await ev("document.getElementById('plan-timeline').scrollIntoView({block:'center'})"); await sleep(1500); await shot("w13b_plan_year2");
  await ev("document.querySelector('#project-rows tr').click()"); await sleep(2500);
  const pj = await ev("window.__armorPlan.project && window.__armorPlan.project.project_id");
  console.log("project picked:", pj, "| map title:", flat(await ev("document.querySelector('#plan-timeline').parentElement.innerText")).slice(0, 80));
  if (!pj) errors.push("work-plan row did not pick a project");
  await shot("w13c_project_on_map");
  await click("#plan-timeline-play"); await sleep(3000); await click("#plan-timeline-play");
  console.log("after play:", JSON.stringify(await ev("window.__armorPlan.view")));
  await ev("window.__armorPlan.setView({year: null, mode: 'in'})"); await sleep(500);
  console.log("bundling control:", await ev("document.getElementById('bundle-by').dataset.off ? 'off: ' + document.getElementById('bundle-by').innerText : document.getElementById('bundle-by').innerText"));
  console.log("status:", await text("#solve-status"));

  await ev("window.__armorPlan.save('Max value at $15M')"); await sleep(300);
  console.log("saved plans:", await ev("JSON.parse(localStorage.getItem('armor.savedPlans')).map(p => p.name + ' [' + p.ids.length + ']').join('; ')"));

  step("4. Compare strategies (with saved plans), then use one in Plan");
  await go("/compare"); await waitFor("!!document.getElementById('cp-run')", 30000, "compare"); await click("#cp-run");
  await waitFor("!!document.getElementById('cp-totals')", 300000, "strategies"); await sleep(2500);
  console.log("compare:", await text("#cp-msg")); console.log("totals:", flat(await text("#cp-totals")).slice(0, 900));
  console.log("badges:", flat(await ev("[...document.querySelectorAll('#cp-cards [data-card]')].map(c => c.dataset.card + ': ' + [...c.querySelectorAll('.rounded-full, [class*=badge]')].map(b => b.innerText).join('/')).join(' ; ')")));
  await shot("w14_compare");
  await click("#cp-sim"); await waitFor("!document.querySelector('#cp-sim').disabled", 600000, "uncertainty"); await sleep(1500);
  await ev("document.getElementById('cp-cards').scrollIntoView({block:'start'})"); await sleep(800); await shot("w14b_compare_cards");
  console.log("saved rows in totals:", await ev("[...document.querySelectorAll('#cp-totals tbody tr')].filter(r => r.innerText.includes('(saved)')).length"));
  await click('[data-open="reliability"]'); await sleep(1500); await waitFor("!window.__armorPlan.busy && !!document.getElementById('plan-kpis') && document.getElementById('strategy').innerText.includes('outage')", 180000, "strategy in plan"); await sleep(2000);
  console.log("plan strategy:", await text("#strategy"), "| rule:", await text("#strategy-rule"), "| kpis:", flat(await text("#plan-kpis")).slice(0, 260));
  await shot("w14c_strategy_in_plan");
  await go("/map?color=plan"); await waitFor("!!document.getElementById('kpi-strip')", 60000, "map"); await sleep(2500);
  console.log("map plan picker:", await text("#map-plan-pick")); await shot("w14d_map_plan_picker");

  step("4b. Risk map over time: today, then the projected years of the plan");
  await ev("window.__armorMap.setColorBy('risk')"); await sleep(800);
  const today = flat(await text("#kpi-strip")); console.log("today:", today.slice(0, 220));
  await ev("window.__armorMap.setYear(1)"); await waitFor("window.__armorMap.projected && !window.__armorMap.futBusy", 180000, "projection"); await sleep(2000);
  console.log("banner:", flat(await text("#future-banner")));
  console.log("year 1:", flat(await text("#kpi-strip")).slice(0, 420)); await shot("w14e_map_year1");
  await ev("window.__armorMap.setYear(10)"); await sleep(2500);
  console.log("year 10:", flat(await text("#kpi-strip")).slice(0, 420)); await shot("w14f_map_year10");
  await click("#back-to-today"); await sleep(1500);
  console.log("back to today, banner gone:", !(await ev("!!document.getElementById('future-banner')")));
  await go("/plan"); await sleep(800); await ev("window.__armorPlan.setStrategy('value')"); await sleep(1500); await waitFor("!window.__armorPlan.busy", 180000, "value again");

  step("5. Curves and data model");
  await go("/curves"); await waitFor("document.querySelectorAll('#curve-cards > *').length > 2", 60000, "curves"); await sleep(1500); await shot("w15_curves");
  await ev("document.getElementById('failure-share').scrollIntoView({block:'center'})"); await sleep(800);
  console.log("share windows:", flat(await text("#share-windows"))); await shot("w15b_failure_share");
  await go("/data"); await waitFor("!!document.getElementById('features')", 30000, "data"); await sleep(800); await shot("w16_data");
  await go("/docs"); await sleep(800); await shot("w17_docs");
  }

  step("6. Ask Genie: a sample question, answered with SQL and a result");
  await go("/ask"); await waitFor("!!document.getElementById('ask')", 30000, "ask page"); await sleep(1500);
  if (await ev("!!document.getElementById('ask-suggestions')")) {
    console.log("sample question:", await ev("document.querySelector('#ask-suggestions button').innerText"));
    await click("#ask-suggestions button");
    // answered: the SQL is shown with its result (a chart tab or a table), and the input is enabled again
    await waitFor("(!!document.querySelector('#ask pre') && !!document.querySelector('#ask table, #ask canvas, #ask svg.recharts-surface, #ask [role=tablist]') && !document.querySelector('#ask textarea')?.disabled) || !!document.querySelector('#ask .text-destructive')", 300000, "genie answer");
    await sleep(2000);
    const err = await ev("document.querySelector('#ask .text-destructive')?.innerText || ''");
    if (err) errors.push("Genie: " + err);
    console.log("answer:", flat(await ev("document.getElementById('ask').innerText")).slice(0, 700));
    await shot("w18_ask");
  } else console.log("Ask: no Genie space configured:", flat(await text("#ask")).slice(0, 200));
} catch (e) {
  errors.push("TEST FAILURE: " + e.message);
  try { await shot("failure"); console.log("page at failure:", flat(await ev("document.querySelector('main')?.innerText || ''")).slice(0, 900)); } catch {}
}
console.log("\nwarnings:", warns.length ? "\n  " + [...new Set(warns)].slice(0, 6).join("\n  ") : "none");
console.log("ERRORS:", errors.length ? "\n  " + [...new Set(errors)].slice(0, 15).join("\n  ") : "none");
chrome.kill(); process.exit(errors.length ? 1 : 0);
