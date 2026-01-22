import { Scanner, parseGS1ForGTIN14, normalizeJan13 } from "./scan.js";

/* =========================
   Tuning
========================= */
const LS = {
  role: "linqval_role_v3",
  state: "linqval_state_v15",
  doctor: "linqval_doctor_profile_v1"
};
const TOAST_MS = 5400;

// ✅ 1秒早く
const ANY_SCAN_COOLDOWN_MS = 3500;
const SAME_CODE_COOLDOWN_MS = 8000;

// 誤読を減らす：同一コードを短時間に2回読めたら採用
const DOUBLE_HIT_WINDOW_MS = 1200;

/* =========================
   Helpers
========================= */
const $ = (s)=>document.querySelector(s);
const iso = ()=>new Date().toISOString();
const todayStr = ()=>new Date().toISOString().slice(0,10);
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
function highlightAndFocus(el){
  if (!el) return;
  el.scrollIntoView({ behavior:"smooth", block:"center" });
  try { el.focus(); } catch {}
  const prev = el.style.borderColor;
  el.style.borderColor = "rgba(255,59,107,.9)";
  setTimeout(()=>{ el.style.borderColor = prev || ""; }, 1400);
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
  return {
    drafts: [],
    done: [],     // 実施入力済み（承認待ち/承認済み）
    docsByDoctor: {} // key: `${dept}__${doctorId}` => {symptom:[], reply:[], other:[]}
  };
}
let role = localStorage.getItem(LS.role) || "";
let state = safeParse(localStorage.getItem(LS.state), null) || defaultState();
let doctorProfile = safeParse(localStorage.getItem(LS.doctor), null) || { dept:"", doctorId:"" };

function save(){
  localStorage.setItem(LS.role, role);
  localStorage.setItem(LS.state, JSON.stringify(state));
  localStorage.setItem(LS.doctor, JSON.stringify(doctorProfile));
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
// 主治医候補（実データ連携に差し替え想定）
const FALLBACK_DOCTORS = [
  { id:"dr001", name:"医師A", dept:"循環器内科" },
  { id:"dr002", name:"医師B", dept:"循環器内科" },
  { id:"dr101", name:"医師C", dept:"心臓血管外科" },
];

const FALLBACK_BILLMAP = { byTokuteiName:{}, byProductName:{} };

async function loadJSON(path, fallback){
  try{ const r = await fetch(path, {cache:"no-store"}); if(!r.ok) return fallback; return await r.json(); }
  catch{ return fallback; }
}

let OPERATORS=[], PATIENTS=[], PROCEDURES=[], DOCTORS=[], BILLMAP={};
async function bootData(){
  OPERATORS = await loadJSON("./data/operators.json", FALLBACK_OPERATORS);
  PATIENTS  = await loadJSON("./data/patients.json",  FALLBACK_PATIENTS);
  PROCEDURES= await loadJSON("./data/procedures.json",FALLBACK_PROCEDURES);
  DOCTORS   = await loadJSON("./data/doctors.json", FALLBACK_DOCTORS);
  BILLMAP   = await loadJSON("./data/billing_map.json", FALLBACK_BILLMAP);

  if (!Array.isArray(OPERATORS)||!OPERATORS.length) OPERATORS=FALLBACK_OPERATORS;
  if (!Array.isArray(PATIENTS)||!PATIENTS.length) PATIENTS=FALLBACK_PATIENTS;
  if (!Array.isArray(PROCEDURES)||!PROCEDURES.length) PROCEDURES=FALLBACK_PROCEDURES;
  if (!Array.isArray(DOCTORS)||!DOCTORS.length) DOCTORS=FALLBACK_DOCTORS;
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
  const product_no   = (row["product_no"]||"").trim();
  const product_sta  = (row["product_sta"]||"").trim();

  const totalRaw = (row["total_reimbursement_price_yen"]||"").toString();
  const total = totalRaw ? Number(totalRaw.replace(/[^\d]/g,"")) : 0;

  const tokutei01_name = (row["tokutei01_name"]||"").trim();

  return {
    product_name,
    product_no,
    product_sta,
    total_reimbursement_price_yen: total,
    tokutei01_name
  };
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
// scanCtx.editDoneId: 既存「承認待ち」レコードを修正する場合にセット
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
    scanCtx = {
      draftId:uid("DRAFT"),
      step:1,
      operatorId:"",
      patientId:"",
      procedureId:"",
      place:"未設定",
      materials:[],
      createdAt:iso(),
      updatedAt:iso(),
      editDoneId:null,     // ✅ 修正モード
      assignedDoctorId:""  // ✅ 主治医
    };
  }
}

