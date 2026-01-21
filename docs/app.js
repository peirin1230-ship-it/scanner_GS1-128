import { Scanner, parseGS1ForGTIN14, normalizeJan13 } from "./scan.js";

const LS = {
  role: "linqval_role_v1",
  state: "linqval_state_simple_v2",
};

const TOAST_MS = 5400;

const ROLES = [
  { id:"doctor", label:"医師" },
  { id:"field",  label:"実施入力" },
  { id:"billing",label:"医事" },
];

const $ = (s)=>document.querySelector(s);
const iso = ()=>new Date().toISOString();
const jpy = (n)=> (Number(n||0)).toLocaleString("ja-JP");

function toastShow({ title, price, sub }){
  $("#toastTitle").textContent = title || "OK";
  $("#toastPrice").textContent = price ? `${jpy(price)}円` : "";
  $("#toastSub").textContent = sub || "";
  $("#toast").classList.add("show");
  setTimeout(()=> $("#toast").classList.remove("show"), TOAST_MS);
}

function safeParse(s, fb){ try { return JSON.parse(s); } catch { return fb; } }

function uid(prefix="ID"){
  return `${prefix}-${Math.random().toString(16).slice(2,10)}-${Date.now().toString(36)}`;
}

function setRolePill(roleId){
  const r = ROLES.find(x=>x.id===roleId);
  $("#rolePill").textContent = `職種：${r ? r.label : "未選択"}`;
}

