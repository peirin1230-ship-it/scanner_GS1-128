// LinQ VAL PoC app.js v24
const BUILD_ID = "20260122-v24";

import { Scanner, parseGS1ForGTIN14, normalizeJan13 } from "./scan.js?v=20260122-v24";

/* ========= settings ========= */
const LS = {
  role: "linqval_role_v3",
  state: "linqval_state_v24",
  doctor: "linqval_doctor_profile_v2",
  recentApprovers: "linqval_recent_approvers_v1"
};

const TOAST_MS = 5400;
const ANY_SCAN_COOLDOWN_MS = 3500;
const SAME_CODE_COOLDOWN_MS = 8000;
const DOUBLE_HIT_WINDOW_MS = 1200;

/* ========= helpers ========= */
const $ = (s)=>document.querySelector(s);
const iso = ()=>new Date().toISOString();
const todayStr = ()=>new Date().toISOString().slice(0,10);
const deepClone = (v)=>JSON.parse(JSON.stringify(v ?? null));
function safeParse(s, fb){ try { return JSON.parse(s); } catch { return fb; } }
function uid(prefix="ID"){ return `${prefix}-${Math.random().toString(16).slice(2,10)}-${Date.now().toString(36)}`; }
function fmtDT(s){ if(!s) return "—"; try { return new Date(s).toLocaleString("ja-JP"); } catch { return String(s); } }
const jpy = (n)=> (Number(n||0)).toLocaleString("ja-JP");

function toastShow({ title, price, sub }){
  $("#toastTitle").textContent = title || "OK";
  $("#toastPrice").textContent = price ? `${jpy(price)}円` : "";
  $("#toastSub").textContent = sub || "";
  $("#toast").classList.add("show");
  setTimeout(()=> $("#toast").classList.remove("show"), TOAST_MS);
}

function btn(label, id, kind=""){
  const cls = kind === "primary" ? "btn primary" : kind === "ghost" ? "btn ghost" : "btn";
  return `<button class="${cls}" id="${id}">${label}</button>`;
}
function listItem(left, right=""){
  return `<div class="listItem"><div style="flex:1;min-width:0;">${left}</div><div>${right}</div></div>`;
}

/* ========= checksum ========= */
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

/* ========= state ========= */
function defaultState(){
  return { drafts:[], done:[], docsByDoctor:{}, scanLog:[] };
}
let role = localStorage.getItem(LS.role) || "";
let state = safeParse(localStorage.getItem(LS.state), null) || defaultState();
let doctorProfile = safeParse(localStorage.getItem(LS.doctor), null) || { dept:"", doctorId:"" };
let recentApprovers = safeParse(localStorage.getItem(LS.recentApprovers), null) || {};

function save(){
  localStorage.setItem(LS.role, role);
  localStorage.setItem(LS.state, JSON.stringify(state));
  localStorage.setItem(LS.doctor, JSON.stringify(doctorProfile));
  localStorage.setItem(LS.recentApprovers, JSON.stringify(recentApprovers));
}

/* ========= data (fallback) ========= */
const FALLBACK_OPERATORS = [
  { id:"OP-NUR-001", label:"看護師A（カテ室）" },
  { id:"OP-CE-001",  label:"CE技士A（機器）" }
];
const FALLBACK_PATIENTS = [
  { id:"PT-2026-0001", label:"PT-2026-0001（山田 太郎 / 71M）" },
  { id:"PT-2026-0002", label:"PT-2026-0002（佐々木 花子 / 68F）" }
];
const FALLBACK_PROCEDURES = [
  { id:"PR-CATH-001", label:"冠動脈造影（CAG）" },
  { id:"PR-PCI-001",  label:"PCI（経皮的冠動脈形成術）" }
];
const FALLBACK_DOCTORS = [
  { id:"DR-CARD-001", name:"医師A", dept:"循環器内科" }
];
const FALLBACK_BILLMAP = { byTokuteiName:{}, byProductName:{} };
const FALLBACK_STANDARD_BUILDER = {
  version:"fallback",
  domain:"cathlab",
  defaultProcedureCandidates:["PR-CATH-001","PR-PCI-001"],
  rules:[
    { name:"ステント", matchAny:["ステント","DES","BMS"], suggest:["PR-PCI-001"] },
    { name:"IVUS", matchAny:["IVUS"], suggest:["PR-CATH-001"] }
  ]
};