function upsertDraft(){
  ensureScanCtx();
  const idx = state.drafts.findIndex(d=>d.id===scanCtx.draftId);
  const d = {
    id:scanCtx.draftId,
    step:scanCtx.step,
    operatorId:scanCtx.operatorId,
    patientId:scanCtx.patientId,
    procedureId:scanCtx.procedureId,
    place:scanCtx.place,
    materials:scanCtx.materials||[],
    assignedDoctorId: scanCtx.assignedDoctorId||"",
    editDoneId: scanCtx.editDoneId || null,
    createdAt:scanCtx.createdAt,
    updatedAt:iso()
  };
  if (idx>=0) state.drafts[idx]=d; else state.drafts.unshift(d);
  save();
}

/* =========================
   Doctor profile + Docs
========================= */
function doctorKey(){
  const dept = (doctorProfile.dept||"").trim();
  const id = (doctorProfile.doctorId||"").trim();
  return `${dept}__${id}`;
}
function ensureDoctorDocs(){
  const key = doctorKey();
  state.docsByDoctor[key] = state.docsByDoctor[key] || { symptom:[], reply:[], other:[] };
  return state.docsByDoctor[key];
}
function doctorLabelById(id){
  const d = DOCTORS.find(x=>x.id===id);
  return d ? `${d.dept} ${d.name}（${d.id}）` : id || "未選択";
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
        ${btn("📶 実施入力","role_field","primary")}
        ${btn("🧾 医事","role_billing","primary")}
      </div>
    </div></div>`;
}

/* ---------- Doctor ---------- */
function screenDoctorLogin(){
  return `
    <div class="grid"><div class="card">
      <div class="h1">医師ログイン</div>
      <div class="muted">診療科と医師IDを入力してください</div>
      <div class="divider"></div>

      <div class="h2">診療科</div>
      <input class="input" id="doc_dept" placeholder="例：循環器内科" value="${(doctorProfile.dept||"").replace(/"/g,"")}" />
      <div class="divider"></div>

      <div class="h2">医師ID</div>
      <input class="input" id="doc_id" placeholder="例：dr001" value="${(doctorProfile.doctorId||"").replace(/"/g,"")}" />
      <div class="divider"></div>

      ${btn("開始","doc_login_go","primary")}
      <div class="divider"></div>
      ${btn("クリア","doc_login_clear","ghost")}
    </div></div>
  `;
}

function screenDoctorHome(){
  const dept = (doctorProfile.dept||"").trim();
  const did  = (doctorProfile.doctorId||"").trim();
  return `
    <div class="grid"><div class="card">
      <div class="h1">医師</div>
      <div class="muted">${dept} / ID: ${did}</div>
      <div class="divider"></div>
      <div class="grid">
        ${btn("✅ 承認","go_doc_approve","primary")}
        ${btn("📝 Docs","go_doc_docs","primary")}
      </div>
    </div></div>
  `;
}

function screenDoctorApprovals(){
  const did = (doctorProfile.doctorId||"").trim();
  const pending = state.done
    .filter(x=>x.status==="pending")
    .filter(x=>x.assignedDoctorId===did);

  const list = pending.length ? pending.map(x=>{
    const patient = PATIENTS.find(p=>p.id===x.patientId)?.label || x.patientId || "患者未選択";
    const operator= OPERATORS.find(o=>o.id===x.operatorId)?.label || x.operatorId || "入力者未選択";
    return `
      <div class="listItem">
        <div style="display:flex;gap:12px;align-items:center;">
          <input class="check" type="checkbox" data-chk="${x.id}">
          <div style="min-width:0;">
            <b>${patient}</b>
            <div class="muted">${operator} / ${(x.place||"未設定")}</div>
          </div>
        </div>
        <button class="btn small" data-open-approve="${x.id}">詳細</button>
      </div>`;
  }).join("") : `<div class="muted">承認待ちなし</div>`;

  return `
    <div class="grid">
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
    </div>
  `;
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

// ✅ Docs：患者選択なし／医師ID単位で管理
function screenDoctorDocs(){
  return `
    <div class="grid">
      <div class="card">
        <div class="h1">Docs</div>
        <div class="muted">医師ID単位で保存</div>
        <div class="divider"></div>
        <div class="grid">
          ${btn("症状詳記","docs_symptom","primary")}
          ${btn("返書","docs_reply","primary")}
          ${btn("その他","docs_other","primary")}
          ${btn("⬅ 戻る","back_doc_home2","ghost")}
        </div>
      </div>
      <div class="card" id="docsList" style="display:none;"></div>
      <div class="card" id="docsEditor" style="display:none;"></div>
    </div>
  `;
}

/* ---------- Field ---------- */
function screenFieldHome(){
  return `
    <div class="grid"><div class="card">
      <div class="h1">実施入力</div>
      <div class="grid">
        ${btn("📶 スキャン","go_field_scan","primary")}
        ${btn("📄 下書き","go_field_drafts","primary")}
        ${btn("✅ 実施済み","go_field_done","primary")}
      </div>
    </div></div>
  `;
}

function screenDrafts(){
  const list = state.drafts.length ? state.drafts.map(d=>{
    const pt = PATIENTS.find(p=>p.id===d.patientId)?.label || "患者未選択";
    const op = OPERATORS.find(o=>o.id===d.operatorId)?.label || "入力者未選択";
    const mode = d.editDoneId ? "（修正）" : "";
    return `
      <div class="listItem">
        <div><b>${pt}${mode}</b><div class="muted">${op} / ${(d.materials||[]).length}点</div></div>
        <button class="btn small" data-resume="${d.id}">続き</button>
      </div>`;
  }).join("") : `<div class="muted">下書きなし</div>`;

  return `
    <div class="grid"><div class="card">
      <div class="h1">下書き</div><div class="divider"></div>
      <div class="grid">${list}</div>
      <div class="divider"></div>
      ${btn("⬅ 戻る","back_field_home","ghost")}
    </div></div>
  `;
}

// ✅ 実施済み：詳細を開く／承認待ちは修正可（承認済みは不可）
function screenDone(){
  const today = todayStr();
  const items = state.done.filter(x=>x.date===today);

  const list = items.length ? items.map(x=>{
    const pt = PATIENTS.find(p=>p.id===x.patientId)?.label || x.patientId;
    const op = OPERATORS.find(o=>o.id===x.operatorId)?.label || x.operatorId;
    const st = x.status==="pending" ? "承認待ち" : "承認済み";
    const doc = x.assignedDoctorId ? doctorLabelById(x.assignedDoctorId) : "主治医未選択";
    const hasC = x.doctor_comment ? "💬" : "";
    return `
      <div class="listItem" data-open-done="${x.id}">
        <div style="min-width:0;">
          <b>${pt} ${hasC}</b>
          <div class="muted">${op} / ${st}</div>
          <div class="muted" style="font-size:13px;">主治医：${doc}</div>
        </div>
        <span class="tag">${(x.materials||[]).length}点</span>
      </div>
    `;
  }).join("") : `<div class="muted">当日データなし</div>`;

  return `
    <div class="grid">
      <div class="card">
        <div class="h1">実施済み</div><div class="divider"></div>
        <div class="grid">${list}</div>
        <div class="divider"></div>
        ${btn("⬅ 戻る","back_field_home2","ghost")}
      </div>
      <div class="card" id="doneDetail" style="display:none;"></div>
    </div>
  `;
}

function renderDoneDetail(item){
  const pt = PATIENTS.find(p=>p.id===item.patientId)?.label || item.patientId;
  const op = OPERATORS.find(o=>o.id===item.operatorId)?.label || item.operatorId;
  const pr = PROCEDURES.find(p=>p.id===item.procedureId)?.label || item.procedureId;
  const st = item.status==="pending" ? "承認待ち" : "承認済み";
  const doc = item.assignedDoctorId ? doctorLabelById(item.assignedDoctorId) : "未選択";
  const comment = item.doctor_comment ? `
    <div style="border:1px solid #f2d2dd;border-radius:16px;padding:10px;background:#fff;margin:10px 0;">
      <div class="h2">医師コメント</div>
      <div class="muted">${item.doctor_comment}</div>
    </div>` : "";

  const mats = (item.materials||[]).map(m=>{
    const left = `<b>${m.product_name||"(不明)"}</b><div class="muted">${m.tokutei01_name||""}</div>`;
    return listItem(left,"");
  }).join("") || `<div class="muted">材料なし</div>`;

  const editButtons = item.status==="pending"
    ? `<div class="row">
         ${btn("✏ 修正","done_edit","primary")}
         ${btn("🗑 削除","done_delete","ghost")}
       </div>`
    : `<div class="muted">承認済みのため修正不可</div>`;

  return `
    <div class="h2">詳細</div>
    ${listItem(`<b>患者</b><div class="muted">${pt}</div>`)}
    ${listItem(`<b>入力者</b><div class="muted">${op}</div>`)}
    ${listItem(`<b>手技</b><div class="muted">${pr}</div>`)}
    ${listItem(`<b>主治医</b><div class="muted">${doc}</div>`)}
    ${listItem(`<b>状態</b><div class="muted">${st}</div>`)}
    ${comment}
    <div class="divider"></div>
    <div class="h2">材料</div>
    <div class="grid">${mats}</div>
    <div class="divider"></div>
    ${editButtons}
    <div class="divider"></div>
    ${btn("✖ 閉じる","close_done_detail","ghost")}
  `;
}

// 実施入力フロー：1 入力者 → 2 患者 → 3 手技 → 4 材料 → 5 確定 → 6 主治医選択
function screenFieldStep(step){
  ensureScanCtx(); scanCtx.step=step;

  const saveBar = `
    <div class="row">
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

  if (step===5){
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
        ${btn("➡ 主治医選択","to_doctor_select","primary")}
        ${btn("⬅ 戻る","back_step4","ghost")}
        ${btn("💾 下書き","save_draft_any2","ghost")}
      </div>
    </div></div>`;
  }

  // step 6 doctor select
  const options = DOCTORS.map(d=>{
    const v = d.id;
    const label = `${d.dept} ${d.name}（${d.id}）`;
    return `<option value="${v}" ${scanCtx.assignedDoctorId===v?"selected":""}>${label}</option>`;
  }).join("");

  return `<div class="grid"><div class="card">
    <div class="h1">主治医</div>
    <div class="muted">承認依頼する主治医を選択</div>
    <div class="divider"></div>

    <select class="select" id="attending_select">
      <option value="">未選択</option>
      ${options}
    </select>

    <div class="divider"></div>
    <div class="row">
      ${btn("📨 承認依頼","request_approval","primary")}
      ${btn("⬅ 戻る","back_to_confirm","ghost")}
    </div>
  </div></div>`;
}

/* ---------- Billing ---------- */
function screenBillingHome(){
  // ✅ トップに「戻る」なし
  return `<div class="grid"><div class="card">
    <div class="h1">医事</div>
    <div class="grid">
      ${btn("📄 実施入力済み","go_bill_done","primary")}
      ${btn("⏳ 承認待ち","go_bill_pending","primary")}
    </div>
  </div></div>`;
}
function screenBillingList(kind){
  const isPending = kind==="pending";
  const today = todayStr();
  const items = state.done
    .filter(x=>x.date===today)
    .filter(x=> isPending ? x.status==="pending" : x.status==="approved");

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

// ✅ 医事詳細：指定レイアウト（材料ごとに1枠）
function billingMaterialCard(m){
  const code = billingMapCode(m);
  const line1 = [
    (m.product_name||"(不明)"),
    (m.product_no||""),
    (m.product_sta||"")
  ].filter(Boolean).join(" ");
  const tok = (m.tokutei01_name||"");
  const price = m.total_reimbursement_price_yen ? `${jpy(m.total_reimbursement_price_yen)}円` : "";

  return `
    <div style="position:relative;border:1px solid #f2d2dd;border-radius:16px;padding:12px;background:linear-gradient(180deg,#fff,#fff7fa);">
      <div class="tag" style="position:absolute;top:10px;right:10px;">${code}</div>
      <div style="font-weight:900;font-size:16px;line-height:1.25;padding-right:86px;">${line1}</div>
      <div class="muted" style="margin-top:6px;">${tok}</div>
      <div style="margin-top:6px;font-weight:900;color:#ff3b6b;">${price}</div>
    </div>
  `;
}

function renderBillingDetail(item){
  const comment = item.doctor_comment ? `
    <div style="border:1px solid #f2d2dd;border-radius:16px;padding:10px;background:#fff;margin-bottom:10px;">
      <div class="h2">医師コメント</div>
      <div class="muted">${item.doctor_comment}</div>
    </div>` : "";

  const mats = (item.materials||[]).map(m=> billingMaterialCard(m)).join("") || `<div class="muted">材料なし</div>`;

  return `
    <div class="h2">詳細</div>
    ${comment}
    <div class="divider"></div>
    <div class="grid" style="gap:10px;">${mats}</div>
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

/* =========================
   Render
========================= */
function render(){
  setRolePill(role);

  // ✅ 職種切替はヘッダーだけ
  $("#btnRole").onclick = gotoRole;
  $("#rolePill").onclick = gotoRole;

  const v = view();
  const app = $("#app");

  // scan以外で止める
  if (!v.startsWith("/field/scan/step/4")) {
    try { scannerInst?.stop?.(); } catch {}
  }

  // role未選択なら role画面
  if (!role || v === "/role"){
    app.innerHTML = screenRole();
    $("#role_doctor").onclick=()=>{ role="doctor"; save(); location.hash="#/"; render(); };
    $("#role_field").onclick =()=>{ role="field";  save(); location.hash="#/"; render(); };
    $("#role_billing").onclick=()=>{ role="billing";save(); location.hash="#/"; render(); };
    return;
  }

  /* ===== Doctor ===== */
  if (role==="doctor"){
    // 医師は最初に診療科＋医師ID必須
    const deptOk = (doctorProfile.dept||"").trim().length>0;
    const idOk   = (doctorProfile.doctorId||"").trim().length>0;
    if ((!deptOk || !idOk) && v !== "/doctor/login"){
      setView("/doctor/login"); render(); return;
    }

    if (v === "/doctor/login"){
      app.innerHTML = screenDoctorLogin();
      $("#doc_login_go").onclick=()=>{
        doctorProfile.dept = ($("#doc_dept").value||"").trim();
        doctorProfile.doctorId = ($("#doc_id").value||"").trim();
        if (!doctorProfile.dept){ toastShow({title:"未入力", sub:"診療科"}); highlightAndFocus($("#doc_dept")); return; }
        if (!doctorProfile.doctorId){ toastShow({title:"未入力", sub:"医師ID"}); highlightAndFocus($("#doc_id")); return; }
        save();
        setView("/"); render();
      };
      $("#doc_login_clear").onclick=()=>{
        doctorProfile = { dept:"", doctorId:"" };
        save();
        render();
      };
      return;
    }

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

      // 個別詳細
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

      const openKindList = (kind)=>{
        const doc = ensureDoctorDocs();
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
        const doc = ensureDoctorDocs();
        const label = kind==="symptom"?"症状詳記":kind==="reply"?"返書":"その他";
        let draft = editId ? (doc[kind]||[]).find(x=>x.id===editId) : null;
        if(!draft) draft={ id:uid("DOC"), title:label, text:"", updatedAt:iso() };

        editor.style.display="block";
        docsList.style.display="none";

        editor.innerHTML = `
          <div class="h2">${label}</div><div class="divider"></div>
          <input class="input" id="doc_title" value="${(draft.title||"").replace(/"/g,"")}">
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
          state.docsByDoctor[doctorKey()] = doc;
          save();
          toastShow({title:"保存", sub:label});
          openKindList(kind);
        };
        $("#doc_back").onclick=()=> openKindList(kind);
      };

      $("#docs_symptom").onclick=()=> openKindList("symptom");
      $("#docs_reply").onclick  =()=> openKindList("reply");
      $("#docs_other").onclick  =()=> openKindList("other");
      return;
    }

    setView("/"); render(); return;
  }

  /* ===== Field ===== */
  if (role==="field"){
    if (v === "/" || v === ""){
      app.innerHTML = screenFieldHome();
      $("#go_field_scan").onclick=()=>{
        scanCtx=null;
        candidate={code:"",ts:0,count:0};
        lastScan={anyTs:0,raw:"",sameTs:0};
        setView("/field/scan/step/1"); render();
      };
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
          scanCtx={
            draftId:d.id,
            step:d.step||1,
            operatorId:d.operatorId||"",
            patientId:d.patientId||"",
            procedureId:d.procedureId||"",
            place:d.place||"未設定",
            materials:d.materials||[],
            createdAt:d.createdAt||iso(),
            updatedAt:d.updatedAt||iso(),
            editDoneId: d.editDoneId || null,
            assignedDoctorId: d.assignedDoctorId || ""
          };
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

      document.querySelectorAll("[data-open-done]").forEach(el=>{
        el.onclick=()=>{
          const id = el.getAttribute("data-open-done");
          const item = state.done.find(x=>x.id===id);
          if(!item) return;
          const box = $("#doneDetail");
          box.innerHTML = renderDoneDetail(item);
          box.style.display="block";

          $("#close_done_detail").onclick=()=>{ box.style.display="none"; };

          const editBtn = $("#done_edit");
          if (editBtn){
            editBtn.onclick=()=>{
              // 承認待ちのみ修正可
              if (item.status !== "pending"){ toastShow({title:"修正不可", sub:"承認済み"}); return; }
              scanCtx = {
                draftId: uid("DRAFT"),
                step: 5, // まず確定画面へ
                operatorId: item.operatorId || "",
                patientId: item.patientId || "",
                procedureId: item.procedureId || "",
                place: item.place || "未設定",
                materials: item.materials || [],
                createdAt: iso(),
                updatedAt: iso(),
                editDoneId: item.id,
                assignedDoctorId: item.assignedDoctorId || ""
              };
              upsertDraft();
              box.style.display="none";
              setView("/field/scan/step/5"); render();
            };
          }

          const delBtn = $("#done_delete");
          if (delBtn){
            delBtn.onclick=()=>{
              if (item.status !== "pending"){ toastShow({title:"削除不可", sub:"承認済み"}); return; }
              state.done = state.done.filter(x=>x.id!==item.id);
              save();
              toastShow({title:"削除", sub:"承認待ちデータを削除"}); 
              box.style.display="none";
              render();
            };
          }
        };
      });

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
          if (!supported) return;

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
            product_no:"",
            product_sta:"",
            total_reimbursement_price_yen:0,
            tokutei01_name:""
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

      if (step===5){
        ensureScanCtx();
        paintConfirmList();

        const op2=$("#op_select2"), pt2=$("#pt_select2"), pr2=$("#proc_select2");
        op2.onchange=()=>{ scanCtx.operatorId=op2.value||""; upsertDraft(); };
        pt2.onchange=()=>{ scanCtx.patientId=pt2.value||""; upsertDraft(); };
        pr2.onchange=()=>{ scanCtx.procedureId=pr2.value||""; upsertDraft(); };

        $("#back_step4").onclick=()=>{ setView("/field/scan/step/4"); render(); };
        $("#save_draft_any2").onclick=saveDraftExit;

        $("#to_doctor_select").onclick=()=>{
          ensureScanCtx();
          if (!scanCtx.operatorId){ toastShow({title:"未選択", sub:"入力者"}); highlightAndFocus(op2); return; }
          if (!scanCtx.patientId){ toastShow({title:"未選択", sub:"患者"}); highlightAndFocus(pt2); return; }
          if (!scanCtx.procedureId){ toastShow({title:"未選択", sub:"手技"}); highlightAndFocus(pr2); return; }
          if (!scanCtx.materials?.length){ toastShow({title:"材料なし", sub:"スキャンしてください"}); return; }
          upsertDraft();
          setView("/field/scan/step/6"); render();
        };
        return;
      }

      // step6 主治医選択 → 承認依頼（＝doneへ保存）
      ensureScanCtx();
      const sel = $("#attending_select");
      sel.onchange = ()=>{ scanCtx.assignedDoctorId = sel.value || ""; upsertDraft(); };

      $("#back_to_confirm").onclick=()=>{ setView("/field/scan/step/5"); render(); };

      $("#request_approval").onclick=()=>{
        ensureScanCtx();
        const did = (sel.value || scanCtx.assignedDoctorId || "").trim();
        if (!did){ toastShow({title:"未選択", sub:"主治医"}); highlightAndFocus(sel); return; }

        // 修正モード：既存 pending を上書き
        if (scanCtx.editDoneId){
          const it = state.done.find(x=>x.id===scanCtx.editDoneId);
          if (!it){ toastShow({title:"エラー", sub:"対象が見つかりません"}); return; }
          if (it.status !== "pending"){ toastShow({title:"修正不可", sub:"承認済み"}); return; }

          it.operatorId = scanCtx.operatorId;
          it.patientId  = scanCtx.patientId;
          it.procedureId= scanCtx.procedureId;
          it.place      = scanCtx.place || "未設定";
          it.materials  = scanCtx.materials || [];
          it.assignedDoctorId = did;
          // コメントは承認待ちに戻すので保持（医師がすでに書いていれば残す/運用次第）
          // ここでは「修正したらコメントは残す」方針
          it.updatedAt = iso();

          save();
          toastShow({title:"更新", sub:"承認待ち"}); 
        } else {
          state.done.unshift({
            id: uid("DONE"),
            date: todayStr(),
            operatorId: scanCtx.operatorId,
            patientId: scanCtx.patientId,
            procedureId: scanCtx.procedureId,
            place: scanCtx.place || "未設定",
            materials: scanCtx.materials || [],
            status: "pending",
            confirmedAt: iso(),
            approved_at: "",
            doctor_comment: "",
            assignedDoctorId: did
          });
          save();
          toastShow({title:"承認依頼", sub:"承認待ちへ"});
        }

        // 下書き削除（修正でも新規でも）
        state.drafts = state.drafts.filter(d=>d.id!==scanCtx.draftId);
        save();

        scanCtx=null;
        candidate={code:"",ts:0,count:0};
        lastScan={anyTs:0,raw:"",sameTs:0};
        setView("/field/done"); render();
      };

      return;
    }

    setView("/"); render(); return;
  }

  /* ===== Billing ===== */
  if (role==="billing"){
    if (v === "/" || v === ""){
      app.innerHTML = screenBillingHome();
      $("#go_bill_done").onclick=()=>{ setView("/billing/done"); render(); };
      $("#go_bill_pending").onclick=()=>{ setView("/billing/pending"); render(); };
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
