// app.js (ESM)
import { Scanner, parseGS1ForGTIN14, normalizeJan13 } from "./scan.js";

/* -----------------------------
   Build / constants
------------------------------ */
const BUILD = "poc-2026-01-21";
const TOAST_MS = 5400;
const LS_KEY = "linqval_proto_state_v1";

/* -----------------------------
   Tiny helpers
------------------------------ */
const $ = (sel) => document.querySelector(sel);
const nowIso = () => new Date().toISOString();
const jpy = (n) => (Number(n || 0)).toLocaleString("ja-JP");

function safeJsonParse(s, fallback){
  try { return JSON.parse(s); } catch { return fallback; }
}
function uid(prefix="ID"){
  return `${prefix}-${Math.random().toString(16).slice(2,10)}-${Date.now().toString(36)}`;
}
function copyToClipboard(text){
  return navigator.clipboard?.writeText(text);
}
function setHash(path){
  location.hash = `#${path}`;
}
function getHashPath(){
  return (location.hash || "#/home").slice(1);
}
function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

/* -----------------------------
   CSV parsing (simple, robust enough)
------------------------------ */
function parseCsvLine(line){
  // supports quotes + commas
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i=0;i<line.length;i++){
    const ch = line[i];
    if (ch === '"'){
      if (inQ && line[i+1] === '"'){ cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === "," && !inQ){
      out.push(cur); cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}
function csvToObjects(csvText){
  const lines = String(csvText || "").split(/\r?\n/).filter(x => x.trim().length);
  if (!lines.length) return [];
  const header = parseCsvLine(lines[0]).map(h => h.trim());
  const rows = [];
  for (let i=1;i<lines.length;i++){
    const cols = parseCsvLine(lines[i]);
    const obj = {};
    header.forEach((h, idx) => obj[h] = (cols[idx] ?? "").trim());
    rows.push(obj);
  }
  return rows;
}

/* -----------------------------
   Split dictionary fetch
   - dict_jan/<jan3>/<jan4>.csv
   - gtin_index/<gt3>/<gt4>.csv  (should contain at least gtin14 -> jan13)
------------------------------ */
async function fetchText(url){
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`fetch failed ${res.status} ${url}`);
  return await res.text();
}

function buildJanPaths(jan13){
  const jan3 = jan13.slice(0,3);
  const jan4 = jan13.slice(0,4);
  return {
    url: `./dict_jan/${jan3}/${jan4}.csv`,
    jan3, jan4
  };
}
function buildGtinPaths(gtin14){
  const gt3 = gtin14.slice(0,3);
  const gt4 = gtin14.slice(0,4);
  // note: you used "gtin_index/049/0490.csv" in your summary
  // We'll implement as: gtin_index/<gt3>/<gt4>.csv
  return {
    url: `./gtin_index/${gt3}/${gt4}.csv`,
    gt3, gt4
  };
}

async function lookupByJan13(jan13){
  const { url } = buildJanPaths(jan13);
  try {
    const csv = await fetchText(url);
    const rows = csvToObjects(csv);

    // flexible column names: try multiple keys
    const keyCandidates = ["jan13", "JAN13", "jan", "JAN", "code", "barcode"];
    const hit = rows.filter(r => keyCandidates.some(k => r[k] === jan13));

    if (!hit.length) return { status: "no_match", jan13, rowsChecked: rows.length };
    // pick first hit; if multiple hits exist, keep them for later expansion
    return { status: "hit", jan13, items: hit };
  } catch (e) {
    return { status: "dict_fetch_error", jan13, error: e.message };
  }
}

async function lookupJanFromGtin14(gtin14){
  const { url } = buildGtinPaths(gtin14);
  try {
    const csv = await fetchText(url);
    const rows = csvToObjects(csv);

    const gtKeyCandidates = ["gtin14", "GTIN14", "gtin", "GTIN", "01", "ai01"];
    const janKeyCandidates = ["jan13", "JAN13", "jan", "JAN"];
    const found = rows.find(r => gtKeyCandidates.some(k => r[k] === gtin14));

    if (!found) return { status: "no_match", gtin14, rowsChecked: rows.length };

    const jan13 = janKeyCandidates.map(k => found[k]).find(v => String(v||"").match(/^\d{13}$/));
    if (!jan13) return { status: "no_match", gtin14, note: "gtin matched but jan13 missing in row" };

    return { status: "hit", gtin14, jan13 };
  } catch (e) {
    return { status: "dict_fetch_error", gtin14, error: e.message };
  }
}

function mapDictRowToDisplay(row){
  // Try known columns; fallback to any available.
  const pick = (...keys) => keys.map(k => row[k]).find(v => String(v||"").trim().length);
  const product_name = pick("product_name","商品名","name","商品名称");
  const manufacturer_name = pick("manufacturer_name","メーカー","maker","製造販売業者");
  const product_no = pick("product_no","製品番号","品番","型番");
  const product_sta = pick("product_sta","規格","spec","規格・サイズ");
  const tokutei_name = pick("tokutei_name","償還名称","特定材名称","特定保険医療材料名称");
  const price = pick("total_reimbursement_price_yen","償還価格合計","price","償還価格");
  return {
    product_name: product_name || "(名称不明)",
    manufacturer_name: manufacturer_name || "",
    product_no: product_no || "",
    product_sta: product_sta || "",
    tokutei_name: tokutei_name || "",
    total_reimbursement_price_yen: price ? Number(String(price).replace(/[^\d]/g,"")) : 0
  };
}

/* -----------------------------
   App state
------------------------------ */
function defaultState(){
  return {
    build: BUILD,
    role: "field",              // field | billing | docs
    integrationStage: 0,        // 0..3
    activeCaseId: null,
    cases: [],                  // will be loaded + merged
    audit: []                   // global audit
  };
}

function loadState(){
  const s = safeJsonParse(localStorage.getItem(LS_KEY), null);
  if (!s) return defaultState();
  return { ...defaultState(), ...s };
}
function saveState(){
  localStorage.setItem(LS_KEY, JSON.stringify(state));
}

let state = loadState();

/* -----------------------------
   Load demo data (optional)
------------------------------ */
async function loadDemoData(){
  try {
    const cases = await (await fetch("./data/cases.json", { cache:"no-store" })).json();
    if (Array.isArray(cases) && cases.length){
      // merge by case_id (do not overwrite local changes)
      const byId = new Map(state.cases.map(c => [c.case_id, c]));
      for (const c of cases){
        if (!byId.has(c.case_id)) byId.set(c.case_id, c);
      }
      state.cases = Array.from(byId.values());
      if (!state.activeCaseId) state.activeCaseId = state.cases[0]?.case_id || null;
      saveState();
    }
  } catch {
    // demo data not required
  }
}

/* -----------------------------
   Audit log
------------------------------ */
function pushAudit(event, payload = {}){
  const entry = {
    ts: nowIso(),
    event,
    case_id: state.activeCaseId,
    payload,
    actor: { role: state.role, id: state.role === "field" ? "N-01" : state.role === "billing" ? "B-01" : "D-01" },
    device: { ua: navigator.userAgent, app_ver: BUILD }
  };
  state.audit.push(entry);
  // also store into case audit
  const c = getActiveCase();
  if (c){
    c.audit = c.audit || [];
    c.audit.push(entry);
  }
  saveState();
}

/* -----------------------------
   Toast
------------------------------ */
let toastTimer = null;
function showToast(title, sub){
  $("#toastTitle").textContent = title;
  $("#toastSub").textContent = sub || "";
  $("#toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("#toast").classList.remove("show"), TOAST_MS);
}

/* -----------------------------
   Case helpers
------------------------------ */
function getActiveCase(){
  return state.cases.find(c => c.case_id === state.activeCaseId) || null;
}
function ensureActiveCase(){
  if (!state.activeCaseId){
    const id = uid("CASE");
    const c = {
      case_id: id,
      patient_ref: "",
      encounter_ref: "",
      order_ref: "",
      dept: "未設定",
      phase: "術中",
      status: "DRAFT",
      selected_procedures: { main:null, subs:[] },
      materials: [],
      audit: []
    };
    state.cases.unshift(c);
    state.activeCaseId = id;
    pushAudit("CASE_CREATE", { case_id: id });
    saveState();
  }
  return getActiveCase();
}
function setCaseField(key, val){
  const c = ensureActiveCase();
  c[key] = val;
  pushAudit("CONTEXT_SET", { [key]: val });
  saveState();
}
function setProcedures(main, subs){
  const c = ensureActiveCase();
  c.selected_procedures = { main, subs };
  pushAudit("PROCEDURE_SELECT", { main, subs });
  saveState();
}
function setCaseStatus(status){
  const c = ensureActiveCase();
  c.status = status;
  pushAudit(status === "FINAL" ? "FINAL_SUBMIT" : "DRAFT_SAVE", { status });
  saveState();
}

/* -----------------------------
   Suggestion data loaders
------------------------------ */
async function loadSuggestions(caseId){
  try {
    const j = await (await fetch("./data/procedure_suggestions.json", { cache:"no-store" })).json();
    return j[caseId] || [];
  } catch { return []; }
}
async function loadStandardSetByProcedureCode(procCode){
  try {
    const j = await (await fetch("./data/standard_set.json", { cache:"no-store" })).json();
    return j[procCode] || null;
  } catch { return null; }
}
async function loadBillingView(caseId){
  try {
    const j = await (await fetch("./data/billing_view.json", { cache:"no-store" })).json();
    return j[caseId] || null;
  } catch { return null; }
}

/* -----------------------------
   Generate "カルテ貼り付け文" & "構造化書戻し(疑似)"
------------------------------ */
function buildPasteText(c){
  const p = c?.selected_procedures?.main;
  const subs = c?.selected_procedures?.subs || [];
  const mats = c?.materials || [];
  const lines = [];
  lines.push(`【LinQ VAL（試作）記録】`);
  lines.push(`患者: ${c.patient_ref || "-"} / 受診: ${c.encounter_ref || "-"} / オーダー: ${c.order_ref || "-"}`);
  lines.push(`部署: ${c.dept || "-"} / フェーズ: ${c.phase || "-"}`);
  lines.push(`手技(メイン): ${p ? `${p.name} (${p.code_system}${p.code})` : "-"}`);
  if (subs.length) lines.push(`手技(補助): ${subs.map(s => `${s.name} (${s.code_system}${s.code})`).join(" / ")}`);
  lines.push(`材料:`);
  for (const m of mats){
    const n = m.product_name || "(不明)";
    const tk = m.tokutei_name ? ` / 償還:${m.tokutei_name}` : "";
    const pr = m.total_reimbursement_price_yen ? ` / 価格:${jpy(m.total_reimbursement_price_yen)}円` : "";
    lines.push(`- ${n}${tk}${pr} / raw:${m.raw} / status:${m.dict_status}`);
  }
  lines.push(`（Stage ${state.integrationStage}：疑似書戻し）`);
  return lines.join("\n");
}

function buildFhirLikeJson(c){
  // Not real FHIR. "FHIR-like" payload to make the image concrete.
  const p = c?.selected_procedures?.main;
  return {
    resourceType: "Bundle",
    type: "transaction",
    entry: [
      {
        resourceType: "Encounter",
        id: c.encounter_ref || "E-UNKNOWN",
        subject: { reference: c.patient_ref || "P-UNKNOWN" },
        serviceProvider: { display: c.dept || "Dept" }
      },
      {
        resourceType: "Procedure",
        status: c.status === "FINAL" ? "completed" : "in-progress",
        code: p ? { text: p.name, coding: [{ system: p.code_system, code: p.code }] } : { text: "UNKNOWN" },
        performedPeriod: { start: nowIso() }
      },
      ...((c.materials||[]).map(m => ({
        resourceType: "SupplyDelivery",
        status: "completed",
        suppliedItem: { itemCodeableConcept: { text: m.product_name || "UNKNOWN" } },
        occurrenceDateTime: nowIso(),
        extension: [
          { url: "rawBarcode", valueString: m.raw },
          { url: "jan13", valueString: m.jan13 || "" },
          { url: "gtin14", valueString: m.gtin14 || "" },
          { url: "dictStatus", valueString: m.dict_status }
        ]
      })))
    ]
  };
}

/* -----------------------------
   Scanner instance
------------------------------ */
let scanner = null;

function getOrCreateScanner(){
  if (scanner) return scanner;
  const targetEl = $("#scannerTarget");
  scanner = new Scanner({
    targetEl,
    onDetected: async (raw) => {
      await onScanDetected(raw);
    },
    onError: (e) => {
      pushAudit("SCAN_FAIL", { message: e.message });
      showToast("Start FAILED", e.message);
      render(); // refresh buttons
    },
    onLog: (msg) => {
      // optional: console.log(msg)
    }
  });
  return scanner;
}

async function onScanDetected(raw){
  const c = ensureActiveCase();
  const s = String(raw || "");

  pushAudit("SCAN_SUCCESS", { raw: s });

  // classify
  const jan13 = normalizeJan13(s);
  const gtin14 = parseGS1ForGTIN14(s);

  let item = {
    item_id: uid("MI"),
    scan_type: jan13 ? "jan13" : (gtin14 ? "gs1-128" : "unknown"),
    raw: s,
    jan13: jan13 || null,
    gtin14: gtin14 || null,
    dict_status: "unknown",
    product_name: "",
    manufacturer_name: "",
    product_no: "",
    product_sta: "",
    tokutei_name: "",
    total_reimbursement_price_yen: 0,
    qty: 1
  };

  // lookup flow:
  // 1) if jan13 -> dict_jan
  // 2) else if gtin14 -> gtin_index -> jan13 -> dict_jan
  if (jan13){
    const res = await lookupByJan13(jan13);
    item.dict_status = res.status;
    if (res.status === "hit"){
      const mapped = mapDictRowToDisplay(res.items[0]);
      Object.assign(item, mapped);
      pushAudit("DICT_HIT", { jan13 });
      showToast("Scan OK (JAN)", `${item.product_name} / ${jpy(item.total_reimbursement_price_yen)}円`);
    } else if (res.status === "no_match"){
      pushAudit("DICT_NO_MATCH", { jan13 });
      showToast("Scan OK (JAN)", `辞書0件 / raw:${jan13}`);
    } else {
      pushAudit("DICT_FETCH_ERROR", { jan13, error: res.error });
      showToast("Scan OK (JAN)", `辞書取得失敗 / ${res.error}`);
    }
  } else if (gtin14){
    const g = await lookupJanFromGtin14(gtin14);
    if (g.status === "hit" && g.jan13){
      item.jan13 = g.jan13;
      const res = await lookupByJan13(g.jan13);
      item.dict_status = res.status;
      if (res.status === "hit"){
        const mapped = mapDictRowToDisplay(res.items[0]);
        Object.assign(item, mapped);
        pushAudit("DICT_HIT", { gtin14, jan13: g.jan13 });
        showToast("Scan OK (GS1)", `${item.product_name} / ${jpy(item.total_reimbursement_price_yen)}円`);
      } else if (res.status === "no_match"){
        pushAudit("DICT_NO_MATCH", { gtin14, jan13: g.jan13 });
        showToast("Scan OK (GS1)", `辞書0件 / jan:${g.jan13}`);
      } else {
        pushAudit("DICT_FETCH_ERROR", { gtin14, jan13: g.jan13, error: res.error });
        showToast("Scan OK (GS1)", `辞書取得失敗 / ${res.error}`);
      }
    } else if (g.status === "no_match"){
      item.dict_status = "no_match";
      pushAudit("DICT_NO_MATCH", { gtin14 });
      showToast("Scan OK (GS1)", `GTIN→JAN索引 0件 / raw:${gtin14}`);
    } else {
      item.dict_status = "dict_fetch_error";
      pushAudit("DICT_FETCH_ERROR", { gtin14, error: g.error });
      showToast("Scan OK (GS1)", `索引取得失敗 / ${g.error}`);
    }
  } else {
    item.dict_status = "unknown";
    showToast("Scan OK", `形式不明 / raw:${s}`);
  }

  c.materials.unshift(item);
  saveState();
  render();
}

/* -----------------------------
   Export
------------------------------ */
function buildExportRows(){
  const rows = [];
  for (const c of state.cases){
    for (const m of (c.materials || [])){
      rows.push({
        timestamp: nowIso(),
        case_id: c.case_id,
        dept: c.dept || "",
        phase: c.phase || "",
        patient_ref: c.patient_ref || "",
        encounter_ref: c.encounter_ref || "",
        order_ref: c.order_ref || "",
        raw: m.raw || "",
        scan_type: m.scan_type || "",
        gtin14: m.gtin14 || "",
        jan13: m.jan13 || "",
        lookup_status: m.dict_status || "",
        product_name: m.product_name || "",
        manufacturer_name: m.manufacturer_name || "",
        product_no: m.product_no || "",
        product_sta: m.product_sta || "",
        tokutei_name: m.tokutei_name || "",
        total_reimbursement_price_yen: m.total_reimbursement_price_yen || 0,
        qty: m.qty || 1
      });
    }
  }
  return rows;
}
function toCsv(rows){
  if (!rows.length) return "empty\n";
  const header = Object.keys(rows[0]);
  const esc = (v) => {
    const s = String(v ?? "");
    if (s.includes('"') || s.includes(",") || s.includes("\n")) return `"${s.replace(/"/g,'""')}"`;
    return s;
  };
  const lines = [header.join(",")];
  for (const r of rows){
    lines.push(header.map(h => esc(r[h])).join(","));
  }
  return lines.join("\n");
}
function downloadText(filename, text){
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

/* -----------------------------
   Router + Render
------------------------------ */
function route(){
  const p = getHashPath();
  // routes:
  // /home
  // /case/context
  // /case/procedure
  // /case/scan
  // /case/review
  // /billing
  // /docs
  // /export
  return p;
}

function tagForStatus(s){
  if (s === "hit") return `<span class="tag ok">hit</span>`;
  if (s === "no_match") return `<span class="tag warn">no_match</span>`;
  if (s === "dict_fetch_error") return `<span class="tag err">fetch_error</span>`;
  return `<span class="tag">unknown</span>`;
}

async function screenHome(){
  ensureActiveCase();
  const items = state.cases.map(c => {
    const main = c.selected_procedures?.main ? `${c.selected_procedures.main.name}` : "(手技未設定)";
    const cnt = (c.materials || []).length;
    return `
      <div class="card">
        <div class="caseItem">
          <div class="meta">
            <b>${c.dept || "未設定"} / ${c.phase || "-"}</b>
            <span class="mono">${c.case_id}</span>
            <span>${main} / 材料 ${cnt} 件 / 状態: ${c.status || "DRAFT"}</span>
          </div>
          <div class="row">
            <button class="btn small" data-open="${c.case_id}">開く</button>
          </div>
        </div>
      </div>
    `;
  }).join("");

  return `
    <div class="grid">
      <div class="card">
        <div class="h1">Home</div>
        <div class="muted">「症例コンテキスト → 手技 → スキャン → レビュー → DRAFT/FINAL」を一連で体験する仮システムです。</div>
        <div class="hr"></div>
        <div class="row">
          <button class="btn accent" id="newCase">新規開始</button>
          <button class="btn" id="goContext">続き（コンテキスト）</button>
          <button class="btn" id="goProcedure">手技</button>
          <button class="btn" id="goScan">スキャン</button>
          <button class="btn" id="goReview">レビュー</button>
        </div>
      </div>
      ${items}
    </div>
  `;
}

async function screenContext(){
  const c = ensureActiveCase();
  return `
    <div class="grid">
      <div class="card">
        <div class="h1">症例コンテキスト</div>
        <div class="muted">連携なしPoCでも「参照IDの器」を持たせ、将来の書戻し（Stage1-3）に繋げます。</div>
        <div class="hr"></div>

        <div class="grid" style="gap:10px;">
          <div>
            <div class="muted">部署</div>
            <select class="input select" id="dept">
              ${["カテ室","手術室","内視鏡","外来処置室","病棟","未設定"].map(x => `<option ${c.dept===x?"selected":""}>${x}</option>`).join("")}
            </select>
          </div>

          <div class="two">
            <div>
              <div class="muted">patient_ref（ダミー可）</div>
              <input class="input mono" id="patient_ref" value="${c.patient_ref||""}" placeholder="P-000123" />
            </div>
            <div>
              <div class="muted">encounter_ref（ダミー可）</div>
              <input class="input mono" id="encounter_ref" value="${c.encounter_ref||""}" placeholder="E-20260121-01" />
            </div>
          </div>

          <div class="two">
            <div>
              <div class="muted">order_ref（器：将来の連携用）</div>
              <input class="input mono" id="order_ref" value="${c.order_ref||""}" placeholder="O-ABC-999" />
            </div>
            <div>
              <div class="muted">フェーズ</div>
              <select class="input select" id="phase">
                ${["術前","術中","術後"].map(x => `<option ${c.phase===x?"selected":""}>${x}</option>`).join("")}
              </select>
            </div>
          </div>

          <div class="row">
            <button class="btn accent" id="saveContext">保存</button>
            <button class="btn" id="toProcedure">手技入力へ</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

async function screenProcedure(){
  const c = ensureActiveCase();
  const sug = await loadSuggestions(c.case_id);

  const selectedMain = c.selected_procedures?.main;
  const selectedSubs = c.selected_procedures?.subs || [];

  const sugHtml = sug.length ? sug.map(s => {
    const ev = (s.evidence||[]).map(e => `<span class="tag">${e.label}</span>`).join(" ");
    return `
      <div class="card">
        <div class="row" style="justify-content:space-between;">
          <div>
            <div style="font-weight:850;">${s.procedure.name} <span class="pill mono">${s.procedure.code_system}${s.procedure.code}</span></div>
            <div class="row" style="margin-top:6px;">${ev}</div>
          </div>
          <div class="row">
            <button class="btn small accent" data-pick-main='${JSON.stringify(s.procedure)}'>メインに採用</button>
            <button class="btn small" data-pick-sub='${JSON.stringify(s.procedure)}'>補助に追加</button>
          </div>
        </div>
      </div>
    `;
  }).join("") : `<div class="card"><div class="muted">候補データ（data/procedure_suggestions.json）がありません。</div></div>`;

  // Standard set suggestion (shown "one time" after main selected)
  const mainCode = selectedMain?.code;
  const std = mainCode ? await loadStandardSetByProcedureCode(mainCode) : null;

  const stdCard = (std && mainCode) ? `
    <div class="card">
      <div class="h2">通常材料サジェスト（責めない：未スキャンカテゴリのみ）</div>
      <div class="muted">PoCでは“提案＝確認支援”。強制しません（×で閉じる運用想定）。</div>
      <div class="hr"></div>
      <div class="row">
        ${(std.required||[]).map(x=>`<span class="tag ok">必須候補: ${x}</span>`).join("")}
        ${(std.frequent||[]).map(x=>`<span class="tag">頻出: ${x}</span>`).join("")}
      </div>
      <div class="divider"></div>
      <div class="hint mono">（ここは将来、未スキャンカテゴリのみ表示・1回だけ表示の制御を入れる想定）</div>
    </div>
  ` : "";

  const mainLine = selectedMain
    ? `<b>${selectedMain.name}</b> <span class="pill mono">${selectedMain.code_system}${selectedMain.code}</span>`
    : `<span class="muted">未設定</span>`;

  const subsLine = selectedSubs.length
    ? selectedSubs.map(s => `${s.name} (${s.code_system}${s.code})`).join(" / ")
    : "なし";

  return `
    <div class="grid">
      <div class="card">
        <div class="h1">手技入力（メイン＋補助）</div>
        <div class="muted">提示順：予定/オーダー/パス → 前回履歴 → 材料→手技（根拠チップは“薄く”）。</div>
        <div class="hr"></div>

        <div class="row">
          <div class="kpi"><span class="muted">メイン</span><div>${mainLine}</div></div>
          <div class="kpi"><span class="muted">補助</span><div>${subsLine}</div></div>
        </div>

        <div class="hr"></div>
        <div class="row">
          <button class="btn accent" id="goScanFromProc">スキャンへ</button>
          <button class="btn" id="goReviewFromProc">レビューへ</button>
          <button class="btn err" id="clearSubs">補助をクリア</button>
        </div>
      </div>

      ${stdCard}
      ${sugHtml}
    </div>
  `;
}

async function screenScan(){
  const c = ensureActiveCase();
  const running = scanner?.isRunning?.() || false;

  const list = (c.materials || []).slice(0,10).map(m => `
    <div class="card">
      <div class="row" style="justify-content:space-between;">
        <div>
          <div style="font-weight:850;">${m.product_name || "(不明)"} ${tagForStatus(m.dict_status)}</div>
          <div class="muted">raw: <span class="mono">${m.raw}</span></div>
          <div class="muted">${m.tokutei_name ? `償還: ${m.tokutei_name}` : ""} ${m.total_reimbursement_price_yen ? ` / ${jpy(m.total_reimbursement_price_yen)}円` : ""}</div>
        </div>
        <div class="row">
          <button class="btn small" data-inc="${m.item_id}">+1</button>
          <button class="btn small err" data-del="${m.item_id}">削除</button>
        </div>
      </div>
    </div>
  `).join("");

  return `
    <div class="grid">
      <div class="card">
        <div class="h1">材料スキャン</div>
        <div class="muted">iPhone Safari 対策：Start多重防止 / locate=false / ROI中央 / Workers=0。</div>
        <div class="hr"></div>

        <div class="videoBox" id="scannerTarget"></div>
        <div class="divider"></div>

        <div class="row">
          <button class="btn accent" id="startScan" ${running ? "disabled":""}>Start</button>
          <button class="btn warn" id="stopScan" ${!running ? "disabled":""}>Stop</button>
          <button class="btn" id="toReview">レビューへ</button>
        </div>

        <div class="hint" style="margin-top:8px;">
          Tips: iPhoneはキャッシュが強いので URLに <span class="mono">?v=数字</span> を付けて開いてください。<br/>
          JAN-13優先。GS1-128は AI(01)からGTIN14抽出→索引→JAN照合の流れです。
        </div>
      </div>

      ${list || `<div class="card"><div class="muted">まだスキャン結果がありません。</div></div>`}
    </div>
  `;
}

async function screenReview(){
  const c = ensureActiveCase();
  const main = c.selected_procedures?.main;
  const subs = c.selected_procedures?.subs || [];
  const mats = c.materials || [];

  const hit = mats.filter(m => m.dict_status === "hit").length;
  const nom = mats.filter(m => m.dict_status === "no_match").length;
  const err = mats.filter(m => m.dict_status === "dict_fetch_error").length;

  const billing = await loadBillingView(c.case_id);

  const pasteText = buildPasteText(c);
  const fhirLike = JSON.stringify(buildFhirLikeJson(c), null, 2);

  return `
    <div class="grid">
      <div class="card">
        <div class="h1">レビュー（DRAFT / FINAL）</div>
        <div class="muted">ここで「医事に届く絵」と「カルテへ戻る絵（Stage切替）」を体験します。</div>
        <div class="hr"></div>

        <div class="row">
          <div class="kpi"><span class="muted">状態</span><b>${c.status||"DRAFT"}</b></div>
          <div class="kpi"><span class="muted">材料</span><b>${mats.length} 件</b></div>
          <div class="kpi"><span class="muted">hit</span><b>${hit}</b></div>
          <div class="kpi"><span class="muted">no_match</span><b>${nom}</b></div>
          <div class="kpi"><span class="muted">fetch_error</span><b>${err}</b></div>
        </div>

        <div class="hr"></div>
        <div class="row">
          <div class="tag">部署: ${c.dept||"-"}</div>
          <div class="tag">phase: ${c.phase||"-"}</div>
          <div class="tag mono">patient: ${c.patient_ref||"-"}</div>
          <div class="tag mono">enc: ${c.encounter_ref||"-"}</div>
          <div class="tag mono">order: ${c.order_ref||"-"}</div>
        </div>

        <div class="divider"></div>

        <div class="h2">手技</div>
        <div>${main ? `${main.name} <span class="pill mono">${main.code_system}${main.code}</span>` : `<span class="muted">未設定</span>`}</div>
        <div class="muted">補助: ${subs.length ? subs.map(s => `${s.name} (${s.code_system}${s.code})`).join(" / ") : "なし"}</div>

        <div class="hr"></div>
        <div class="row">
          <button class="btn accent" id="saveDraft">DRAFT保存</button>
          <button class="btn warn" id="saveFinal">FINAL確定（医事キューへ）</button>
          <button class="btn" id="backToScan">スキャンへ戻る</button>
        </div>
      </div>

      <div class="two">
        <div class="card">
          <div class="h2">医事ビュー（UKE標準 × 実施標準：疑似）</div>
          ${billing ? `
            <div class="hr"></div>
            <div class="row">
              <div class="kpi"><span class="muted">UKE標準</span><b>${billing.uke_standard?.length||0}</b></div>
              <div class="kpi"><span class="muted">実施</span><b>${billing.actual_standard?.length||0}</b></div>
              <div class="kpi"><span class="muted">ギャップ</span><b>${billing.gap?.length||0}</b></div>
            </div>
            <div class="divider"></div>
            <div class="h2">ギャップ</div>
            ${(billing.gap||[]).map(g => `<div class="muted">- <b>${g.type}</b>：${g.note||""}</div>`).join("") || `<div class="muted">ギャップなし</div>`}
          ` : `<div class="muted">data/billing_view.json がありません。</div>`}
          <div class="divider"></div>
          <button class="btn" id="goBilling">医事画面へ</button>
        </div>

        <div class="card">
          <div class="h2">カルテへ返る“絵”（Stageで変化）</div>
          <div class="muted">Stage2: コピー支援 / Stage3: 構造化JSON（疑似送信）</div>
          <div class="hr"></div>

          <div class="row">
            <button class="btn accent" id="copyPaste">貼り付け文をコピー（Stage2）</button>
            <button class="btn warn" id="copyJson">JSONをコピー（Stage3）</button>
          </div>

          <div class="divider"></div>
          <div class="muted">貼り付け文（プレビュー）</div>
          <pre class="card" style="white-space:pre-wrap;background:#0b1225;border:1px solid var(--line);">${pasteText}</pre>

          <div class="muted">構造化JSON（プレビュー）</div>
          <pre class="card" style="white-space:pre-wrap;background:#0b1225;border:1px solid var(--line);max-height:260px;overflow:auto;">${fhirLike}</pre>
        </div>
      </div>
    </div>
  `;
}

async function screenBilling(){
  // Billing Queue: list all FINAL cases
  const finals = state.cases.filter(c => c.status === "FINAL");
  const list = finals.map(c => `
    <div class="card">
      <div class="row" style="justify-content:space-between;">
        <div>
          <div style="font-weight:900;">${c.dept || "-"} / ${c.phase || "-"} <span class="tag ok">FINAL</span></div>
          <div class="muted mono">${c.case_id}</div>
          <div class="muted">材料 ${c.materials?.length||0} 件 / 手技 ${c.selected_procedures?.main ? "あり" : "未設定"}</div>
        </div>
        <div class="row">
          <button class="btn small" data-open="${c.case_id}">開く</button>
        </div>
      </div>
    </div>
  `).join("") || `<div class="card"><div class="muted">FINALがまだありません（レビューでFINAL確定してください）。</div></div>`;

  const c = getActiveCase();
  const billing = c ? await loadBillingView(c.case_id) : null;

  return `
    <div class="grid">
      <div class="card">
        <div class="h1">医事（Billing Queue）</div>
        <div class="muted">ここは“連携なしでも医事に届く”イメージのための管理画面です。</div>
      </div>
      ${list}

      ${c ? `
        <div class="card">
          <div class="h2">ケース詳細（アクティブ）</div>
          <div class="muted mono">${c.case_id}</div>
          <div class="hr"></div>
          <div class="two">
            <div>
              <div class="h2">UKE標準</div>
              ${(billing?.uke_standard||[]).map(x => `<div class="muted">- ${x.category} ${x.code||""} ${x.name} ×${x.qty||1}</div>`).join("") || `<div class="muted">（なし）</div>`}
            </div>
            <div>
              <div class="h2">実施標準</div>
              ${(billing?.actual_standard||[]).map(x => `<div class="muted">- ${x.category} ${x.code||""} ${x.name} ×${x.qty||1}</div>`).join("") || `<div class="muted">（なし）</div>`}
            </div>
          </div>
          <div class="divider"></div>
          <div class="h2">ギャップ（タグ育成の起点）</div>
          ${(billing?.gap||[]).map(g => `<div class="muted">- <b>${g.type}</b>：${g.note||""}</div>`).join("") || `<div class="muted">（ギャップなし）</div>`}
        </div>
      ` : ""}
    </div>
  `;
}

async function screenDocs(){
  const c = ensureActiveCase();
  const pasteText = buildPasteText(c);
  return `
    <div class="grid">
      <div class="card">
        <div class="h1">Docs（カルテ貼付・文書生成の“体”）</div>
        <div class="muted">Stage2の“コピー支援”を、単独の画面としても体験できます。</div>
        <div class="hr"></div>
        <div class="row">
          <button class="btn accent" id="copyPaste2">貼り付け文をコピー</button>
          <button class="btn" id="goReview2">レビューへ</button>
        </div>
      </div>
      <pre class="card" style="white-space:pre-wrap;background:#0b1225;border:1px solid var(--line);">${pasteText}</pre>
    </div>
  `;
}

async function screenExport(){
  const rows = buildExportRows();
  const csv = toCsv(rows);
  return `
    <div class="grid">
      <div class="card">
        <div class="h1">Export</div>
        <div class="muted">端末内ログ→CSVダウンロード（PoC回収の体験用）。</div>
        <div class="hr"></div>
        <div class="row">
          <button class="btn accent" id="dlCsv">CSVをダウンロード</button>
          <button class="btn err" id="clearAll">全データ削除（注意）</button>
        </div>
        <div class="divider"></div>
        <div class="muted">プレビュー（先頭数行）</div>
        <pre class="card" style="white-space:pre-wrap;background:#0b1225;border:1px solid var(--line);max-height:320px;overflow:auto;">${csv.split("\n").slice(0,18).join("\n")}</pre>
      </div>
    </div>
  `;
}

async function render(){
  $("#buildTag").textContent = `BUILD: ${BUILD}`;
  $("#stageTag").textContent = `Stage ${state.integrationStage}`;
  $("#roleTag").textContent = state.role;

  const p = route();
  const app = $("#app");

  // stop camera when leaving scan screen
  const onScanScreen = p === "/case/scan";
  if (!onScanScreen && scanner?.isRunning?.()) scanner.stop();

  let html = "";
  if (p === "/home") html = await screenHome();
  else if (p === "/case/context") html = await screenContext();
  else if (p === "/case/procedure") html = await screenProcedure();
  else if (p === "/case/scan") html = await screenScan();
  else if (p === "/case/review") html = await screenReview();
  else if (p === "/billing") html = await screenBilling();
  else if (p === "/docs") html = await screenDocs();
  else if (p === "/export") html = await screenExport();
  else html = await screenHome();

  app.innerHTML = html;
  bindEvents();
}

/* -----------------------------
   Event bindings per screen
------------------------------ */
function bindEvents(){
  // top nav
  $("#navHome").onclick = () => setHash("/home");
  $("#navBilling").onclick = () => { state.role="billing"; saveState(); setHash("/billing"); render(); };
  $("#navDocs").onclick = () => { state.role="docs"; saveState(); setHash("/docs"); render(); };
  $("#navExport").onclick = () => setHash("/export");

  // stage toggle
  $("#stageDown").onclick = () => { state.integrationStage = clamp(state.integrationStage - 1, 0, 3); saveState(); render(); };
  $("#stageUp").onclick = () => { state.integrationStage = clamp(state.integrationStage + 1, 0, 3); saveState(); render(); };

  const p = route();

  if (p === "/home"){
    $("#newCase").onclick = () => {
      const id = uid("CASE");
      state.cases.unshift({
        case_id: id,
        patient_ref: "",
        encounter_ref: "",
        order_ref: "",
        dept: "未設定",
        phase: "術中",
        status: "DRAFT",
        selected_procedures: { main:null, subs:[] },
        materials: [],
        audit: []
      });
      state.activeCaseId = id;
      state.role = "field";
      pushAudit("CASE_CREATE", { case_id: id });
      saveState();
      setHash("/case/context");
      render();
    };
    $("#goContext").onclick = () => setHash("/case/context");
    $("#goProcedure").onclick = () => setHash("/case/procedure");
    $("#goScan").onclick = () => setHash("/case/scan");
    $("#goReview").onclick = () => setHash("/case/review");

    document.querySelectorAll("[data-open]").forEach(btn => {
      btn.onclick = () => {
        state.activeCaseId = btn.getAttribute("data-open");
        state.role = "field";
        saveState();
        setHash("/case/review");
        render();
      };
    });
  }

  if (p === "/case/context"){
    $("#saveContext").onclick = () => {
      const dept = $("#dept").value;
      const patient_ref = $("#patient_ref").value.trim();
      const encounter_ref = $("#encounter_ref").value.trim();
      const order_ref = $("#order_ref").value.trim();
      const phase = $("#phase").value;

      const c = ensureActiveCase();
      c.dept = dept;
      c.patient_ref = patient_ref;
      c.encounter_ref = encounter_ref;
      c.order_ref = order_ref;
      c.phase = phase;

      pushAudit("CONTEXT_SET", { dept, patient_ref, encounter_ref, order_ref, phase });
      saveState();
      showToast("Saved", "症例コンテキストを保存しました");
    };
    $("#toProcedure").onclick = () => setHash("/case/procedure");
  }

  if (p === "/case/procedure"){
    $("#goScanFromProc").onclick = () => setHash("/case/scan");
    $("#goReviewFromProc").onclick = () => setHash("/case/review");
    $("#clearSubs").onclick = () => {
      const c = ensureActiveCase();
      c.selected_procedures.subs = [];
      pushAudit("PROCEDURE_SELECT", { main: c.selected_procedures.main, subs: [] });
      saveState(); render();
    };

    document.querySelectorAll("[data-pick-main]").forEach(btn => {
      btn.onclick = () => {
        const proc = safeJsonParse(btn.getAttribute("data-pick-main"), null);
        const c = ensureActiveCase();
        c.selected_procedures.main = proc;
        pushAudit("SUGGESTION_ACCEPT", { kind:"main", proc });
        saveState();
        showToast("採用", `メイン手技: ${proc.name}`);
        render();
      };
    });
    document.querySelectorAll("[data-pick-sub]").forEach(btn => {
      btn.onclick = () => {
        const proc = safeJsonParse(btn.getAttribute("data-pick-sub"), null);
        const c = ensureActiveCase();
        c.selected_procedures.subs = c.selected_procedures.subs || [];
        // avoid duplicates
        if (!c.selected_procedures.subs.some(x => x.code_system===proc.code_system && x.code===proc.code)){
          c.selected_procedures.subs.push(proc);
          pushAudit("SUGGESTION_ACCEPT", { kind:"sub", proc });
          saveState();
          showToast("追加", `補助手技: ${proc.name}`);
          render();
        }
      };
    });
  }

  if (p === "/case/scan"){
    const sc = getOrCreateScanner();
    $("#startScan").onclick = async () => {
      state.role = "field";
      saveState();
      pushAudit("SCAN_START", {});
      await sc.start();
      render();
    };
    $("#stopScan").onclick = () => {
      pushAudit("SCAN_STOP", {});
      sc.stop();
      render();
    };
    $("#toReview").onclick = () => setHash("/case/review");

    document.querySelectorAll("[data-inc]").forEach(btn => {
      btn.onclick = () => {
        const id = btn.getAttribute("data-inc");
        const c = ensureActiveCase();
        const m = c.materials.find(x => x.item_id === id);
        if (m) m.qty = (m.qty || 1) + 1;
        saveState(); render();
      };
    });
    document.querySelectorAll("[data-del]").forEach(btn => {
      btn.onclick = () => {
        const id = btn.getAttribute("data-del");
        const c = ensureActiveCase();
        c.materials = (c.materials || []).filter(x => x.item_id !== id);
        saveState(); render();
      };
    });
  }

  if (p === "/case/review"){
    $("#saveDraft").onclick = () => {
      state.role = "field";
      setCaseStatus("DRAFT");
      showToast("DRAFT", "保存しました");
      render();
    };
    $("#saveFinal").onclick = () => {
      state.role = "field";
      setCaseStatus("FINAL");
      showToast("FINAL", "医事キューへ共有（疑似）");
      render();
    };
    $("#backToScan").onclick = () => setHash("/case/scan");
    $("#goBilling").onclick = () => { state.role="billing"; saveState(); setHash("/billing"); render(); };

    $("#copyPaste").onclick = async () => {
      if (state.integrationStage < 2){
        showToast("Stage不足", "Stage2以上でコピー支援を想定（いまは体験なのでコピーは可能です）");
      }
      const c = ensureActiveCase();
      const text = buildPasteText(c);
      await copyToClipboard(text);
      pushAudit("DOCS_COPY", { kind:"pasteText" });
      showToast("Copied", "貼り付け文をコピーしました");
    };
    $("#copyJson").onclick = async () => {
      if (state.integrationStage < 3){
        showToast("Stage不足", "Stage3以上で構造化書戻しを想定（いまは体験なのでコピーは可能です）");
      }
      const c = ensureActiveCase();
      const json = JSON.stringify(buildFhirLikeJson(c), null, 2);
      await copyToClipboard(json);
      pushAudit("DOCS_COPY", { kind:"fhirLikeJson" });
      showToast("Copied", "構造化JSONをコピーしました");
    };
  }

  if (p === "/billing"){
    document.querySelectorAll("[data-open]").forEach(btn => {
      btn.onclick = () => {
        state.activeCaseId = btn.getAttribute("data-open");
        state.role = "billing";
        pushAudit("BILLING_VIEW_OPEN", { case_id: state.activeCaseId });
        saveState();
        render();
      };
    });
  }

  if (p === "/docs"){
    $("#copyPaste2").onclick = async () => {
      const c = ensureActiveCase();
      const text = buildPasteText(c);
      await copyToClipboard(text);
      pushAudit("DOCS_COPY", { kind:"pasteText" });
      showToast("Copied", "貼り付け文をコピーしました");
    };
    $("#goReview2").onclick = () => setHash("/case/review");
  }

  if (p === "/export"){
    $("#dlCsv").onclick = () => {
      const rows = buildExportRows();
      const csv = toCsv(rows);
      downloadText(`linqval_poc_${Date.now()}.csv`, csv);
      pushAudit("EXPORT_CSV", { rows: rows.length });
      showToast("Export", `CSVをダウンロードしました（${rows.length}行）`);
    };
    $("#clearAll").onclick = () => {
      if (!confirm("全データを削除します。よろしいですか？")) return;
      localStorage.removeItem(LS_KEY);
      state = defaultState();
      saveState();
      showToast("Cleared", "全データを削除しました");
      setHash("/home");
      render();
    };
  }
}

/* -----------------------------
   Boot
------------------------------ */
window.addEventListener("hashchange", () => render());

(async function boot(){
  // default route
  if (!location.hash) setHash("/home");
  // load demo data
  await loadDemoData();
  // ensure app shows stage/role tags correctly
  saveState();
  render();
})();

