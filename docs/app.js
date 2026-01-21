import { Scanner, parseGS1ForGTIN14, normalizeJan13 } from "./scan.js";

/* =========================
   Tuning
========================= */
const LS = { role:"linqval_role_v2", state:"linqval_state_v13" };
const TOAST_MS = 5400;

const ANY_SCAN_COOLDOWN_MS = 4500;
const SAME_CODE_COOLDOWN_MS = 8000;

// 誤読を減らす：同一コードを短時間に2回読めたら採用
const DOUBLE_HIT_WINDOW_MS = 1200;

/* =========================
   Helpers
========================= */
const $ = (s)=>document.querySelector(s);
const iso = ()=>new Date().toISOString();
const jpy = (n)=> (Number(n||0)).toLocaleString("ja-JP");
function safeParse(s, fb){ try { return JSON.parse(s); } catch { return fb; } }
function uid(prefix="ID"){ return `${prefix}-${Math.random().toString(16).slice(2,10)}-${Date.now().toString(36)}`; }

function toastShow({ title, price, sub }){
  $("#toastTitle").textContent = title || "OK";
  $("#toastPrice").textContent = price ? `${jpy(price)}円` : "";
  $("#toastSub").textContent = sub || "";
  $("#toast").classList.add("show");
  setTimeout(()=> $("#toast").classList.remove("show"), TOAST_MS);
}

const ROLES = [
  { id:"doctor", label:"医師" },
  { id:"field",  label:"実施入力" },
  { id:"billing",label:"医事" },
];
function setRolePill(roleId){
  const r = ROLES.find(x=>x.id===roleId);
  $("#rolePill").textContent = `職種：${r ? r.label : "未選択"}`;
}

function btn(label, id, kind=""){
  const cls = kind === "primary" ? "btn primary" : kind === "ghost" ? "btn ghost" : "btn";
  return `<button class="${cls}" id="${id}">${label}</button>`;
}
function listItem(htmlLeft, htmlRight=""){
  return `<div class="listItem"><div style="flex:1;min-width:0;">${htmlLeft}</div><div>${htmlRight}</div></div>`;
}

/* =========================
   Check digit validation
========================= */
function mod10Check(numStr){
  const s = String(numStr||"");
  if (!/^\d+$/.test(s)) return false;
  const digits = s.split("").map(d=>Number(d));
  const check = digits[digits.length-1];
  const body = digits.slice(0, -1);
  let sum = 0;
  let w = 3;
  for (let i=body.length-1;i>=0;i--){
    sum += body[i]*w;
    w = (w===3)?1:3;
  }
  const calc = (10 - (sum % 10)) % 10;
  return calc === check;
}
const validEan13 = (x)=> /^\d{13}$/.test(x) && mod10Check(x);
const validGtin14= (x)=> /^\d{14}$/.test(x) && mod10Check(x);

/* =========================
   State
========================= */
function defaultState(){
  return { drafts:[], done:[], docsDrafts:{} };
}
let role = localStorage.getItem(LS.role) || "";
let state = safeParse(localStorage.getItem(LS.state), null) || defaultState();
function save(){
  localStorage.setItem(LS.role, role);
  localStorage.setItem(LS.state, JSON.stringify(state));
}

/* =========================
   Data (fallback)
========================= */
const FALLBACK_OPERATORS = [
  { id:"op1", label:"看護師A" },{ id:"op2", label:"看護師B" },{ id:"op3", label:"臨床工学C" }
];
const FALLBACK_PATIENTS = [
  { id:"pt1", label:"患者001" },{ id:"pt2", label:"患者002" },{ id:"pt3", label:"患者003" }
];
const FALLBACK_PROCEDURES = [
  { id:"pr1", label:"PCI" },{ id:"pr2", label:"冠動脈造影" },{ id:"pr3", label:"ステント留置" }
];
const FALLBACK_BILLMAP = { byTokuteiName:{}, byProductName:{} };

async function loadJSON(path, fallback){
  try{ const r = await fetch(path, {cache:"no-store"}); if(!r.ok) return fallback; return await r.json(); }
  catch{ return fallback; }
}

let OPERATORS=[], PATIENTS=[], PROCEDURES=[], BILLMAP={};
async function bootData(){
  OPERATORS = await loadJSON("./data/operators.json", FALLBACK_OPERATORS);
  PATIENTS  = await loadJSON("./data/patients.json",  FALLBACK_PATIENTS);
  PROCEDURES= await loadJSON("./data/procedures.json",FALLBACK_PROCEDURES);
  BILLMAP   = await loadJSON("./data/billing_map.json", FALLBACK_BILLMAP);

  if (!Array.isArray(OPERATORS)||!OPERATORS.length) OPERATORS=FALLBACK_OPERATORS;
  if (!Array.isArray(PATIENTS)||!PATIENTS.length) PATIENTS=FALLBACK_PATIENTS;
  if (!Array.isArray(PROCEDURES)||!PROCEDURES.length) PROCEDURES=FALLBACK_PROCEDURES;
}