async function loadJSON(path, fallback){
  try{
    const url = `${path}?v=${encodeURIComponent(BUILD_ID)}`;
    const r = await fetch(url, { cache:"no-store" });
    if (!r.ok) return fallback;
    return await r.json();
  }catch{
    return fallback;
  }
}

let OPERATORS=[], PATIENTS=[], PROCEDURES=[], DOCTORS=[], BILLMAP={}, STANDARD_BUILDER=FALLBACK_STANDARD_BUILDER;

async function bootData(){
  OPERATORS = await loadJSON("./data/operators.json", FALLBACK_OPERATORS);
  PATIENTS  = await loadJSON("./data/patients.json",  FALLBACK_PATIENTS);
  PROCEDURES= await loadJSON("./data/procedures.json",FALLBACK_PROCEDURES);
  DOCTORS   = await loadJSON("./data/doctors.json",   FALLBACK_DOCTORS);
  BILLMAP   = await loadJSON("./data/billing_map.json", FALLBACK_BILLMAP);

  STANDARD_BUILDER = await loadJSON("./data/standard_builder.json", FALLBACK_STANDARD_BUILDER);

  if (!Array.isArray(OPERATORS)||!OPERATORS.length) OPERATORS=FALLBACK_OPERATORS;
  if (!Array.isArray(PATIENTS)||!PATIENTS.length) PATIENTS=FALLBACK_PATIENTS;
  if (!Array.isArray(PROCEDURES)||!PROCEDURES.length) PROCEDURES=FALLBACK_PROCEDURES;
  if (!Array.isArray(DOCTORS)||!DOCTORS.length) DOCTORS=FALLBACK_DOCTORS;
  if (!STANDARD_BUILDER || !Array.isArray(STANDARD_BUILDER.rules)) STANDARD_BUILDER=FALLBACK_STANDARD_BUILDER;
}

/* ========= labels ========= */
function operatorLabel(id){ return (OPERATORS.find(x=>x.id===id)?.label) || (id||"未選択"); }
function patientLabel(id){ return (PATIENTS.find(x=>x.id===id)?.label) || (id||"未選択"); }
function procedureLabel(id){ return (PROCEDURES.find(x=>x.id===id)?.label) || (id||"未選択"); }
function doctorLabelById(id){
  if (!id) return "未選択";
  if (id === "BILLING") return "医事課（最終承認）";
  const d = DOCTORS.find(x=>x.id===id);
  return d ? `${d.dept} ${d.name}（${d.id}）` : id;
}
function doctorDeptList(){
  const s = new Set(DOCTORS.map(d=>d.dept).filter(Boolean));
  return Array.from(s).sort();
}

/* ========= recent approvers ========= */
function touchRecentApprover(doctorId){
  if (!doctorId) return;
  recentApprovers[doctorId] = Date.now();
  save();
}
function sortedApprovers(deptFilter){
  const list = DOCTORS
    .filter(d=> !deptFilter || deptFilter==="ALL" || d.dept===deptFilter)
    .slice();
  list.sort((a,b)=>{
    const ta = recentApprovers[a.id] || 0;
    const tb = recentApprovers[b.id] || 0;
    if (tb !== ta) return tb - ta;
    return (a.name||"").localeCompare(b.name||"", "ja");
  });
  return list;
}

/* ========= docs storage ========= */
function doctorKey(){
  return `${(doctorProfile.dept||"").trim()}__${(doctorProfile.doctorId||"").trim()}`;
}
function ensureDoctorDocs(){
  const key = doctorKey();
  state.docsByDoctor[key] = state.docsByDoctor[key] || { symptom:[], reply:[], other:[] };
  return state.docsByDoctor[key];
}