/* ---------------------------
   Data load (CSV preferred)
   - If ./data/<name>.csv exists, use it.
   - Else fallback to ./data/<name>.json
   CSV format: id,label (header required)
---------------------------- */
async function tryFetchText(path){
  const r = await fetch(path, { cache:"no-store" });
  if (!r.ok) return null;
  return await r.text();
}
function parseCsvLine(line){
  const out=[]; let cur=""; let q=false;
  for (let i=0;i<line.length;i++){
    const ch=line[i];
    if (ch === '"'){
      if (q && line[i+1] === '"'){ cur+='"'; i++; }
      else q=!q;
    } else if (ch === "," && !q){
      out.push(cur); cur="";
    } else cur+=ch;
  }
  out.push(cur);
  return out;
}
function csvToRows(csv){
  const lines = String(csv||"").split(/\r?\n/).filter(x=>x.trim().length);
  if (!lines.length) return [];
  const header = parseCsvLine(lines[0]).map(h=>h.trim());
  const rows=[];
  for (let i=1;i<lines.length;i++){
    const cols = parseCsvLine(lines[i]);
    const obj={};
    header.forEach((h,idx)=> obj[h]= (cols[idx]??"").trim());
    rows.push(obj);
  }
  return rows;
}
async function loadTable(name){
  const csv = await tryFetchText(`./data/${name}.csv`);
  if (csv){
    const rows = csvToRows(csv);
    return rows.map(r=>({ id:r.id, label:r.label })).filter(x=>x.id && x.label);
  }
  // json fallback
  try{
    const r = await fetch(`./data/${name}.json`, { cache:"no-store" });
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}
async function loadJSON(path, fallback){
  try{
    const r = await fetch(path, { cache:"no-store" });
    if (!r.ok) return fallback;
    return await r.json();
  } catch {
    return fallback;
  }
}

/* ---------------------------
   State / permissions
---------------------------- */
function defaultState(){
  return {
    drafts: [],
    done: [],   // {id,date,operatorId,patientId,place,procedureId,materials[],status:"pending"|"approved",confirmedAt}
    docs: {}    // docs[patientId] = { symptom, reply, other }
  };
}
let role = localStorage.getItem(LS.role) || "";
let state = safeParse(localStorage.getItem(LS.state), null) || defaultState();

function save(){
  localStorage.setItem(LS.role, role);
  localStorage.setItem(LS.state, JSON.stringify(state));
}

// 권限っぽい固定
function canApprove(){ return role === "doctor"; }
function canConfirmDone(){ return role === "field"; }
function isReadOnlyBilling(){ return role === "billing"; }

/* ---------------------------
   External data (dummy/real)
---------------------------- */
let OPERATORS = [];
let PATIENTS  = [];
let PROCEDURES= [];
let PROC_SUG  = { base:[], byTokuteiName:{}, byProductName:{} };
let BILLMAP   = { byTokuteiName:{}, byProductName:{} };

async function bootData(){
  // CSV/JSON差し替え対応
  OPERATORS = await loadTable("operators");
  PATIENTS  = await loadTable("patients");
  PROCEDURES= await loadTable("procedures");
  PROC_SUG  = await loadJSON("./data/procedure_suggest.json", PROC_SUG);
  BILLMAP   = await loadJSON("./data/billing_map.json", BILLMAP);
}

/* ---------------------------
   Split dictionary lookup (existing folders)
---------------------------- */
async function fetchText(url){
  const res = await fetch(url, { cache:"no-store" });
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  return await res.text();
}
function csvToObjects(csv){
  const lines = String(csv||"").split(/\r?\n/).filter(x=>x.trim().length);
  if (!lines.length) return [];
  const header = parseCsvLine(lines[0]).map(h=>h.trim());
  const rows=[];
  for (let i=1;i<lines.length;i++){
    const cols = parseCsvLine(lines[i]);
    const obj={};
    header.forEach((h,idx)=> obj[h]= (cols[idx]??"").trim());
    rows.push(obj);
  }
  return rows;
}
function buildJanPath(jan13){
  return `./dict_jan/${jan13.slice(0,3)}/${jan13.slice(0,4)}.csv`;
}
function buildGtinPath(gtin14){
  return `./gtin_index/${gtin14.slice(0,3)}/${gtin14.slice(0,4)}.csv`;
}
function pickRow(row, keys){
  for (const k of keys){
    const v=row[k];
    if (v && String(v).trim().length) return String(v).trim();
  }
  return "";
}
function mapDictRow(row){
  const product_name = pickRow(row, ["product_name","商品名","name","商品名称"]) || "(名称不明)";
  const tokutei_name = pickRow(row, ["tokutei_name","償還名称","特定材名称","特定保険医療材料名称"]);
  const priceRaw = pickRow(row, ["total_reimbursement_price_yen","償還価格合計","price","償還価格"]);
  const price = priceRaw ? Number(priceRaw.replace(/[^\d]/g,"")) : 0;
  return { product_name, tokutei_name, total_reimbursement_price_yen: price };
}
async function lookupByJan13(jan13){
  try{
    const csv = await fetchText(buildJanPath(jan13));
    const rows = csvToObjects(csv);
    const keys = ["jan13","JAN13","jan","JAN","code","barcode"];
    const hit = rows.find(r => keys.some(k => r[k] === jan13));
    if (!hit) return { status:"no_match" };
    return { status:"hit", row: hit };
  } catch(e){
    return { status:"dict_fetch_error", error: e.message };
  }
}
async function lookupJanFromGtin14(gtin14){
  try{
    const csv = await fetchText(buildGtinPath(gtin14));
    const rows = csvToObjects(csv);
    const gtKeys = ["gtin14","GTIN14","gtin","GTIN","01","ai01"];
    const janKeys= ["jan13","JAN13","jan","JAN"];
    const found = rows.find(r => gtKeys.some(k => r[k] === gtin14));
    if (!found) return { status:"no_match" };
    const jan13 = janKeys.map(k=>found[k]).find(v=> String(v||"").match(/^\d{13}$/));
    if (!jan13) return { status:"no_match" };
    return { status:"hit", jan13 };
  } catch(e){
    return { status:"dict_fetch_error", error: e.message };
  }
}

/* ---------------------------
   Billing code mapping (mock)
---------------------------- */
function billingCodeFor(material){
  const t = material.tokutei_name || "";
  const p = material.product_name || "";
  return BILLMAP.byTokuteiName?.[t] || BILLMAP.byProductName?.[p] || "—";
}

/* ---------------------------
   Procedure suggestion (mock)
---------------------------- */
function suggestProcedures(materials){
  const base = PROC_SUG.base || [];
  const extra = [];
  for (const m of (materials||[])){
    const t = m.tokutei_name || "";
    const p = m.product_name || "";
    extra.push(...(PROC_SUG.byTokuteiName?.[t] || []));
    extra.push(...(PROC_SUG.byProductName?.[p] || []));
  }
  const seen = new Set();
  const out = [];
  for (const id of [...base, ...extra]){
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.slice(0, 6);
}

/* ---------------------------
   Router
---------------------------- */
let scanner = null;
let scanCtx = null; // {draftId, step, operatorId, patientId, procedureId, place, materials[]}

function setView(hash){ location.hash = `#${hash}`; }
function view(){ return (location.hash || "#/").slice(1); }
function ensureRole(){
  if (!role){ setView("/role"); return false; }
  return true;
}

/* ---------------------------
   UI helpers (icon-first)
---------------------------- */
function btn(label, id, kind=""){
  const cls = kind === "primary" ? "btn primary" : kind === "ghost" ? "btn ghost" : "btn";
  return `<button class="${cls}" id="${id}">${label}</button>`;
}
function listItem(title, sub, rightHtml){
  return `
    <div class="listItem">
      <div>
        <b>${title}</b>
        ${sub ? `<div class="muted">${sub}</div>` : ""}
      </div>
      <div>${rightHtml||""}</div>
    </div>
  `;
}

/* ---------------------------
   Screens
---------------------------- */
function screenRole(){
  return `
    <div class="grid">
      <div class="card">
        <div class="h1">職種</div>
        <div class="divider"></div>
        <div class="grid">
          ${btn("👨‍⚕️ 医師", "role_doctor", "primary")}
          ${btn("📷 実施入力", "role_field", "primary")}
          ${btn("🧾 医事", "role_billing", "primary")}
        </div>
      </div>
    </div>
  `;
}

function screenDoctorHome(){
  return `
    <div class="grid">
      <div class="card">
        <div class="h1">医師</div>
        <div class="grid">
          ${btn("✅ 承認", "go_doc_approve", "primary")}
          ${btn("📝 Docs", "go_doc_docs", "primary")}
        </div>
      </div>
    </div>
  `;
}

function screenDoctorApprovals(){
  const pending = state.done.filter(x=>x.status==="pending");
  const list = pending.length ? pending.map(x=>{
    const patient = PATIENTS.find(p=>p.id===x.patientId)?.label || x.patientId;
    const operator= OPERATORS.find(o=>o.id===x.operatorId)?.label || x.operatorId;
    const sub = `${operator} / ${x.place || "場所未設定"}`;
    return `
      <div class="listItem">
        <div style="display:flex;gap:12px;align-items:center;">
          <input class="check" type="checkbox" data-chk="${x.id}">
          <div>
            <b>${patient}</b>
            <div class="muted">${sub}</div>
          </div>
        </div>
        <button class="btn small" data-open="${x.id}">詳細</button>
      </div>
    `;
  }).join("") : `<div class="muted">承認待ちなし</div>`;

  return `
    <div class="grid">
      <div class="card">
        <div class="h1">承認</div>
        <div class="divider"></div>
        <div class="grid">${list}</div>
        <div class="divider"></div>
        <div class="row">
          ${btn("✅ 一括承認", "bulk_approve", "primary")}
          ${btn("⬅ 戻る", "back_doc_home", "ghost")}
        </div>
      </div>
      <div class="card" id="approveDetail" style="display:none;"></div>
    </div>
  `;
}

function renderApprovalDetail(item){
  const patient = PATIENTS.find(p=>p.id===item.patientId)?.label || item.patientId;
  const proc    = PROCEDURES.find(p=>p.id===item.procedureId)?.label || "未選択";
  const mats = (item.materials||[]).map(m=>{
    const code = billingCodeFor(m);
    return listItem(
      m.product_name || "(不明)",
      m.tokutei_name || "",
      `<span class="tag">医事:${code}</span>`
    );
  }).join("") || `<div class="muted">材料なし</div>`;

  return `
    <div class="h2">詳細</div>
    ${listItem("患者", patient, "")}
    ${listItem("手技", proc, "")}
    <div class="divider"></div>
    <div class="h2">材料</div>
    <div class="grid">${mats}</div>
    <div class="divider"></div>
    <div class="row">
      <button class="btn primary" id="approve_one" data-id="${item.id}">✅ 承認</button>
      <button class="btn ghost" id="close_detail">✖ 閉じる</button>
    </div>
  `;
}

function screenDoctorDocs(){
  return `
    <div class="grid">
      <div class="card">
        <div class="h1">Docs</div>
        <div class="divider"></div>
        <select class="select" id="docs_patient">
          ${PATIENTS.map(p=>`<option value="${p.id}">${p.label}</option>`).join("")}
        </select>
        <div class="divider"></div>
        <div class="grid">
          ${btn("🩺 症状詳記", "docs_symptom", "primary")}
          ${btn("✉️ 返書", "docs_reply", "primary")}
          ${btn("📎 その他", "docs_other", "primary")}
          ${btn("⬅ 戻る", "back_doc_home2", "ghost")}
        </div>
      </div>
      <div class="card" id="docsEditor" style="display:none;"></div>
    </div>
  `;
}

function screenFieldHome(){
  return `
    <div class="grid">
      <div class="card">
        <div class="h1">実施入力</div>
        <div class="grid">
          ${btn("📷 スキャン", "go_field_scan", "primary")}
          ${btn("🗂 下書き", "go_field_drafts", "primary")}
          ${btn("📅 実施済み", "go_field_done", "primary")}
        </div>
      </div>
    </div>
  `;
}

function ensureScanCtx(){
  if (!scanCtx){
    scanCtx = {
      draftId: uid("DRAFT"),
      step: 1,
      operatorId: "",
      patientId: "",
      procedureId: "",
      place: "未設定",
      materials: [],
      createdAt: iso(),
      updatedAt: iso()
    };
  }
}

function screenFieldStep(step){
  ensureScanCtx();
  scanCtx.step = step;

  const saveDraftBar = `
    <div class="row">
      <button class="btn ghost" id="save_draft_any">💾 下書き</button>
      <button class="btn ghost" id="cancel_flow">✖ 中止</button>
    </div>
  `;

  if (step === 1){
    return `
      <div class="grid">
        <div class="card">
          <div class="h1">入力者</div>
          <div class="divider"></div>
          <select class="select" id="op_select">
            <option value="">選択</option>
            ${OPERATORS.map(o=>`<option value="${o.id}">${o.label}</option>`).join("")}
          </select>
          <div class="divider"></div>
          ${btn("➡ 次へ", "to_step2", "primary")}
          <div class="divider"></div>
          ${saveDraftBar}
        </div>
      </div>
    `;
  }

  if (step === 2){
    return `
      <div class="grid">
        <div class="card">
          <div class="h1">患者</div>
          <div class="divider"></div>
          <select class="select" id="pt_select">
            <option value="">選択</option>
            ${PATIENTS.map(p=>`<option value="${p.id}">${p.label}</option>`).join("")}
          </select>
          <div class="divider"></div>
          ${btn("➡ 次へ", "to_step3", "primary")}
          <div class="divider"></div>
          ${saveDraftBar}
        </div>
      </div>
    `;
  }

  if (step === 3){
    const sugIds = suggestProcedures(scanCtx.materials);
    const sugButtons = sugIds.map(id=>{
      const p = PROCEDURES.find(x=>x.id===id);
      return p ? `<button class="btn small ghost" data-sug="${p.id}">${p.label}</button>` : "";
    }).join("");

    return `
      <div class="grid">
        <div class="card">
          <div class="h1">手技</div>
          <div class="divider"></div>
          <div class="row">${sugButtons || `<span class="muted">候補なし</span>`}</div>
          <div class="divider"></div>
          <select class="select" id="proc_select">
            <option value="">選択</option>
            ${PROCEDURES.map(p=>`<option value="${p.id}" ${scanCtx.procedureId===p.id?"selected":""}>${p.label}</option>`).join("")}
          </select>
          <div class="divider"></div>
          ${btn("➡ 次へ", "to_step4", "primary")}
          <div class="divider"></div>
          ${saveDraftBar}
        </div>
      </div>
    `;
  }

  if (step === 4){
    // IMPORTANT: NO full render while running.
    const mats = (scanCtx.materials||[]).slice(0,6).map(m=>`
      <div class="listItem">
        <div>
          <b>${m.product_name || "(不明)"}</b>
          <div class="muted">${m.tokutei_name || ""}</div>
        </div>
        <div class="tag">${m.dict_status}</div>
      </div>
    `).join("") || `<div class="muted">材料なし</div>`;

    return `
      <div class="grid">
        <div class="card">
          <div class="h1">材料</div>
          <div class="divider"></div>
          <div class="videoBox" id="scannerTarget"></div>
          <div class="divider"></div>

          <div class="row">
            <button class="btn primary" id="scan_start">▶ Start</button>
            <button class="btn ghost" id="scan_stop" disabled>■ Stop</button>
            <button class="btn ghost" id="to_confirm">✅ 確定</button>
          </div>

          <div class="divider"></div>
          <div class="row" id="matSugRow"></div>

          <div class="divider"></div>
          <div class="grid" id="matList">${mats}</div>

          <div class="divider"></div>
          ${saveDraftBar}
        </div>
      </div>
    `;
  }

  // confirm
  const op = OPERATORS.find(o=>o.id===scanCtx.operatorId)?.label || "未選択";
  const pt = PATIENTS.find(p=>p.id===scanCtx.patientId)?.label || "未選択";
  const pr = PROCEDURES.find(p=>p.id===scanCtx.procedureId)?.label || "未選択";

  const mats = (scanCtx.materials||[]).map(m=>{
    const code = billingCodeFor(m);
    const prc = m.total_reimbursement_price_yen ? `${jpy(m.total_reimbursement_price_yen)}円` : "";
    return listItem(m.product_name || "(不明)", m.tokutei_name || "", `<span class="tag">医事:${code}</span>`);
  }).join("") || `<div class="muted">材料なし</div>`;

  return `
    <div class="grid">
      <div class="card">
        <div class="h1">確定</div>
        <div class="divider"></div>
        ${listItem("入力者", op, "")}
        ${listItem("患者", pt, "")}
        ${listItem("手技", pr, "")}
        <div class="divider"></div>
        <div class="grid">${mats}</div>
        <div class="divider"></div>
        <div class="row">
          <button class="btn primary" id="confirm_done" ${!canConfirmDone() ? "disabled":""}>✅ 実施済み</button>
          <button class="btn ghost" id="back_step4">⬅ 戻る</button>
          <button class="btn ghost" id="save_draft_any2">💾 下書き</button>
        </div>
      </div>
    </div>
  `;
}

function screenDrafts(){
  const list = state.drafts.length ? state.drafts.map(d=>{
    const pt = PATIENTS.find(p=>p.id===d.patientId)?.label || "患者未選択";
    const op = OPERATORS.find(o=>o.id===d.operatorId)?.label || "入力者未選択";
    return listItem(pt, `${op}`, `<button class="btn small" data-resume="${d.id}">続き</button>`);
  }).join("") : `<div class="muted">下書きなし</div>`;

  return `
    <div class="grid">
      <div class="card">
        <div class="h1">下書き</div>
        <div class="divider"></div>
        <div class="grid">${list}</div>
        <div class="divider"></div>
        ${btn("⬅ 戻る", "back_field_home", "ghost")}
      </div>
    </div>
  `;
}

function screenDone(){
  return `
    <div class="grid">
      <div class="card">
        <div class="h1">実施済み</div>
        <div class="divider"></div>

        <select class="select" id="done_filter">
          <option value="today">今日</option>
          <option value="patient">患者</option>
          <option value="operator">入力者</option>
          <option value="place">場所</option>
        </select>

        <div class="divider"></div>
        <div id="done_filter_value"></div>

        <div class="divider"></div>
        <div class="grid" id="done_list"></div>

        <div class="divider"></div>
        ${btn("⬅ 戻る", "back_field_home2", "ghost")}
      </div>
    </div>
  `;
}

function screenBillingHome(){
  return `
    <div class="grid">
      <div class="card">
        <div class="h1">医事</div>
        <div class="grid">
          ${btn("📄 実施入力済み", "go_bill_done", "primary")}
          ${btn("⏳ 承認待ち", "go_bill_pending", "primary")}
          ${btn("🛠 マスタ", "go_bill_master", "primary")}
        </div>
      </div>
    </div>
  `;
}

function screenBillingList(kind){
  const isPending = kind==="pending";
  const items = state.done.filter(x => isPending ? x.status==="pending" : x.status!=="pending");
  const list = items.length ? items.map(x=>{
    const patient = PATIENTS.find(p=>p.id===x.patientId)?.label || x.patientId;
    const operator= OPERATORS.find(o=>o.id===x.operatorId)?.label || x.operatorId;
    const priceSum = (x.materials||[]).reduce((a,m)=>a+(m.total_reimbursement_price_yen||0),0);
    return `
      <div class="listItem" data-openbill="${x.id}">
        <div>
          <b>${patient}</b>
          <div class="muted">${operator} / ${x.place||"未設定"}</div>
          <div class="muted">合計 ${jpy(priceSum)}円</div>
        </div>
        <div class="tag">${isPending ? "承認待ち" : "済"}</div>
      </div>
    `;
  }).join("") : `<div class="muted">データなし</div>`;

  return `
    <div class="grid">
      <div class="card">
        <div class="h1">${isPending ? "承認待ち" : "実施入力済み"}</div>
        <div class="divider"></div>
        <div class="grid">${list}</div>
        <div class="divider"></div>
        ${btn("⬅ 戻る", "back_billing_home", "ghost")}
      </div>
      <div class="card" id="billDetail" style="display:none;"></div>
    </div>
  `;
}

function renderBillingDetail(item){
  const patient = PATIENTS.find(p=>p.id===item.patientId)?.label || item.patientId;
  const proc    = PROCEDURES.find(p=>p.id===item.procedureId)?.label || "未選択";
  const mats = (item.materials||[]).map(m=>{
    const code = billingCodeFor(m);
    const prc = m.total_reimbursement_price_yen ? `${jpy(m.total_reimbursement_price_yen)}円` : "";
    return listItem(m.product_name || "(不明)", `${m.tokutei_name||""} ${prc}`, `<span class="tag">医事:${code}</span>`);
  }).join("") || `<div class="muted">材料なし</div>`;

  return `
    <div class="h2">詳細</div>
    ${listItem("患者", patient, "")}
    ${listItem("手技", proc, "")}
    <div class="divider"></div>
    <div class="grid">${mats}</div>
    <div class="divider"></div>
    ${btn("✖ 閉じる", "close_bill_detail", "ghost")}
  `;
}

function screenBillingMaster(){
  return `
    <div class="grid">
      <div class="card">
        <div class="h1">マスタ</div>
        <div class="divider"></div>
        ${listItem("標準ビルダ", "設定UIは次工程", `<span class="tag">準備中</span>`)}
        <div class="divider"></div>
        ${btn("⬅ 戻る", "back_billing_home2", "ghost")}
      </div>
    </div>
  `;
}

/* ---------------------------
   Render + bindings
---------------------------- */
function render(){
  setRolePill(role);
  const v = view();

  // scan以外ならカメラ停止
  if (!v.startsWith("/field/scan/step/4") && scanner?.isRunning?.()) scanner.stop();

  const app = $("#app");

  if (v !== "/role" && !ensureRole()) return;

  if (v === "/role"){
    app.innerHTML = screenRole();
    $("#role_doctor").onclick = ()=>{ role="doctor"; save(); setView("/"); render(); };
    $("#role_field").onclick  = ()=>{ role="field"; save(); setView("/"); render(); };
    $("#role_billing").onclick= ()=>{ role="billing"; save(); setView("/"); render(); };
    return;
  }

  if (role === "doctor"){
    if (v === "/" ){ app.innerHTML = screenDoctorHome(); $("#go_doc_approve").onclick=()=>{setView("/doctor/approvals");render();}; $("#go_doc_docs").onclick=()=>{setView("/doctor/docs");render();}; return;}
    if (v === "/doctor/approvals"){
      app.innerHTML = screenDoctorApprovals();

      $("#back_doc_home").onclick = ()=>{ setView("/"); render(); };

      // bulk approve (doctor only)
      $("#bulk_approve").onclick = ()=>{
        if (!canApprove()) return;
        const checked = Array.from(document.querySelectorAll("[data-chk]"))
          .filter(x=>x.checked)
          .map(x=>x.getAttribute("data-chk"));
        if (!checked.length){ toastShow({title:"選択なし", sub:"チェックしてください"}); return; }
        for (const id of checked){
          const it = state.done.find(x=>x.id===id);
          if (it) it.status="approved";
        }
        save();
        toastShow({title:"承認", sub:`${checked.length}件`});
        render();
      };

      // detail open
      document.querySelectorAll("[data-open]").forEach(b=>{
        b.onclick = ()=>{
          const id = b.getAttribute("data-open");
          const item = state.done.find(x=>x.id===id);
          if (!item) return;
          const box = $("#approveDetail");
          box.innerHTML = renderApprovalDetail(item);
          box.style.display="block";
          $("#close_detail").onclick = ()=>{ box.style.display="none"; };
          $("#approve_one").onclick = ()=>{
            if (!canApprove()) return;
            const tid = $("#approve_one").getAttribute("data-id");
            const it = state.done.find(x=>x.id===tid);
            if (it){ it.status="approved"; save(); toastShow({title:"承認", sub:"完了"}); }
            box.style.display="none";
            render();
          };
        };
      });
      return;
    }

    if (v === "/doctor/docs"){
      app.innerHTML = screenDoctorDocs();
      $("#back_doc_home2").onclick=()=>{ setView("/"); render(); };
      const editor = $("#docsEditor");
      const openEditor = (kind)=>{
        const pid = $("#docs_patient").value || "";
        state.docs[pid] = state.docs[pid] || { symptom:"", reply:"", other:"" };
        const label = kind==="symptom" ? "症状詳記" : kind==="reply" ? "返書" : "その他";
        editor.style.display="block";
        editor.innerHTML = `
          <div class="h2">${label}</div>
          <div class="divider"></div>
          <textarea id="docs_text" style="width:100%;height:220px;border-radius:16px;border:1px solid #f2d2dd;padding:12px;font-size:16px;outline:none;"></textarea>
          <div class="divider"></div>
          <div class="row">
            <button class="btn primary" id="docs_save">💾 保存</button>
            <button class="btn ghost" id="docs_close">✖ 閉じる</button>
          </div>
        `;
        $("#docs_text").value = state.docs[pid][kind] || "";
        $("#docs_save").onclick=()=>{ state.docs[pid][kind]=$("#docs_text").value; save(); toastShow({title:"保存", sub:label}); editor.style.display="none"; };
        $("#docs_close").onclick=()=>{ editor.style.display="none"; };
      };
      $("#docs_symptom").onclick=()=>openEditor("symptom");
      $("#docs_reply").onclick  =()=>openEditor("reply");
      $("#docs_other").onclick  =()=>openEditor("other");
      return;
    }

    // default
    app.innerHTML = screenDoctorHome();
    $("#go_doc_approve").onclick=()=>{setView("/doctor/approvals");render();};
    $("#go_doc_docs").onclick=()=>{setView("/doctor/docs");render();};
    return;
  }

  if (role === "field"){
    if (v === "/"){
      app.innerHTML = screenFieldHome();
      $("#go_field_scan").onclick=()=>{ scanCtx=null; setView("/field/scan/step/1"); render(); };
      $("#go_field_drafts").onclick=()=>{ setView("/field/drafts"); render(); };
      $("#go_field_done").onclick=()=>{ setView("/field/done"); render(); };
      return;
    }

    if (v.startsWith("/field/scan/step/")){
      const step = Number(v.split("/").pop());
      app.innerHTML = screenFieldStep(step);

      const saveDraft = ()=>{
        ensureScanCtx();
        const idx = state.drafts.findIndex(d=>d.id===scanCtx.draftId);
        const draft = {
          id: scanCtx.draftId,
          step: scanCtx.step,
          operatorId: scanCtx.operatorId,
          patientId: scanCtx.patientId,
          procedureId: scanCtx.procedureId,
          place: scanCtx.place,
          materials: scanCtx.materials || [],
          createdAt: scanCtx.createdAt,
          updatedAt: iso()
        };
        if (idx>=0) state.drafts[idx]=draft; else state.drafts.unshift(draft);
        save();
        toastShow({title:"下書き", sub:"保存"});
        // スキャン中なら止めてから移動
        if (scanner?.isRunning?.()) scanner.stop();
        scanCtx=null;
        setView("/field/drafts"); render();
      };
      const cancel = ()=>{
        if (scanner?.isRunning?.()) scanner.stop();
        scanCtx=null;
        setView("/"); render();
      };
      $("#save_draft_any") && ($("#save_draft_any").onclick = saveDraft);
      $("#save_draft_any2") && ($("#save_draft_any2").onclick = saveDraft);
      $("#cancel_flow").onclick = cancel;

      if (step===1){
        $("#to_step2").onclick=()=>{
          ensureScanCtx();
          scanCtx.operatorId = $("#op_select").value || "";
          scanCtx.updatedAt = iso();
          setView("/field/scan/step/2"); render();
        };
        return;
      }
      if (step===2){
        $("#to_step3").onclick=()=>{
          ensureScanCtx();
          scanCtx.patientId = $("#pt_select").value || "";
          scanCtx.updatedAt = iso();
          setView("/field/scan/step/3"); render();
        };
        return;
      }
      if (step===3){
        document.querySelectorAll("[data-sug]").forEach(b=>{
          b.onclick=()=>{
            ensureScanCtx();
            scanCtx.procedureId = b.getAttribute("data-sug");
            $("#proc_select").value = scanCtx.procedureId;
          };
        });
        $("#to_step4").onclick=()=>{
          ensureScanCtx();
          scanCtx.procedureId = $("#proc_select").value || scanCtx.procedureId || "";
          scanCtx.updatedAt = iso();
          setView("/field/scan/step/4"); render();
        };
        return;
      }

      if (step===4){
        // ---- KEY FIX: scan screen must NOT re-render while running ----
        const startBtn = $("#scan_start");
        const stopBtn  = $("#scan_stop");
        const matList  = $("#matList");
        const sugRow   = $("#matSugRow");
        const target   = $("#scannerTarget");

        const paintSug = ()=>{
          const sugIds = suggestProcedures(scanCtx.materials);
          sugRow.innerHTML = sugIds.map(id=>{
            const p = PROCEDURES.find(x=>x.id===id);
            return p ? `<button class="btn small ghost" data-mat-sug="${p.id}">${p.label}</button>` : "";
          }).join("");
          document.querySelectorAll("[data-mat-sug]").forEach(b=>{
            b.onclick=()=>{
              scanCtx.procedureId = b.getAttribute("data-mat-sug");
              save();
              toastShow({title:"手技", sub:"更新"});
            };
          });
        };

        const paintMats = ()=>{
          const mats = (scanCtx.materials||[]).slice(0,6).map(m=>`
            <div class="listItem">
              <div>
                <b>${m.product_name || "(不明)"}</b>
                <div class="muted">${m.tokutei_name || ""}</div>
              </div>
              <div class="tag">${m.dict_status}</div>
            </div>
          `).join("") || `<div class="muted">材料なし</div>`;
          matList.innerHTML = mats;
        };

        const setButtons = (running)=>{
          startBtn.disabled = !!running;
          stopBtn.disabled  = !running;
        };

        const onScan = async (raw)=>{
          const s = String(raw||"");
          const jan13 = normalizeJan13(s);
          const gtin14 = parseGS1ForGTIN14(s);

          const item = {
            id: uid("MAT"),
            raw: s,
            jan13: jan13 || null,
            gtin14: gtin14 || null,
            dict_status: "unknown",
            product_name: "",
            tokutei_name: "",
            total_reimbursement_price_yen: 0
          };

          if (jan13){
            const r = await lookupByJan13(jan13);
            item.dict_status = r.status;
            if (r.status==="hit"){
              const m = mapDictRow(r.row);
              Object.assign(item, m);
              toastShow({ title:"OK", price:m.total_reimbursement_price_yen, sub:m.product_name });
            } else if (r.status==="no_match"){
              toastShow({ title:"OK", sub:"辞書0件" });
            } else {
              toastShow({ title:"OK", sub:"辞書失敗" });
            }
          } else if (gtin14){
            const g = await lookupJanFromGtin14(gtin14);
            if (g.status==="hit"){
              item.jan13 = g.jan13;
              const r = await lookupByJan13(g.jan13);
              item.dict_status = r.status;
              if (r.status==="hit"){
                const m = mapDictRow(r.row);
                Object.assign(item, m);
                toastShow({ title:"OK", price:m.total_reimbursement_price_yen, sub:m.product_name });
              } else if (r.status==="no_match"){
                toastShow({ title:"OK", sub:"辞書0件" });
              } else {
                toastShow({ title:"OK", sub:"辞書失敗" });
              }
            } else {
              item.dict_status = "no_match";
              toastShow({ title:"OK", sub:"索引0件" });
            }
          } else {
            toastShow({ title:"OK", sub:"形式不明" });
          }

          scanCtx.materials.unshift(item);
          scanCtx.updatedAt = iso();
          save();

          // IMPORTANT: update only parts (no render)
          paintMats();
          paintSug();
        };

        // init scanner
        if (!scanner){
          scanner = new Scanner({
            targetEl: target,
            onDetected: onScan,
            onError: (e)=> toastShow({ title:"Start失敗", sub: e.message })
          });
        } else {
          scanner.targetEl = target;
        }

        // initial paint
        paintMats();
        paintSug();
        setButtons(scanner.isRunning?.() || false);

        startBtn.onclick = async ()=>{
          await scanner.start();
          setButtons(true); // NO render
        };
        stopBtn.onclick = ()=>{
          scanner.stop();
          setButtons(false); // NO render
        };

        $("#to_confirm").onclick = ()=>{
          if (scanner?.isRunning?.()) scanner.stop();
          setView("/field/scan/step/5"); render();
        };
        return;
      }

      // confirm
      $("#back_step4").onclick=()=>{ setView("/field/scan/step/4"); render(); };
      $("#confirm_done").onclick=()=>{
        if (!canConfirmDone()) return;
        ensureScanCtx();
        const doneItem = {
          id: uid("DONE"),
          date: new Date().toISOString().slice(0,10),
          operatorId: scanCtx.operatorId,
          patientId: scanCtx.patientId,
          place: scanCtx.place || "未設定",
          procedureId: scanCtx.procedureId,
          materials: scanCtx.materials || [],
          status: "pending",
          confirmedAt: iso()
        };
        state.done.unshift(doneItem);
        state.drafts = state.drafts.filter(d=>d.id!==scanCtx.draftId);
        save();
        toastShow({title:"確定", sub:"承認待ち"});
        scanCtx=null;
        setView("/field/done"); render();
      };
      return;
    }

    if (v === "/field/drafts"){
      app.innerHTML = screenDrafts();
      $("#back_field_home").onclick=()=>{ setView("/"); render(); };
      document.querySelectorAll("[data-resume]").forEach(b=>{
        b.onclick=()=>{
          const id = b.getAttribute("data-resume");
          const d = state.drafts.find(x=>x.id===id);
          if (!d) return;
          scanCtx = {
            draftId: d.id,
            step: d.step,
            operatorId: d.operatorId,
            patientId: d.patientId,
            procedureId: d.procedureId,
            place: d.place || "未設定",
            materials: d.materials || [],
            createdAt: d.createdAt,
            updatedAt: d.updatedAt
          };
          setView(`/field/scan/step/${d.step}`); render();
        };
      });
      return;
    }

    if (v === "/field/done"){
      app.innerHTML = screenDone();
      $("#back_field_home2").onclick=()=>{ setView("/"); render(); };

      const fSel = $("#done_filter");
      const box  = $("#done_filter_value");
      const list = $("#done_list");

      const today = new Date().toISOString().slice(0,10);

      const buildValue = (kind)=>{
        if (kind==="today"){ box.innerHTML = `<span class="tag">今日</span>`; return; }
        if (kind==="patient"){
          box.innerHTML = `<select class="select" id="f_patient"><option value="">選択</option>${PATIENTS.map(p=>`<option value="${p.id}">${p.label}</option>`).join("")}</select>`;
          $("#f_patient").onchange = renderList;
          return;
        }
        if (kind==="operator"){
          box.innerHTML = `<select class="select" id="f_operator"><option value="">選択</option>${OPERATORS.map(o=>`<option value="${o.id}">${o.label}</option>`).join("")}</select>`;
          $("#f_operator").onchange = renderList;
          return;
        }
        box.innerHTML = `<select class="select" id="f_place"><option value="">選択</option>${["カテ室","手術室","内視鏡","外来処置室","病棟","未設定"].map(x=>`<option value="${x}">${x}</option>`).join("")}</select>`;
        $("#f_place").onchange = renderList;
      };

      const renderList = ()=>{
        const kind = fSel.value;
        let items = state.done.filter(x=>x.date===today);
        if (kind==="patient"){
          const v = $("#f_patient")?.value || "";
          if (v) items = items.filter(x=>x.patientId===v);
        } else if (kind==="operator"){
          const v = $("#f_operator")?.value || "";
          if (v) items = items.filter(x=>x.operatorId===v);
        } else if (kind==="place"){
          const v = $("#f_place")?.value || "";
          if (v) items = items.filter(x=>x.place===v);
        }
        list.innerHTML = items.length ? items.map(x=>{
          const patient = PATIENTS.find(p=>p.id===x.patientId)?.label || x.patientId;
          const operator= OPERATORS.find(o=>o.id===x.operatorId)?.label || x.operatorId;
          const st = x.status==="pending" ? "承認待ち" : "承認済";
          return listItem(patient, `${operator} / ${x.place} / ${st}`, `<span class="tag">${(x.materials||[]).length}点</span>`);
        }).join("") : `<div class="muted">当日データなし</div>`;
      };

      buildValue("today");
      renderList();
      fSel.onchange = ()=>{ buildValue(fSel.value); renderList(); };
      return;
    }

    // default
    app.innerHTML = screenFieldHome();
    $("#go_field_scan").onclick=()=>{ scanCtx=null; setView("/field/scan/step/1"); render(); };
    $("#go_field_drafts").onclick=()=>{ setView("/field/drafts"); render(); };
    $("#go_field_done").onclick=()=>{ setView("/field/done"); render(); };
    return;
  }

  if (role === "billing"){
    if (v === "/"){
      app.innerHTML = screenBillingHome();
      $("#go_bill_done").onclick=()=>{ setView("/billing/done"); render(); };
      $("#go_bill_pending").onclick=()=>{ setView("/billing/pending"); render(); };
      $("#go_bill_master").onclick=()=>{ setView("/billing/master"); render(); };
      return;
    }
    if (v === "/billing/done" || v === "/billing/pending"){
      app.innerHTML = screenBillingList(v.endsWith("pending") ? "pending" : "done");
      $("#back_billing_home").onclick=()=>{ setView("/"); render(); };
      document.querySelectorAll("[data-openbill]").forEach(el=>{
        el.onclick = ()=>{
          const id = el.getAttribute("data-openbill");
          const item = state.done.find(x=>x.id===id);
          if (!item) return;
          const box = $("#billDetail");
          box.innerHTML = renderBillingDetail(item);
          box.style.display="block";
          $("#close_bill_detail").onclick = ()=>{ box.style.display="none"; };
        };
      });
      return;
    }
    if (v === "/billing/master"){
      app.innerHTML = screenBillingMaster();
      $("#back_billing_home2").onclick=()=>{ setView("/"); render(); };
      return;
    }

    app.innerHTML = screenBillingHome();
    $("#go_bill_done").onclick=()=>{ setView("/billing/done"); render(); };
    $("#go_bill_pending").onclick=()=>{ setView("/billing/pending"); render(); };
    $("#go_bill_master").onclick=()=>{ setView("/billing/master"); render(); };
    return;
  }
}

/* ---------------------------
   top role change
---------------------------- */
$("#btnRole").onclick = ()=>{
  // role reset only. state stays.
  role = "";
  save();
  setView("/role");
  render();
};

window.addEventListener("hashchange", render);

/* ---------------------------
   boot
---------------------------- */
(async function(){
  await bootData();
  if (!location.hash) setView("/");
  setRolePill(role);
  render();
})();