/* =========================
   Dict CSV
========================= */
function parseCsvLine(line){
  const out=[]; let cur=""; let q=false;
  for (let i=0;i<line.length;i++){
    const ch=line[i];
    if (ch === '"'){
      if (q && line[i+1] === '"'){ cur+='"'; i++; } else q=!q;
    } else if (ch === "," && !q){ out.push(cur); cur=""; }
    else cur+=ch;
  }
  out.push(cur);
  return out;
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
async function fetchText(url){
  const res = await fetch(url, { cache:"no-store" });
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  return await res.text();
}
function buildJanPath(jan13){ return `./dict_jan/${jan13.slice(0,3)}/${jan13.slice(0,4)}.csv`; }
function buildGtinPath(gtin14){ return `./gtin_index/${gtin14.slice(0,3)}/${gtin14.slice(0,4)}.csv`; }

function mapDictRow(row){
  const product_name = (row["product_name"]||"").trim() || "(名称不明)";
  const totalRaw = (row["total_reimbursement_price_yen"]||"").toString();
  const total = totalRaw ? Number(totalRaw.replace(/[^\d]/g,"")) : 0;
  const tokutei01_name = (row["tokutei01_name"]||"").trim();

  const tokutei_details = [];
  for (let i=1;i<=10;i++){
    const nn = String(i).padStart(2,"0");
    const name = (row[`tokutei${nn}_name`]||"").trim();
    const pr = (row[`tokutei${nn}_price`]||"").toString();
    const price = pr ? Number(pr.replace(/[^\d]/g,"")) : 0;
    if (name || price) tokutei_details.push({ idx: nn, name, price });
  }
  return { product_name, total_reimbursement_price_yen: total, tokutei01_name, tokutei_details };
}

async function lookupByJan13(jan13){
  try{
    const csv = await fetchText(buildJanPath(jan13));
    const rows = csvToObjects(csv);
    const keys = ["jan13keta","jan13","JAN13","jan","JAN","code","barcode"];
    const hit = rows.find(r => keys.some(k => r[k] === jan13));
    if (!hit) return { status:"no_match" };
    return { status:"hit", row: hit };
  } catch(e){
    return { status:"dict_fetch_error", error:e.message };
  }
}
async function lookupJanFromGtin14(gtin14){
  try{
    const csv = await fetchText(buildGtinPath(gtin14));
    const rows = csvToObjects(csv);
    const gtKeys = ["gtin14","GTIN14","gtin","GTIN","01","ai01"];
    const janKeys= ["jan13keta","jan13","JAN13","jan","JAN"];
    const found = rows.find(r => gtKeys.some(k => r[k] === gtin14));
    if (!found) return { status:"no_match" };
    const jan13 = janKeys.map(k=>found[k]).find(v=> String(v||"").match(/^\d{13}$/));
    if (!jan13) return { status:"no_match" };
    return { status:"hit", jan13 };
  } catch(e){
    return { status:"dict_fetch_error", error:e.message };
  }
}

/* =========================
   Billing map code
========================= */
function billingMapCode(material){
  const t = material?.tokutei01_name || "";
  const p = material?.product_name || "";
  return BILLMAP.byTokuteiName?.[t] || BILLMAP.byProductName?.[p] || "—";
}

/* =========================
   Routing + flow
========================= */
let scannerInst=null;
let scanCtx=null;
let lastScan = { anyTs:0, raw:"", sameTs:0 };
let candidate = { code:"", ts:0, count:0 };

function setView(hash){ location.hash = `#${hash}`; }
function view(){ return (location.hash || "#/").slice(1); }

function gotoRole(){
  try { scannerInst?.stop?.(); } catch {}
  role = "";
  save();
  location.hash = "#/role";
  render();
}
function ensureScanCtx(){
  if (!scanCtx){
    scanCtx = { draftId:uid("DRAFT"), step:1, operatorId:"", patientId:"", procedureId:"", place:"未設定", materials:[], createdAt:iso(), updatedAt:iso() };
  }
}
function upsertDraft(){
  ensureScanCtx();
  const idx = state.drafts.findIndex(d=>d.id===scanCtx.draftId);
  const d = { id:scanCtx.draftId, step:scanCtx.step, operatorId:scanCtx.operatorId, patientId:scanCtx.patientId, procedureId:scanCtx.procedureId, place:scanCtx.place, materials:scanCtx.materials||[], createdAt:scanCtx.createdAt, updatedAt:iso() };
  if (idx>=0) state.drafts[idx]=d; else state.drafts.unshift(d);
  save();
}

/* =========================
   Doctor docs
========================= */
function ensureDocsPatient(pid){
  state.docsDrafts[pid] = state.docsDrafts[pid] || { symptom:[], reply:[], other:[] };
  return state.docsDrafts[pid];
}

/* =========================
   Screens
========================= */
function screenRole(){
  return `
    <div class="grid"><div class="card">
      <div class="h1">職種</div><div class="divider"></div>
      <div class="grid">
        ${btn("👨‍⚕️ 医師","role_doctor","primary")}
        ${btn("📷 実施入力","role_field","primary")}
        ${btn("🧾 医事","role_billing","primary")}
      </div>
    </div></div>`;
}

/* Doctor */
function screenDoctorHome(){
  return `<div class="grid"><div class="card">
    <div class="h1">医師</div>
    <div class="grid">
      ${btn("✅ 承認","go_doc_approve","primary")}
      ${btn("📝 Docs","go_doc_docs","primary")}
    </div>
  </div></div>`;
}
function screenDoctorApprovals(){
  const pending = state.done.filter(x=>x.status==="pending");
  const list = pending.length ? pending.map(x=>{
    const patient = PATIENTS.find(p=>p.id===x.patientId)?.label || x.patientId;
    const operator= OPERATORS.find(o=>o.id===x.operatorId)?.label || x.operatorId;
    const hasC = x.doctor_comment ? "💬" : "";
    return `
      <div class="listItem">
        <div style="display:flex;gap:12px;align-items:center;">
          <input class="check" type="checkbox" data-chk="${x.id}">
          <div style="min-width:0;">
            <b>${patient} ${hasC}</b>
            <div class="muted">${operator} / ${x.place||"未設定"}</div>
          </div>
        </div>
        <button class="btn small" data-open-approve="${x.id}">詳細</button>
      </div>`;
  }).join("") : `<div class="muted">承認待ちなし</div>`;

  return `<div class="grid">
    <div class="card">
      <div class="h1">承認</div><div class="divider"></div>

      <div class="h2">一括コメント（任意）</div>
      <textarea id="bulk_comment" style="width:100%;height:90px;border-radius:16px;border:1px solid #f2d2dd;padding:12px;font-size:16px;outline:none;"></textarea>

      <div class="divider"></div>
      <div class="grid">${list}</div>

      <div class="divider"></div>
      <div class="row">
        ${btn("✅ 一括承認","bulk_approve","primary")}
        ${btn("⬅ 戻る","back_doc_home","ghost")}
      </div>
    </div>

    <div class="card" id="approveDetail" style="display:none;"></div>
  </div>`;
}
function renderApprovalDetail(item){
  const patient = PATIENTS.find(p=>p.id===item.patientId)?.label || item.patientId;
  const proc = PROCEDURES.find(p=>p.id===item.procedureId)?.label || "未選択";
  const mats = (item.materials||[]).map(m=>{
    const left = `<b>${m.product_name||"(不明)"}</b><div class="muted">${m.tokutei01_name||""}</div>`;
    return listItem(left, "");
  }).join("") || `<div class="muted">材料なし</div>`;

  return `
    <div class="h2">詳細</div>
    ${listItem(`<b>患者</b><div class="muted">${patient}</div>`)}
    ${listItem(`<b>手技</b><div class="muted">${proc}</div>`)}
    <div class="divider"></div>
    <div class="h2">材料</div>
    <div class="grid">${mats}</div>

    <div class="divider"></div>
    <div class="h2">コメント</div>
    <textarea id="doctor_comment" style="width:100%;height:110px;border-radius:16px;border:1px solid #f2d2dd;padding:12px;font-size:16px;outline:none;"></textarea>

    <div class="divider"></div>
    <div class="row">
      <button class="btn primary" id="approve_with_comment">✅ 承認</button>
      <button class="btn ghost" id="close_detail">✖ 閉じる</button>
    </div>
  `;
}
function screenDoctorDocs(){
  return `<div class="grid">
    <div class="card">
      <div class="h1">Docs</div><div class="divider"></div>
      <select class="select" id="docs_patient">
        ${PATIENTS.map(p=>`<option value="${p.id}">${p.label}</option>`).join("")}
      </select>
      <div class="divider"></div>
      <div class="grid">
        ${btn("🩺 症状詳記","docs_symptom","primary")}
        ${btn("✉️ 返書","docs_reply","primary")}
        ${btn("📎 その他","docs_other","primary")}
        ${btn("⬅ 戻る","back_doc_home2","ghost")}
      </div>
    </div>
    <div class="card" id="docsList" style="display:none;"></div>
    <div class="card" id="docsEditor" style="display:none;"></div>
  </div>`;
}

/* Field */
function screenFieldHome(){
  return `<div class="grid"><div class="card">
    <div class="h1">実施入力</div>
    <div class="grid">
      ${btn("📷 スキャン","go_field_scan","primary")}
      ${btn("🗂 下書き","go_field_drafts","primary")}
      ${btn("📅 実施済み","go_field_done","primary")}
    </div>
  </div></div>`;
}
function screenDrafts(){
  const list = state.drafts.length ? state.drafts.map(d=>{
    const pt = PATIENTS.find(p=>p.id===d.patientId)?.label || "患者未選択";
    const op = OPERATORS.find(o=>o.id===d.operatorId)?.label || "入力者未選択";
    return `<div class="listItem">
      <div><b>${pt}</b><div class="muted">${op} / ${(d.materials||[]).length}点</div></div>
      <button class="btn small" data-resume="${d.id}">続き</button>
    </div>`;
  }).join("") : `<div class="muted">下書きなし</div>`;

  return `<div class="grid"><div class="card">
    <div class="h1">下書き</div><div class="divider"></div>
    <div class="grid">${list}</div>
    <div class="divider"></div>
    ${btn("⬅ 戻る","back_field_home","ghost")}
  </div></div>`;
}
function screenDone(){
  const today = new Date().toISOString().slice(0,10);
  const items = state.done.filter(x=>x.date===today);
  const list = items.length ? items.map(x=>{
    const pt = PATIENTS.find(p=>p.id===x.patientId)?.label || x.patientId;
    const op = OPERATORS.find(o=>o.id===x.operatorId)?.label || x.operatorId;
    const st = x.status==="pending" ? "承認待ち" : "承認済";
    const c  = x.doctor_comment ? "💬" : "";
    return listItem(`<b>${pt} ${c}</b><div class="muted">${op} / ${st}</div>`, `<span class="tag">${(x.materials||[]).length}点</span>`);
  }).join("") : `<div class="muted">当日データなし</div>`;

  return `<div class="grid"><div class="card">
    <div class="h1">実施済み</div><div class="divider"></div>
    <div class="grid">${list}</div>
    <div class="divider"></div>
    ${btn("⬅ 戻る","back_field_home2","ghost")}
  </div></div>`;
}
function screenFieldStep(step){
  ensureScanCtx(); scanCtx.step=step;

  const saveBar = `<div class="row">
    <button class="btn ghost" id="save_draft_any">💾 下書き</button>
    <button class="btn ghost" id="cancel_flow">✖ 中止</button>
  </div>`;

  if (step===1){
    return `<div class="grid"><div class="card">
      <div class="h1">入力者</div><div class="divider"></div>
      <select class="select" id="op_select">
        <option value="">選択</option>
        ${OPERATORS.map(o=>`<option value="${o.id}" ${scanCtx.operatorId===o.id?"selected":""}>${o.label}</option>`).join("")}
      </select>
      <div class="divider"></div>${btn("➡ 次へ","to_step2","primary")}
      <div class="divider"></div>${saveBar}
    </div></div>`;
  }
  if (step===2){
    return `<div class="grid"><div class="card">
      <div class="h1">患者</div><div class="divider"></div>
      <select class="select" id="pt_select">
        <option value="">選択</option>
        ${PATIENTS.map(p=>`<option value="${p.id}" ${scanCtx.patientId===p.id?"selected":""}>${p.label}</option>`).join("")}
      </select>
      <div class="divider"></div>${btn("➡ 次へ","to_step3","primary")}
      <div class="divider"></div>${saveBar}
    </div></div>`;
  }
  if (step===3){
    return `<div class="grid"><div class="card">
      <div class="h1">手技</div><div class="divider"></div>
      <select class="select" id="proc_select">
        <option value="">選択</option>
        ${PROCEDURES.map(p=>`<option value="${p.id}" ${scanCtx.procedureId===p.id?"selected":""}>${p.label}</option>`).join("")}
      </select>
      <div class="divider"></div>${btn("➡ 次へ","to_step4","primary")}
      <div class="divider"></div>${saveBar}
    </div></div>`;
  }
  if (step===4){
    return `<div class="grid"><div class="card">
      <div class="h1">材料</div><div class="divider"></div>
      <div class="videoBox" id="scannerTarget"></div>
      <div class="divider"></div>
      <div class="row">
        <button class="btn primary" id="scan_start">▶ Start</button>
        <button class="btn ghost" id="scan_stop" disabled>■ Stop</button>
        <button class="btn ghost" id="to_confirm">✅ 確定</button>
      </div>
      <div class="divider"></div>
      <div class="grid" id="matList"></div>
      <div class="divider"></div>${saveBar}
    </div></div>`;
  }

  return `<div class="grid"><div class="card">
    <div class="h1">確定</div><div class="divider"></div>

    <div class="listItem"><div style="width:100%;">
      <b>入力者</b><div style="height:8px;"></div>
      <select class="select" id="op_select2">
        <option value="">未選択</option>
        ${OPERATORS.map(o=>`<option value="${o.id}" ${scanCtx.operatorId===o.id?"selected":""}>${o.label}</option>`).join("")}
      </select>
    </div></div>

    <div class="listItem"><div style="width:100%;">
      <b>患者</b><div style="height:8px;"></div>
      <select class="select" id="pt_select2">
        <option value="">未選択</option>
        ${PATIENTS.map(p=>`<option value="${p.id}" ${scanCtx.patientId===p.id?"selected":""}>${p.label}</option>`).join("")}
      </select>
    </div></div>

    <div class="listItem"><div style="width:100%;">
      <b>手技</b><div style="height:8px;"></div>
      <select class="select" id="proc_select2">
        <option value="">未選択</option>
        ${PROCEDURES.map(p=>`<option value="${p.id}" ${scanCtx.procedureId===p.id?"selected":""}>${p.label}</option>`).join("")}
      </select>
    </div></div>

    <div class="divider"></div>
    <div class="grid" id="confirmList"></div>

    <div class="divider"></div>
    <div class="row">
      ${btn("✅ 実施済み","confirm_done","primary")}
      ${btn("⬅ 戻る","back_step4","ghost")}
      ${btn("💾 下書き","save_draft_any2","ghost")}
    </div>
  </div></div>`;
}

/* Billing */
function screenBillingHome(){
  return `<div class="grid"><div class="card">
    <div class="h1">医事</div>
    <div class="grid">
      ${btn("📄 実施入力済み","go_bill_done","primary")}
      ${btn("⏳ 承認待ち","go_bill_pending","primary")}
      ${btn("⬅ 戻る","back_bill_home","ghost")}
    </div>
  </div></div>`;
}
function screenBillingList(kind){
  const isPending = kind==="pending";
  const today = new Date().toISOString().slice(0,10);
  const items = state.done
    .filter(x=>x.date===today)
    .filter(x=> isPending ? x.status==="pending" : x.status!=="pending");

  const list = items.length ? items.map(x=>{
    const pt = PATIENTS.find(p=>p.id===x.patientId)?.label || x.patientId;
    const op = OPERATORS.find(o=>o.id===x.operatorId)?.label || x.operatorId;
    const c  = x.doctor_comment ? "💬" : "";
    return `<div class="listItem" data-openbill="${x.id}">
      <div><b>${pt} ${c}</b><div class="muted">${op}</div></div>
      <span class="tag">${(x.materials||[]).length}点</span>
    </div>`;
  }).join("") : `<div class="muted">データなし</div>`;

  return `<div class="grid">
    <div class="card">
      <div class="h1">${isPending ? "承認待ち" : "実施入力済み"}</div>
      <div class="divider"></div>
      <div class="grid">${list}</div>
      <div class="divider"></div>
      ${btn("⬅ 戻る","back_billing_home","ghost")}
    </div>
    <div class="card" id="billDetail" style="display:none;"></div>
  </div>`;
}
function triRow(product, ijiName, code, price){
  return `
    <div class="listItem" style="align-items:center;">
      <div class="triRow">
        <div class="c1"><b>${product||"(不明)"}</b></div>
        <div class="c2">${ijiName||""}</div>
        <div class="c3">${code||"—"}</div>
      </div>
    </div>
    ${price ? `<div class="muted" style="margin:6px 6px 14px;">${jpy(price)}円</div>` : `<div style="height:10px;"></div>`}
  `;
}
function renderTokuteiDetails(details){
  if (!details?.length) return `<div class="muted">内訳なし</div>`;
  return `<div class="grid" style="gap:8px;margin-top:10px;">${
    details.map(t=>{
      const pr = t.price ? `${jpy(t.price)}円` : "";
      return listItem(`<b>${t.name||"(名称なし)"}</b><div class="muted">${pr}</div>`);
    }).join("")
  }</div>`;
}
function renderBillingDetail(item){
  const comment = item.doctor_comment ? `<div class="card" style="box-shadow:none;border-radius:16px;margin:10px 0 0;padding:10px;">
    <div class="h2">医師コメント</div>
    <div class="muted">${item.doctor_comment}</div>
  </div>` : "";

  const mats = (item.materials||[]).map(m=>{
    const code = billingMapCode(m);
    const top = triRow(m.product_name, m.tokutei01_name, code, m.total_reimbursement_price_yen||0);
    const detail = renderTokuteiDetails(m.tokutei_details||[]);
    return `${top}${detail}`;
  }).join("") || `<div class="muted">材料なし</div>`;

  return `
    <div class="h2">詳細</div>
    ${comment}
    <div class="divider"></div>
    <div class="h2">材料</div>
    <div class="grid">${mats}</div>
    <div class="divider"></div>
    ${btn("✖ 閉じる","close_bill_detail","ghost")}
  `;
}

/* =========================
   Paint helpers
========================= */
function paintMatList(){
  const matList = $("#matList");
  if (!matList) return;

  const html = (scanCtx?.materials||[]).slice(0,12).map(m=>{
    const left = `<b>${m.product_name||"(不明)"}</b><div class="muted">${m.tokutei01_name||""}</div>`;
    const right = `<span class="tag">${m.dict_status||""}</span> <button class="btn small ghost" data-delmat="${m.id}">🗑</button>`;
    return listItem(left, right);
  }).join("") || `<div class="muted">材料なし</div>`;

  matList.innerHTML = html;
  matList.querySelectorAll("[data-delmat]").forEach(b=>{
    b.onclick = ()=>{
      const id = b.getAttribute("data-delmat");
      scanCtx.materials = (scanCtx.materials||[]).filter(x=>x.id!==id);
      upsertDraft();
      paintMatList();
    };
  });
}
function paintConfirmList(){
  const box = $("#confirmList");
  if (!box) return;

  const mats = (scanCtx.materials||[]).map(m=>{
    const left = `<b>${m.product_name||"(不明)"}</b><div class="muted">${m.tokutei01_name||""}</div>`;
    const right = `<button class="btn small ghost" data-delmat2="${m.id}">🗑</button>`;
    return listItem(left, right);
  }).join("") || `<div class="muted">材料なし</div>`;

  box.innerHTML = mats;
  box.querySelectorAll("[data-delmat2]").forEach(b=>{
    b.onclick = ()=>{
      const id = b.getAttribute("data-delmat2");
      scanCtx.materials = (scanCtx.materials||[]).filter(x=>x.id!==id);
      upsertDraft();
      paintConfirmList();
    };
  });
}
function highlightAndFocus(el){
  if (!el) return;
  el.scrollIntoView({ behavior:"smooth", block:"center" });
  try { el.focus(); } catch {}
  const prev = el.style.borderColor;
  el.style.borderColor = "rgba(255,59,107,.9)";
  setTimeout(()=>{ el.style.borderColor = prev || ""; }, 1500);
}

/* =========================
   Render
========================= */
function render(){
  setRolePill(role);

  // ヘッダーだけで職種切替
  $("#btnRole").onclick = gotoRole;
  $("#rolePill").onclick = gotoRole;

  const v = view();
  const app = $("#app");

  // scan以外で止める
  if (!v.startsWith("/field/scan/step/4")) {
    try { scannerInst?.stop?.(); } catch {}
  }

  // role未選択ならrole画面
  if (!role || v === "/role"){
    app.innerHTML = screenRole();
    $("#role_doctor").onclick=()=>{ role="doctor"; save(); location.hash="#/"; render(); };
    $("#role_field").onclick =()=>{ role="field";  save(); location.hash="#/"; render(); };
    $("#role_billing").onclick=()=>{ role="billing";save(); location.hash="#/"; render(); };
    return;
  }

  /* --------- Doctor --------- */
  if (role==="doctor"){
    if (v === "/" || v === ""){
      app.innerHTML = screenDoctorHome();
      $("#go_doc_approve").onclick=()=>{ setView("/doctor/approvals"); render(); };
      $("#go_doc_docs").onclick=()=>{ setView("/doctor/docs"); render(); };
      return;
    }

    if (v === "/doctor/approvals"){
      app.innerHTML = screenDoctorApprovals();
      $("#back_doc_home").onclick=()=>{ setView("/"); render(); };

      $("#bulk_approve").onclick=()=>{
        const bulkText = $("#bulk_comment").value || "";
        const checked = Array.from(document.querySelectorAll("[data-chk]"))
          .filter(x=>x.checked)
          .map(x=>x.getAttribute("data-chk"));

        if (!checked.length){ toastShow({title:"選択なし", sub:"チェックしてください"}); return; }

        checked.forEach(id=>{
          const it = state.done.find(x=>x.id===id);
          if (!it) return;
          it.status="approved";
          it.approved_at = iso();
          if (bulkText.trim()){
            it.doctor_comment = it.doctor_comment ? `${it.doctor_comment}\n---\n${bulkText}` : bulkText;
          }
        });
        save();
        toastShow({title:"一括承認", sub:`${checked.length}件`});
        render();
      };

      // ★個別詳細が開く
      document.querySelectorAll("[data-open-approve]").forEach(btn=>{
        btn.onclick = ()=>{
          const id = btn.getAttribute("data-open-approve");
          const item = state.done.find(x=>x.id===id);
          if (!item) return;
          const box = $("#approveDetail");
          box.innerHTML = renderApprovalDetail(item);
          box.style.display = "block";

          $("#doctor_comment").value = item.doctor_comment || "";

          $("#close_detail").onclick = ()=>{ box.style.display="none"; };

          $("#approve_with_comment").onclick = ()=>{
            item.status="approved";
            item.approved_at = iso();
            item.doctor_comment = $("#doctor_comment").value || "";
            save();
            toastShow({title:"承認", sub:"コメント保存"});
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

      const docsList=$("#docsList");
      const editor=$("#docsEditor");
      const patientSel=$("#docs_patient");

      const openKindList = (kind)=>{
        const pid = patientSel.value || PATIENTS[0]?.id;
        const doc = ensureDocsPatient(pid);
        const items = doc[kind] || [];
        const label = kind==="symptom"?"症状詳記":kind==="reply"?"返書":"その他";

        docsList.style.display="block";
        editor.style.display="none";

        docsList.innerHTML = `
          <div class="h2">${label}（下書き）</div><div class="divider"></div>
          <div class="grid">
            ${items.length ? items.map(d=>`
              <div class="listItem">
                <div><b>${d.title||label}</b><div class="muted">${new Date(d.updatedAt).toLocaleString("ja-JP")}</div></div>
                <button class="btn small" data-edit="${d.id}">編集</button>
              </div>`).join("") : `<div class="muted">下書きなし</div>`}
          </div>
          <div class="divider"></div>
          <div class="row">
            <button class="btn primary" id="new_doc">＋ 新規</button>
            <button class="btn ghost" id="close_list">✖ 閉じる</button>
          </div>
        `;

        $("#close_list").onclick=()=>{ docsList.style.display="none"; };
        $("#new_doc").onclick=()=> openEditor(kind, null);

        docsList.querySelectorAll("[data-edit]").forEach(b=>{
          b.onclick=()=> openEditor(kind, b.getAttribute("data-edit"));
        });
      };

      const openEditor = (kind, editId)=>{
        const pid = patientSel.value || PATIENTS[0]?.id;
        const doc = ensureDocsPatient(pid);
        const label = kind==="symptom"?"症状詳記":kind==="reply"?"返書":"その他";
        let draft = editId ? (doc[kind]||[]).find(x=>x.id===editId) : null;
        if(!draft) draft={ id:uid("DOC"), title:label, text:"", updatedAt:iso() };

        editor.style.display="block";
        docsList.style.display="none";

        editor.innerHTML = `
          <div class="h2">${label}</div><div class="divider"></div>
          <input class="input" id="doc_title" value="${draft.title||""}">
          <div class="divider"></div>
          <textarea id="doc_text" style="width:100%;height:220px;border-radius:16px;border:1px solid #f2d2dd;padding:12px;font-size:16px;outline:none;"></textarea>
          <div class="divider"></div>
          <div class="row">
            <button class="btn primary" id="doc_save">💾 保存</button>
            <button class="btn ghost" id="doc_back">⬅ 戻る</button>
          </div>
        `;
        $("#doc_text").value = draft.text||"";

        $("#doc_save").onclick=()=>{
          draft.title = ($("#doc_title").value.trim()||label);
          draft.text = $("#doc_text").value;
          draft.updatedAt = iso();
          const arr = doc[kind]||[];
          const idx = arr.findIndex(x=>x.id===draft.id);
          if(idx>=0) arr[idx]=draft; else arr.unshift(draft);
          doc[kind]=arr;
          state.docsDrafts[pid]=doc;
          save();
          toastShow({title:"保存", sub:label});
          openKindList(kind);
        };
        $("#doc_back").onclick=()=> openKindList(kind);
      };

      $("#docs_symptom").onclick=()=> openKindList("symptom");
      $("#docs_reply").onclick  =()=> openKindList("reply");
      $("#docs_other").onclick  =()=> openKindList("other");
      patientSel.onchange=()=>{ docsList.style.display="none"; editor.style.display="none"; };

      return;
    }

    setView("/"); render(); return;
  }

  /* --------- Field --------- */
  if (role==="field"){
    if (v === "/" || v === ""){
      app.innerHTML = screenFieldHome();
      $("#go_field_scan").onclick=()=>{ scanCtx=null; candidate={code:"",ts:0,count:0}; lastScan={anyTs:0,raw:"",sameTs:0}; setView("/field/scan/step/1"); render(); };
      $("#go_field_drafts").onclick=()=>{ setView("/field/drafts"); render(); };
      $("#go_field_done").onclick=()=>{ setView("/field/done"); render(); };
      return;
    }

    if (v === "/field/drafts"){
      app.innerHTML = screenDrafts();
      $("#back_field_home").onclick=()=>{ setView("/"); render(); };
      document.querySelectorAll("[data-resume]").forEach(b=>{
        b.onclick=()=>{
          const id=b.getAttribute("data-resume");
          const d=state.drafts.find(x=>x.id===id);
          if(!d) return;
          scanCtx={ draftId:d.id, step:d.step||1, operatorId:d.operatorId||"", patientId:d.patientId||"", procedureId:d.procedureId||"", place:d.place||"未設定", materials:d.materials||[], createdAt:d.createdAt||iso(), updatedAt:d.updatedAt||iso() };
          candidate={code:"",ts:0,count:0};
          lastScan={anyTs:0,raw:"",sameTs:0};
          setView(`/field/scan/step/${scanCtx.step}`); render();
        };
      });
      return;
    }

    if (v === "/field/done"){
      app.innerHTML = screenDone();
      $("#back_field_home2").onclick=()=>{ setView("/"); render(); };
      return;
    }

    if (v.startsWith("/field/scan/step/")){
      const step = Number(v.split("/").pop());
      app.innerHTML = screenFieldStep(step);

      const saveDraftExit = ()=>{
        upsertDraft();
        try { scannerInst?.stop?.(); } catch {}
        toastShow({title:"下書き", sub:"保存"});
        scanCtx=null;
        setView("/field/drafts"); render();
      };
      const cancel = ()=>{
        try { scannerInst?.stop?.(); } catch {}
        scanCtx=null;
        setView("/"); render();
      };
      $("#save_draft_any") && ($("#save_draft_any").onclick=saveDraftExit);
      $("#save_draft_any2") && ($("#save_draft_any2").onclick=saveDraftExit);
      $("#cancel_flow") && ($("#cancel_flow").onclick=cancel);

      if (step===1){
        $("#to_step2").onclick=()=>{
          ensureScanCtx();
          scanCtx.operatorId=$("#op_select").value||"";
          upsertDraft();
          setView("/field/scan/step/2"); render();
        };
        return;
      }
      if (step===2){
        $("#to_step3").onclick=()=>{
          ensureScanCtx();
          scanCtx.patientId=$("#pt_select").value||"";
          upsertDraft();
          setView("/field/scan/step/3"); render();
        };
        return;
      }
      if (step===3){
        $("#to_step4").onclick=()=>{
          ensureScanCtx();
          scanCtx.procedureId=$("#proc_select").value||scanCtx.procedureId||"";
          upsertDraft();
          setView("/field/scan/step/4"); render();
        };
        return;
      }

      if (step===4){
        ensureScanCtx();
        paintMatList();

        const startBtn=$("#scan_start"), stopBtn=$("#scan_stop"), target=$("#scannerTarget");
        const setBtns=(run)=>{ startBtn.disabled=!!run; stopBtn.disabled=!run; };

        const parseSupported = (raw)=>{
          const jan13 = normalizeJan13(raw);
          if (jan13 && validEan13(jan13)) return { kind:"jan13", jan13 };
          const gtin14 = parseGS1ForGTIN14(raw);
          if (gtin14 && validGtin14(gtin14)) return { kind:"gtin14", gtin14 };
          return null;
        };

        const acceptByDoubleHit = (code)=>{
          const now = Date.now();
          if (candidate.code === code && (now - candidate.ts) <= DOUBLE_HIT_WINDOW_MS){
            candidate.count += 1;
            candidate.ts = now;
          } else {
            candidate = { code, ts: now, count: 1 };
          }
          return candidate.count >= 2;
        };

        const onDetected = async (raw)=>{
          const supported = parseSupported(raw);
          if (!supported) return; // 不明は保存しない

          // 2回一致したら採用
          const codeKey = supported.kind==="jan13" ? supported.jan13 : supported.gtin14;
          if (!acceptByDoubleHit(codeKey)) return;

          const t = Date.now();
          if (t - lastScan.anyTs < ANY_SCAN_COOLDOWN_MS) return;
          if (codeKey === lastScan.raw && (t - lastScan.sameTs) < SAME_CODE_COOLDOWN_MS) return;

          lastScan.anyTs = t;
          if (codeKey === lastScan.raw) lastScan.sameTs = t;
          else { lastScan.raw = codeKey; lastScan.sameTs = t; }

          const item = {
            id: uid("MAT"),
            raw:String(raw||""),
            jan13:null,
            gtin14:null,
            dict_status:"unknown",
            product_name:"",
            total_reimbursement_price_yen:0,
            tokutei01_name:"",
            tokutei_details:[]
          };

          if (supported.kind==="jan13"){
            item.jan13 = supported.jan13;
            const r = await lookupByJan13(item.jan13);
            item.dict_status = r.status;
            if (r.status==="hit"){
              Object.assign(item, mapDictRow(r.row));
              toastShow({ title:item.product_name, price:item.total_reimbursement_price_yen, sub:item.tokutei01_name });
            } else if (r.status==="no_match"){
              toastShow({ title:"読み取りOK", sub:"辞書0件（回収対象）" });
            } else {
              toastShow({ title:"読み取りOK", sub:"辞書取得失敗（回収対象）" });
            }
          } else {
            item.gtin14 = supported.gtin14;
            const g = await lookupJanFromGtin14(item.gtin14);
            if (g.status==="hit"){
              item.jan13 = g.jan13;
              const r = await lookupByJan13(item.jan13);
              item.dict_status = r.status;
              if (r.status==="hit"){
                Object.assign(item, mapDictRow(r.row));
                toastShow({ title:item.product_name, price:item.total_reimbursement_price_yen, sub:item.tokutei01_name });
              } else if (r.status==="no_match"){
                toastShow({ title:"読み取りOK", sub:"辞書0件（回収対象）" });
              } else {
                toastShow({ title:"読み取りOK", sub:"辞書取得失敗（回収対象）" });
              }
            } else {
              item.dict_status="no_match";
              toastShow({ title:"読み取りOK", sub:"索引0件（回収対象）" });
            }
          }

          scanCtx.materials.unshift(item);
          upsertDraft();
          paintMatList();

          // 次の候補が暴走しないように一旦リセット
          candidate = { code:"", ts:0, count:0 };
        };

        if (!scannerInst){
          scannerInst = new Scanner({ targetEl: target, onDetected, onError:(e)=>toastShow({title:"Start失敗", sub:e.message}) });
        } else scannerInst.targetEl = target;

        setBtns(scannerInst.isRunning?.()||false);
        startBtn.onclick=async()=>{ await scannerInst.start(); setBtns(true); };
        stopBtn.onclick=()=>{ scannerInst.stop(); setBtns(false); };

        $("#to_confirm").onclick=()=>{
          scannerInst?.stop?.();
          upsertDraft();
          setView("/field/scan/step/5"); render();
        };
        return;
      }

      // step5 confirm
      ensureScanCtx();
      paintConfirmList();

      const op2=$("#op_select2"), pt2=$("#pt_select2"), pr2=$("#proc_select2");
      op2.onchange=()=>{ scanCtx.operatorId=op2.value||""; upsertDraft(); };
      pt2.onchange=()=>{ scanCtx.patientId=pt2.value||""; upsertDraft(); };
      pr2.onchange=()=>{ scanCtx.procedureId=pr2.value||""; upsertDraft(); };

      $("#back_step4").onclick=()=>{ setView("/field/scan/step/4"); render(); };
      $("#save_draft_any2").onclick=saveDraftExit;

      $("#confirm_done").onclick=()=>{
        ensureScanCtx();
        if (!scanCtx.operatorId){ toastShow({title:"未選択", sub:"入力者を選択"}); highlightAndFocus(op2); return; }
        if (!scanCtx.patientId){ toastShow({title:"未選択", sub:"患者を選択"}); highlightAndFocus(pt2); return; }
        if (!scanCtx.procedureId){ toastShow({title:"未選択", sub:"手技を選択"}); highlightAndFocus(pr2); return; }
        if (!scanCtx.materials?.length){ toastShow({title:"材料なし", sub:"スキャンしてください"}); highlightAndFocus($("#confirmList")); return; }

        state.done.unshift({
          id: uid("DONE"),
          date: new Date().toISOString().slice(0,10),
          operatorId: scanCtx.operatorId,
          patientId: scanCtx.patientId,
          place: scanCtx.place || "未設定",
          procedureId: scanCtx.procedureId,
          materials: scanCtx.materials || [],
          status: "pending",
          confirmedAt: iso(),
          doctor_comment: ""
        });

        state.drafts = state.drafts.filter(d=>d.id!==scanCtx.draftId);
        save();

        scanCtx=null;
        candidate={code:"",ts:0,count:0};
        lastScan={anyTs:0,raw:"",sameTs:0};
        toastShow({title:"確定", sub:"承認待ちへ"});
        setView("/field/done"); render();
      };

      return;
    }

    setView("/"); render(); return;
  }

  /* --------- Billing --------- */
  if (role==="billing"){
    if (v === "/" || v === ""){
      app.innerHTML = screenBillingHome();
      $("#go_bill_done").onclick=()=>{ setView("/billing/done"); render(); };
      $("#go_bill_pending").onclick=()=>{ setView("/billing/pending"); render(); };
      $("#back_bill_home").onclick=()=>{ setView("/"); render(); };
      return;
    }
    if (v === "/billing/done" || v === "/billing/pending"){
      app.innerHTML = screenBillingList(v.endsWith("pending")?"pending":"done");
      $("#back_billing_home").onclick=()=>{ setView("/"); render(); };

      document.querySelectorAll("[data-openbill]").forEach(el=>{
        el.onclick=()=>{
          const id = el.getAttribute("data-openbill");
          const item = state.done.find(x=>x.id===id);
          if(!item) return;
          const box=$("#billDetail");
          box.innerHTML = renderBillingDetail(item);
          box.style.display="block";
          $("#close_bill_detail").onclick=()=>{ box.style.display="none"; };
        };
      });
      return;
    }
    setView("/"); render(); return;
  }

  // fallback
  setView("/"); render();
}

/* =========================
   Boot
========================= */
(async function(){
  await bootData();
  window.addEventListener("hashchange", render);
  if (!location.hash) location.hash="#/role";
  setRolePill(role);
  save();
  render();
})();