/* ========= history ========= */
function pushHistory(it, entry){
  it.history = Array.isArray(it.history) ? it.history : [];
  it.history.unshift(entry);
}
function renderHistory(it){
  const h = Array.isArray(it.history) ? it.history : [];
  if (!h.length) return `<div class="muted">履歴なし</div>`;
  return `<div class="grid" style="gap:10px;">${
    h.map(e=>{
      const tag = e.type ? `<span class="tag">${e.type}</span>` : "";
      const lines = (e.changes||[]).map(x=>`<div class="muted">${x}</div>`).join("");
      return `<div style="border:1px solid #f2d2dd;border-radius:16px;padding:10px;background:#fff;">
        <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;">
          <b>${e.actor||"—"}</b>${tag}
        </div>
        <div class="muted">${fmtDT(e.at)}</div>
        <div style="margin-top:6px;">${lines}</div>
      </div>`;
    }).join("")
  }</div>`;
}

/* ========= material qty ========= */
function materialSig(m){
  return m?.jan13 || m?.gtin14 || m?.raw || m?.product_name || m?.id;
}
function countBySig(mats){
  const map = new Map();
  for (const m of (mats||[])){
    const sig = materialSig(m);
    const qty = Number(m.qty||1);
    map.set(sig, (map.get(sig)||0) + qty);
  }
  return map;
}
function diffMaterialsQty(oldMats, newMats){
  const a = countBySig(oldMats);
  const b = countBySig(newMats);
  const sigs = new Set([...a.keys(), ...b.keys()]);
  const added=[], removed=[];
  for (const sig of sigs){
    const ao = a.get(sig)||0;
    const bn = b.get(sig)||0;
    if (bn > ao) added.push({sig, qty: bn-ao});
    if (ao > bn) removed.push({sig, qty: ao-bn});
  }
  return { added, removed };
}
function summarizeChangesDetailed(oldIt, newIt){
  const changes=[];
  const f = (k, label, fmt=(v)=>v)=>{
    if ((oldIt?.[k]||"") !== (newIt?.[k]||"")) changes.push(`${label}: ${fmt(oldIt?.[k])} → ${fmt(newIt?.[k])}`);
  };
  f("operatorId","入力者", operatorLabel);
  f("patientId","患者", patientLabel);
  f("procedureId","手技", procedureLabel);
  f("assignedDoctorId","承認依頼", doctorLabelById);

  const d = diffMaterialsQty(oldIt?.materials, newIt?.materials);
  if (d.added.length) changes.push(`材料追加: ${d.added.reduce((p,c)=>p+c.qty,0)}点`);
  if (d.removed.length) changes.push(`材料削除: ${d.removed.reduce((p,c)=>p+c.qty,0)}点`);
  return changes.length ? changes : ["修正なし"];
}

/* ========= dict csv (split) ========= */
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
  const res = await fetch(`${url}?v=${encodeURIComponent(BUILD_ID)}`, { cache:"no-store" });
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
  return { product_name, product_no, product_sta, total_reimbursement_price_yen: total, tokutei01_name };
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

function billingMapCode(material){
  const t = material?.tokutei01_name || "";
  const p = material?.product_name || "";
  return BILLMAP.byTokuteiName?.[t] || BILLMAP.byProductName?.[p] || "—";
}

/* ========= CSV ========= */
function escapeCSV(v){
  const s = (v===null||v===undefined) ? "" : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g,'""')}"`;
  return s;
}
function toCSV(headers, rows){
  const lines = [];
  lines.push(headers.map(escapeCSV).join(","));
  for (const r of rows){
    lines.push(headers.map(h=>escapeCSV(r[h])).join(","));
  }
  return lines.join("\n");
}
function downloadText(filename, text){
  const blob = new Blob([text], {type:"text/csv;charset=utf-8"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
function exportDoneCSV(items, filename){
  const rows = [];
  for (const it of items){
    const base = {
      id: it.id,
      date: it.date,
      confirmedAt: it.confirmedAt,
      status: it.status,
      patientId: it.patientId,
      patient: patientLabel(it.patientId),
      operatorId: it.operatorId,
      operator: operatorLabel(it.operatorId),
      procedureId: it.procedureId,
      procedure: procedureLabel(it.procedureId),
      assignedDoctorId: it.assignedDoctorId,
      assignedDoctor: doctorLabelById(it.assignedDoctorId),
      approved_by: it.approved_by || "",
      approvedBy: doctorLabelById(it.approved_by || ""),
      approved_at: it.approved_at || "",
      doctor_comment: it.doctor_comment || ""
    };
    const mats = Array.isArray(it.materials) ? it.materials : [];
    if (!mats.length){
      rows.push({...base, qty:"", mat_product_name:"", mat_tokutei01_name:"", mat_total_reimbursement_price_yen:"", mat_jan13:"", mat_gtin14:"", mat_dict_status:"", billingmap_code:""});
    } else {
      for (const m of mats){
        rows.push({
          ...base,
          qty: m.qty || 1,
          mat_product_name: m.product_name || "",
          mat_product_no: m.product_no || "",
          mat_product_sta: m.product_sta || "",
          mat_tokutei01_name: m.tokutei01_name || "",
          mat_total_reimbursement_price_yen: m.total_reimbursement_price_yen || 0,
          mat_jan13: m.jan13 || "",
          mat_gtin14: m.gtin14 || "",
          mat_dict_status: m.dict_status || "",
          billingmap_code: billingMapCode(m)
        });
      }
    }
  }
  const headers = [
    "id","date","confirmedAt","status",
    "patientId","patient","operatorId","operator","procedureId","procedure",
    "assignedDoctorId","assignedDoctor","approved_by","approvedBy","approved_at",
    "doctor_comment",
    "qty",
    "mat_product_name","mat_product_no","mat_product_sta","mat_tokutei01_name","mat_total_reimbursement_price_yen",
    "mat_jan13","mat_gtin14","mat_dict_status","billingmap_code"
  ];
  downloadText(filename, toCSV(headers, rows));
}

/* ========= scan flow ========= */
let scannerInst=null;
let scanCtx=null;
let lastScan = { anyTs:0, raw:"", sameTs:0 };
let candidate = { code: "", ts: 0, count: 0 };

function setView(hash){ location.hash = `#${hash}`; }
function view(){ return (location.hash || "#/").slice(1); }

function stopScannerIfAny(){ try { scannerInst?.stop?.(); } catch {} }

function gotoRole(){
  stopScannerIfAny();
  role = "";
  save();
  setView("/role");
  renderWithGuard();
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
      editDoneId:null,
      assignedDoctorId:"",
      approverDept:"ALL",
      _baseSnapshot:null
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
    approverDept: scanCtx.approverDept || "ALL",
    editDoneId: scanCtx.editDoneId || null,
    createdAt:scanCtx.createdAt,
    updatedAt:iso()
  };
  if (idx>=0) state.drafts[idx]=d; else state.drafts.unshift(d);
  save();
}

/* ========= summary (field only) ========= */
function totalQty(){
  return (scanCtx?.materials||[]).reduce((p,m)=>p+Number(m.qty||1),0);
}
function updateSummaryUI(){
  const host = $("#summaryHost");
  if (!host) return;

  const v = view();
  const isField = (role==="field") && (v.startsWith("/field") || v==="/" || v==="");
  if (!isField){
    host.style.display = "none";
    host.innerHTML = "";
    return;
  }

  ensureScanCtx();

  const opMissing = !scanCtx.operatorId;
  const ptMissing = !scanCtx.patientId;
  const prMissing = !scanCtx.procedureId;

  const op = opMissing ? "未選択" : operatorLabel(scanCtx.operatorId);
  const pt = ptMissing ? "未選択" : patientLabel(scanCtx.patientId);
  const pr = prMissing ? "未選択" : procedureLabel(scanCtx.procedureId);
  const qty = totalQty();

  host.innerHTML = `
    <div class="summaryCard">
      <div class="chipRow">
        <div class="chip ${opMissing?"warn":""}"><b>入力者</b> ${op}</div>
        <div class="chip ${ptMissing?"warn":""}"><b>患者</b> ${pt}</div>
        <div class="chip ${prMissing?"warn":""}"><b>手技</b> ${pr}</div>
        <div class="chip"><b>合計</b> ${qty}点</div>
      </div>
    </div>
  `;
  host.style.display = "block";
}

/* ========= suggestions (after material scan only) ========= */
function procedureLabelSafe(id){
  return PROCEDURES.find(p=>p.id===id)?.label || id;
}
function normalizeText(s){ return String(s||"").toLowerCase(); }

function computeProcedureSuggestions(){
  ensureScanCtx();
  const mats = scanCtx.materials || [];
  const rules = Array.isArray(STANDARD_BUILDER.rules) ? STANDARD_BUILDER.rules : [];
  const defaults = Array.isArray(STANDARD_BUILDER.defaultProcedureCandidates) ? STANDARD_BUILDER.defaultProcedureCandidates : [];

  const agg = new Map();

  for (const pid of defaults){
    if (!pid) continue;
    agg.set(pid, { score: 0.1, reasons: new Set(["標準"]) });
  }

  const texts = mats.map(m=>{
    const a = m.tokutei01_name || "";
    const b = m.product_name || "";
    return normalizeText(`${a} ${b}`);
  });

  for (const rule of rules){
    const matchAny = Array.isArray(rule.matchAny) ? rule.matchAny : [];
    const suggest = Array.isArray(rule.suggest) ? rule.suggest : [];
    if (!suggest.length || !matchAny.length) continue;

    const hits = [];
    for (const kw of matchAny){
      const k = normalizeText(kw);
      if (!k) continue;
      if (texts.some(t => t.includes(k))) hits.push(kw);
    }
    if (!hits.length) continue;

    const strength = 1 + Math.min(2, hits.length - 1); // 1..3
    for (const pid of suggest){
      if (!pid) continue;
      const cur = agg.get(pid) || { score: 0, reasons: new Set() };
      cur.score += strength;
      for (const h of hits.slice(0,2)) cur.reasons.add(h);
      if (rule.name) cur.reasons.add(rule.name);
      agg.set(pid, cur);
    }
  }

  return Array.from(agg.entries())
    .map(([pid, v]) => ({
      id: pid,
      label: procedureLabelSafe(pid),
      score: v.score,
      reason: Array.from(v.reasons).filter(Boolean).slice(0,3).join(" / ")
    }))
    .sort((a,b)=>{
      if (b.score !== a.score) return b.score - a.score;
      return a.label.localeCompare(b.label, "ja");
    })
    .slice(0,3);
}

function updateSuggestionUI(){
  // step4 / step5 only
  const host4 = document.getElementById("suggestProcHost4");
  const host5 = document.getElementById("suggestProcHost5");
  if (!host4 && !host5) return;

  ensureScanCtx();
  const mats = scanCtx.materials || [];

  if (mats.length === 0){
    const html = `<div class="muted">材料スキャン後に表示</div>`;
    if (host4) host4.innerHTML = html;
    if (host5) host5.innerHTML = html;
    return;
  }

  const suggestions = computeProcedureSuggestions();
  const selected = scanCtx.procedureId || "";

  const html = suggestions.length ? `
    <div class="sugBox">
      <div class="sugRow">
        ${suggestions.map(s=>{
          const isSel = s.id === selected;
          const cls = isSel ? "btn small primary" : "btn small ghost";
          return `<button class="${cls}" data-sugproc="${s.id}">⭐ ${s.label}</button>`;
        }).join("")}
      </div>
      <div class="sugNote">根拠: ${suggestions.map(s=>`${s.label}（${s.reason||"—"}）`).join(" / ")}</div>
    </div>
  ` : `<div class="muted">候補なし</div>`;

  if (host4) host4.innerHTML = html;
  if (host5) host5.innerHTML = html;

  document.querySelectorAll("[data-sugproc]").forEach(b=>{
    b.onclick = ()=>{
      const pid = b.getAttribute("data-sugproc");
      scanCtx.procedureId = pid || "";
      upsertDraft();
      updateSummaryUI();

      // sync selects if present
      const sel3 = document.getElementById("proc_select");
      const sel5 = document.getElementById("proc_select2");
      if (sel3) sel3.value = scanCtx.procedureId;
      if (sel5) sel5.value = scanCtx.procedureId;

      updateSuggestionUI();
      toastShow({ title:"手技変更", sub: procedureLabelSafe(scanCtx.procedureId) });
    };
  });
}

/* ========= parse / add material ========= */
function parseSupported(raw){
  const jan13 = normalizeJan13(raw);
  if (jan13 && validEan13(jan13)) return { kind:"jan13", jan13 };
  const gtin14 = parseGS1ForGTIN14(raw);
  if (gtin14 && validGtin14(gtin14)) return { kind:"gtin14", gtin14 };
  return null;
}

function mergeOrAddMaterial(list, item){
  const sig = materialSig(item);
  const idx = list.findIndex(m=>materialSig(m)===sig);
  if (idx >= 0){
    list[idx].qty = Number(list[idx].qty||1) + 1;
    return list[idx];
  }
  item.qty = 1;
  list.unshift(item);
  return item;
}

/* ✅ 1つ減らす（qty--） */
function decMaterialById(list, id){
  const i = list.findIndex(x=>x.id===id);
  if (i<0) return;
  const q = Number(list[i].qty||1);
  if (q > 1) list[i].qty = q - 1;
  else list.splice(i,1);
}
/* ✅ 行ごと削除 */
function removeMaterialRowById(list, id){
  const i = list.findIndex(x=>x.id===id);
  if (i<0) return;
  list.splice(i,1);
}

async function handleDetected(raw){
  const supported = parseSupported(raw);
  if (!supported) return;

  const codeKey = supported.kind==="jan13" ? supported.jan13 : supported.gtin14;

  // double-hit confirm
  const now = Date.now();
  if (candidate.code === codeKey && (now - candidate.ts) <= DOUBLE_HIT_WINDOW_MS){
    candidate.count += 1;
    candidate.ts = now;
  } else {
    candidate = { code: codeKey, ts: now, count: 1 };
  }
  if (candidate.count < 2) return;

  const t = Date.now();
  if (t - lastScan.anyTs < ANY_SCAN_COOLDOWN_MS) return;
  if (codeKey === lastScan.raw && (t - lastScan.sameTs) < SAME_CODE_COOLDOWN_MS) return;

  lastScan.anyTs = t;
  if (codeKey === lastScan.raw) lastScan.sameTs = t;
  else { lastScan.raw = codeKey; lastScan.sameTs = t; }

  ensureScanCtx();

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
    if (r.status==="hit") Object.assign(item, mapDictRow(r.row));
  } else {
    item.gtin14 = supported.gtin14;
    const g = await lookupJanFromGtin14(item.gtin14);
    if (g.status==="hit"){
      item.jan13 = g.jan13;
      const r = await lookupByJan13(item.jan13);
      item.dict_status = r.status;
      if (r.status==="hit") Object.assign(item, mapDictRow(r.row));
    } else item.dict_status="no_match";
  }

  state.scanLog.unshift({ at: iso(), raw: String(raw||""), key: codeKey, status: item.dict_status });
  state.scanLog = state.scanLog.slice(0, 200);

  const updated = mergeOrAddMaterial(scanCtx.materials, item);
  upsertDraft();
  paintMatList();
  updateSummaryUI();
  updateSuggestionUI();

  const showName = updated.product_name || "読み取りOK";
  const qty = updated.qty || 1;
  const sub = updated.tokutei01_name ? `${updated.tokutei01_name} / ×${qty}` : `×${qty}`;
  toastShow({ title: showName, price: updated.total_reimbursement_price_yen, sub });

  save();
  candidate = { code:"", ts:0, count:0 };
}

/* ========= UI screens ========= */
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

/* Doctor login */
function screenDoctorLogin(){
  const deptOptions = [`<option value="">選択</option>`]
    .concat(doctorDeptList().map(d=>`<option value="${d}"${doctorProfile.dept===d?" selected":""}>${d}</option>`))
    .join("");

  const list = DOCTORS
    .filter(d=> !doctorProfile.dept || d.dept===doctorProfile.dept)
    .slice()
    .sort((a,b)=>(a.name||"").localeCompare(b.name||"","ja"));

  const docOptions = [`<option value="">選択</option>`]
    .concat(list.map(d=>`<option value="${d.id}"${doctorProfile.doctorId===d.id?" selected":""}>${d.name}（${d.id}）</option>`))
    .join("");

  return `
    <div class="grid"><div class="card">
      <div class="h1">医師ログイン</div>
      <div class="muted">診療科 → 医師（ID）を選択</div>
      <div class="divider"></div>
      <div class="h2">診療科</div>
      <select class="select" id="doc_dept_sel">${deptOptions}</select>
      <div class="divider"></div>
      <div class="h2">医師</div>
      <select class="select" id="doc_id_sel">${docOptions}</select>
      <div class="divider"></div>
      ${btn("開始","doc_login_go","primary")}
      <div class="divider"></div>
      ${btn("クリア","doc_login_clear","ghost")}
    </div></div>`;
}

function screenDoctorHome(){
  return `
    <div class="grid"><div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
        <div>
          <div class="h1">医師</div>
          <div class="muted">${doctorProfile.dept} / ID: ${doctorProfile.doctorId}</div>
        </div>
        <button class="btn small ghost" id="doc_logout">ログアウト</button>
      </div>
      <div class="divider"></div>
      <div class="grid">
        ${btn("✅ 承認","go_doc_approve","primary")}
        ${btn("📝 Docs","go_doc_docs","primary")}
      </div>
    </div></div>`;
}

function screenDoctorApprovals(){
  const did = (doctorProfile.doctorId||"").trim();
  const pending = state.done.filter(x=>x.status==="pending" && x.assignedDoctorId===did);
  const list = pending.length ? pending.map(x=>`
    <div class="listItem">
      <div style="display:flex;gap:12px;align-items:center;">
        <input class="check" type="checkbox" data-chk="${x.id}">
        <div style="min-width:0;">
          <b>${patientLabel(x.patientId)}</b>
          <div class="muted">${procedureLabel(x.procedureId)} / ${operatorLabel(x.operatorId)}</div>
          <div class="muted" style="font-size:13px;">${fmtDT(x.confirmedAt)}</div>
        </div>
      </div>
      <button class="btn small" data-open-approve="${x.id}">詳細</button>
    </div>
  `).join("") : `<div class="muted">承認待ちなし</div>`;

  return `
    <div class="grid">
      <div class="card">
        <div class="h1">承認</div><div class="divider"></div>
        <div class="h2">一括コメント（任意）</div>
        <textarea id="bulk_comment"></textarea>
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
  const mats = (item.materials||[]).map(m=>{
    const qty = m.qty || 1;
    return listItem(`<b>${m.product_name||"(不明)"} ×${qty}</b><div class="muted">${m.tokutei01_name||""}</div>`);
  }).join("") || `<div class="muted">材料なし</div>`;

  return `
    <div class="h2">詳細</div>
    ${listItem(`<b>日時</b><div class="muted">${fmtDT(item.confirmedAt)}</div>`)}
    ${listItem(`<b>患者</b><div class="muted">${patientLabel(item.patientId)}</div>`)}
    ${listItem(`<b>手技</b><div class="muted">${procedureLabel(item.procedureId)}</div>`)}
    <div class="divider"></div>
    <div class="h2">材料</div>
    <div class="grid">${mats}</div>
    <div class="divider"></div>
    <div class="h2">コメント</div>
    <textarea id="doctor_comment"></textarea>
    <div class="divider"></div>
    <div class="row">
      ${btn("✅ 承認","approve_with_comment","primary")}
      ${btn("✖ 閉じる","close_detail","ghost")}
    </div>
    <div class="divider"></div>
    <div class="h2">編集履歴</div>
    ${renderHistory(item)}
  `;
}

/* Docs */
function screenDoctorDocs(){
  return `
    <div class="grid">
      <div class="card">
        <div class="h1">Docs</div>
        <div class="muted">医師ID単位で保存</div>
        <div class="divider"></div>
        <div class="grid">
          ${btn("症状
