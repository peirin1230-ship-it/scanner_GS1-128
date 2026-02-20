import { Scanner, parseGS1ForGTIN14, normalizeJan13 } from "./scan.js";

/* ========= settings ========= */
const LS = {
  role: "linqval_role_v3",
  state: "linqval_state_v23",
  doctor: "linqval_doctor_profile_v2",
  recentApprovers: "linqval_recent_approvers_v1",
  billingReqOverrides: "linqval_billing_req_overrides_v1"
};
const TOAST_MS = 5400;
const ANY_SCAN_COOLDOWN_MS = 3500;
const SAME_CODE_COOLDOWN_MS = 8000;
const DOUBLE_HIT_WINDOW_MS = 1200;

/* ========= helpers ========= */
const $ = (s)=>document.querySelector(s);
const iso = ()=>new Date().toISOString();
const todayStr = ()=>new Date().toISOString().slice(0,10);
const jpy = (n)=> (Number(n||0)).toLocaleString("ja-JP");
const deepClone = (v)=>JSON.parse(JSON.stringify(v ?? null));
function safeParse(s, fb){ try { return JSON.parse(s); } catch { return fb; } }
function uid(prefix="ID"){ return `${prefix}-${Math.random().toString(16).slice(2,10)}-${Date.now().toString(36)}`; }
function fmtDT(s){ if(!s) return "—"; try { return new Date(s).toLocaleString("ja-JP"); } catch { return String(s); } }

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
let billingReqOverrides = safeParse(localStorage.getItem(LS.billingReqOverrides), null) || { additions: {}, deletions: [] };
function save(){
  localStorage.setItem(LS.role, role);
  localStorage.setItem(LS.state, JSON.stringify(state));
  localStorage.setItem(LS.doctor, JSON.stringify(doctorProfile));
  localStorage.setItem(LS.recentApprovers, JSON.stringify(recentApprovers));
  localStorage.setItem(LS.billingReqOverrides, JSON.stringify(billingReqOverrides));
}

/* ========= data ========= */
const FALLBACK_OPERATORS = [
  { id:"op1", label:"看護師A" },{ id:"op2", label:"看護師B" },{ id:"op3", label:"臨床工学C" }
];
const FALLBACK_PATIENTS = [
  { id:"pt1", label:"患者001" },{ id:"pt2", label:"患者002" },{ id:"pt3", label:"患者003" }
];
const FALLBACK_PROCEDURES = [
  { id:"pr1", label:"PCI" },{ id:"pr2", label:"冠動脈造影" },{ id:"pr3", label:"ステント留置" }
];
const FALLBACK_DOCTORS = [
  { id:"dr001", name:"医師A", dept:"循環器内科" },
  { id:"dr002", name:"医師B", dept:"循環器内科" },
  { id:"dr101", name:"医師C", dept:"心臓血管外科" },
];
const FALLBACK_BILLMAP = { byTokuteiName:{}, byProductName:{} };
const FALLBACK_BILLING_REQ = { requirements: {} };
const FALLBACK_STANDARD_BUILDER = {
  version: "fallback",
  domain: "general",
  defaultProcedureCandidates: ["pr2","pr1"],
  rules: [
    { name:"ステント", matchAny:["ステント","DES","BMS"], suggest:["pr1","pr3"] },
    { name:"バルーン", matchAny:["バルーン","PTCA"], suggest:["pr1"] }
  ]
};

async function loadJSON(path, fallback){
  try{ const r = await fetch(path, {cache:"no-store"}); if(!r.ok) return fallback; return await r.json(); }
  catch{ return fallback; }
}

let OPERATORS=[], PATIENTS=[], PROCEDURES=[], DOCTORS=[], BILLMAP={}, STANDARD_BUILDER=FALLBACK_STANDARD_BUILDER, BILLING_REQ=FALLBACK_BILLING_REQ;

async function bootData(){
  OPERATORS = await loadJSON("./data/operators.json", FALLBACK_OPERATORS);
  PATIENTS  = await loadJSON("./data/patients.json",  FALLBACK_PATIENTS);
  PROCEDURES= await loadJSON("./data/procedures.json",FALLBACK_PROCEDURES);
  DOCTORS   = await loadJSON("./data/doctors.json", FALLBACK_DOCTORS);
  BILLMAP   = await loadJSON("./data/billing_map.json", FALLBACK_BILLMAP);
  STANDARD_BUILDER = await loadJSON("./data/standard_builder.json", FALLBACK_STANDARD_BUILDER);
  BILLING_REQ = await loadJSON("./data/billing_requirements.json", FALLBACK_BILLING_REQ);

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

/* ========= billing requirement check (rule-based) ========= */
function evaluateCheck(chk, material, allMaterials) {
  switch (chk.type) {
    case "maxQty": {
      const qty = Number(material.qty || 1);
      if (qty > chk.limit) {
        const desc = chk.description || `${chk.limit}${chk.unit ? "（" + chk.unit + "）" : "個"}を限度として算定`;
        return chk.overrideWithNote
          ? { type: "maxQty", status: "warn", message: desc }
          : { type: "maxQty", status: "ng", message: desc };
      }
      return { type: "maxQty", status: "ok", message: "" };
    }
    case "simultaneousNg": {
      const others = (allMaterials || []).filter(m => m !== material);
      const conflict = others.find(m => {
        const n = resolveOfficialName(m.tokutei01_name || "");
        return (chk.targets || []).includes(n) || (chk.targets || []).includes(m.tokutei01_name || "");
      });
      if (conflict) {
        return chk.overrideWithNote
          ? { type: "simultaneousNg", status: "warn", message: chk.message || `${conflict.product_name || conflict.tokutei01_name}との同時算定不可` }
          : { type: "simultaneousNg", status: "ng", message: chk.message || `同時算定不可` };
      }
      return { type: "simultaneousNg", status: "ok", message: "" };
    }
    case "includedIn": {
      const others = (allMaterials || []).filter(m => m !== material);
      const parentExists = others.some(m => {
        const n = resolveOfficialName(m.tokutei01_name || "");
        return n === chk.parent || (m.tokutei01_name || "") === chk.parent;
      });
      if (parentExists) {
        return { type: "includedIn", status: "ng", message: chk.message || `${chk.parent}に含まれるため別途算定不可` };
      }
      return { type: "includedIn", status: "ok", message: "" };
    }
    case "condition": {
      return { type: "condition", status: "confirm", message: chk.description || "医師確認が必要" };
    }
    default:
      return { type: chk.type, status: "ok", message: "" };
  }
}

function runBillingChecks(material, allMaterials) {
  const tokutei = material?.tokutei01_name || "";
  const official = resolveOfficialName(tokutei);
  const merged = getMergedBillingReq();
  const req = merged[official] || merged[tokutei];
  if (!req) return { overall: "unknown", checks: [], rule: "", sectionId: "", requiresNote: false };

  const checks = req.checks || [];
  const ruleSummary = (typeof req.rule === "string" && req.rule.length > 100) ? req.rule.slice(0, 100) + "…" : (req.rule || "");

  if (checks.length === 0) {
    return { overall: "ok", checks: [], rule: ruleSummary, fullRule: req.rule || "", sectionId: req.sectionId || "", requiresNote: req.requiresNote || false };
  }

  const results = checks.map(chk => evaluateCheck(chk, material, allMaterials));
  const overall = results.some(r => r.status === "ng") ? "ng"
    : results.some(r => r.status === "warn") ? "warn"
    : results.some(r => r.status === "confirm") ? "confirm"
    : "ok";

  return { overall, checks: results, rule: ruleSummary, fullRule: req.rule || "", sectionId: req.sectionId || "", requiresNote: req.requiresNote || false };
}

function billingCheckDetailHtml(checks) {
  const items = (checks || []).filter(c => c.status !== "ok");
  if (!items.length) return "";
  return items.map(c => {
    const cls = c.status === "ng" ? "billing-check--ng"
      : c.status === "warn" ? "billing-check--warn"
      : "billing-check--confirm";
    return `<div class="billing-check ${cls}">${c.message}</div>`;
  }).join("");
}

/* ========= merged billing requirements ========= */
function getMergedBillingReq() {
  const base = JSON.parse(JSON.stringify(BILLING_REQ.requirements || {}));
  for (const key of (billingReqOverrides.deletions || [])) delete base[key];
  for (const [key, val] of Object.entries(billingReqOverrides.additions || {})) base[key] = val;
  return base;
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
      return `<div style="border:1px solid #e2e8f0;border-radius:16px;padding:10px;background:#fff;">
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
function materialLabel(m){
  const n = m?.product_name || "(不明)";
  const t = m?.tokutei01_name || "";
  if (!t) return n;
  const official = resolveOfficialName(t);
  const common = resolveCommonName(official);
  if (common && common !== t && official !== t) return `${n} / ${official}（${common}）`;
  if (official !== t) return `${n} / ${official}（${t}）`;
  return `${n} / ${t}`;
}
function tokuteiDisplay(tokuteiName){
  if (!tokuteiName) return "";
  const official = resolveOfficialName(tokuteiName);
  const common = resolveCommonName(official);
  if (common && common !== tokuteiName && official !== tokuteiName) return `${official}（${common}）`;
  if (official !== tokuteiName) return `${official}（${tokuteiName}）`;
  if (common) return `${tokuteiName}（${common}）`;
  return tokuteiName;
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
  const ref = new Map();
  for (const m of (newMats||[])) ref.set(materialSig(m), m);
  for (const m of (oldMats||[])) if (!ref.has(materialSig(m))) ref.set(materialSig(m), m);
  return { added, removed, ref };
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
  const labelOf = (sig)=> materialLabel(d.ref.get(sig));
  if (d.added.length){
    const s = d.added.slice(0,5).map(x=>`${labelOf(x.sig)} ×${x.qty}`).join(" / ");
    changes.push(`材料追加: ${d.added.reduce((p,c)=>p+c.qty,0)}点（${s}${d.added.length>5?" …":""}）`);
  }
  if (d.removed.length){
    const s = d.removed.slice(0,5).map(x=>`${labelOf(x.sig)} ×${x.qty}`).join(" / ");
    changes.push(`材料削除: ${d.removed.reduce((p,c)=>p+c.qty,0)}点（${s}${d.removed.length>5?" …":""}）`);
  }
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
function resolveOfficialName(tokuteiName){
  if (!tokuteiName) return "";
  if (BILLMAP.byTokuteiName?.[tokuteiName]) return tokuteiName;
  return BILLMAP.commonNameMap?.[tokuteiName] || tokuteiName;
}
function resolveCommonName(tokuteiName){
  if (!tokuteiName) return "";
  const cmap = BILLMAP.commonNameMap || {};
  for (const [common, official] of Object.entries(cmap)){
    if (official === tokuteiName) return common;
  }
  return "";
}
function billingMapCode(material){
  const t = material?.tokutei01_name || "";
  const p = material?.product_name || "";
  const official = resolveOfficialName(t);
  return BILLMAP.byTokuteiName?.[official] || BILLMAP.byTokuteiName?.[t] || BILLMAP.byProductName?.[p] || "—";
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
      doctor_comment: it.doctor_comment || "",
    };
    const mats = Array.isArray(it.materials) ? it.materials : [];
    if (!mats.length){
      rows.push({...base, qty:"", mat_product_name:"", mat_tokutei01_name:"", mat_total_reimbursement_price_yen:"", mat_jan13:"", mat_gtin14:"", mat_raw:"", mat_dict_status:"", billingmap_code:"", billing_req_status:"", billing_checks_summary:"", billing_decision:"", billing_note:""});
    } else {
      for (const m of mats){
        const chk = runBillingChecks(m, mats);
        const chkSummary = chk.checks.filter(c => c.status !== "ok").map(c => `[${c.type}]${c.message}`).join("; ");
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
          mat_raw: m.raw || "",
          mat_dict_status: m.dict_status || "",
          billingmap_code: billingMapCode(m),
          billing_req_status: chk.overall,
          billing_checks_summary: chkSummary,
          billing_decision: m.billing_decision || "",
          billing_note: m.billing_note || "",
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
    "mat_jan13","mat_gtin14","mat_raw","mat_dict_status","billingmap_code",
    "billing_req_status","billing_checks_summary","billing_decision","billing_note"
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

function stopScannerIfAny(){
  try { scannerInst?.stop?.(); } catch {}
}

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

/* ✅ サマリー（fieldで常時表示） */
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

/* ========= ⭐ Standard Builder Suggestions ========= */
function procedureLabelSafe(id){
  return PROCEDURES.find(p=>p.id===id)?.label || id;
}
function normalizeText(s){
  return String(s||"").toLowerCase();
}
function computeProcedureSuggestions(){
  ensureScanCtx();
  const mats = scanCtx.materials || [];
  const rules = Array.isArray(STANDARD_BUILDER.rules) ? STANDARD_BUILDER.rules : [];
  const defaults = Array.isArray(STANDARD_BUILDER.defaultProcedureCandidates) ? STANDARD_BUILDER.defaultProcedureCandidates : [];

  // Map: procId -> {score, reasons:Set}
  const agg = new Map();

  // default candidates
  for (const pid of defaults){
    if (!pid) continue;
    agg.set(pid, { score: 0.1, reasons: new Set(["標準"]) });
  }

  // build searchable texts
  const texts = mats.map(m=>{
    const a = m.tokutei01_name || "";
    const b = m.product_name || "";
    return normalizeText(`${a} ${b}`);
  });

  // rules matching
  for (const rule of rules){
    const matchAny = Array.isArray(rule.matchAny) ? rule.matchAny : [];
    const suggest = Array.isArray(rule.suggest) ? rule.suggest : [];
    if (!suggest.length || !matchAny.length) continue;

    // find which keywords match any material text
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
      // store only a few reasons
      for (const h of hits.slice(0,2)) cur.reasons.add(h);
      if (rule.name) cur.reasons.add(rule.name);
      agg.set(pid, cur);
    }
  }

  // build ranked list
  const out = Array.from(agg.entries())
    .map(([pid, v]) => ({
      id: pid,
      label: procedureLabelSafe(pid),
      score: v.score,
      reason: Array.from(v.reasons).filter(Boolean).slice(0,3).join(" / ")
    }))
    .sort((a,b)=>{
      if (b.score !== a.score) return b.score - a.score;
      return a.label.localeCompare(b.label, "ja");
    });

  // top 3
  return out.slice(0,3);
}

function updateSuggestionUI(){
  // step3
  const host3 = $("#suggestProcHost3");
  const host5 = $("#suggestProcHost5");
  if (!host3 && !host5) return;

  const suggestions = computeProcedureSuggestions();
  const selected = scanCtx?.procedureId || "";

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

  if (host3) host3.innerHTML = html;
  if (host5) host5.innerHTML = html;

  document.querySelectorAll("[data-sugproc]").forEach(b=>{
    b.onclick = ()=>{
      const pid = b.getAttribute("data-sugproc");
      ensureScanCtx();
      scanCtx.procedureId = pid || "";
      upsertDraft();
      updateSummaryUI();

      // sync selects if present
      const selA = $("#proc_select");
      const selB = $("#proc_select2");
      if (selA) selA.value = scanCtx.procedureId;
      if (selB) selB.value = scanCtx.procedureId;

      updateSuggestionUI();
      toastShow({ title:"手技セット", sub: procedureLabelSafe(scanCtx.procedureId) });
    };
  });
}

/* parsing / merge */
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
function decMaterialById(list, id){
  const i = list.findIndex(x=>x.id===id);
  if (i<0) return;
  const q = Number(list[i].qty||1);
  if (q > 1) list[i].qty = q - 1;
  else list.splice(i,1);
}
function removeMaterialRowById(list, id){
  const i = list.findIndex(x=>x.id===id);
  if (i<0) return;
  list.splice(i,1);
}

async function handleDetected(raw){
  const supported = parseSupported(raw);
  if (!supported) return;

  const codeKey = supported.kind==="jan13" ? supported.jan13 : supported.gtin14;

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

/* ========= demo data ========= */
function generateDemoData(){
  /* ── 診療科別シナリオ定義 ──
     各シナリオは「どの診療科で、どんな材料・手技・医師・場所を使うか」をセットで定義。
     これにより、整形外科の手術に脳外科の材料が混ざるような不自然なデモを防ぐ。 */
  const scenarios = [
    /* ─── 循環器（カテーテル室）─── */
    {
      dept: "cardiology",
      materials: [
        { product_name:"XIENCE Sierra 2.5x18mm", tokutei01_name:"冠動脈ステント", total_reimbursement_price_yen:298000, jan13:"4987350121234", dict_status:"hit" },
        { product_name:"EMERGE 2.5x15mm", tokutei01_name:"バルーンカテーテル", total_reimbursement_price_yen:89000, jan13:"4987350125678", dict_status:"hit" },
        { product_name:"Runthrough NS", tokutei01_name:"ガイドワイヤ", total_reimbursement_price_yen:18700, jan13:"4987350129012", dict_status:"hit" },
        { product_name:"Launcher 6Fr JL4", tokutei01_name:"ガイディングカテーテル", total_reimbursement_price_yen:32000, jan13:"4987350133456", dict_status:"hit" },
        { product_name:"TIG 5Fr JR4", tokutei01_name:"造影カテーテル", total_reimbursement_price_yen:8500, jan13:"4987350137890", dict_status:"hit" },
        { product_name:"Glidesheath Slender 6Fr", tokutei01_name:"シースイントロデューサ", total_reimbursement_price_yen:6200, jan13:"4987350141234", dict_status:"hit" },
        { product_name:"Angio-Seal VIP 6Fr", tokutei01_name:"止血デバイス", total_reimbursement_price_yen:38000, jan13:"4987350145678", dict_status:"hit" },
        { product_name:"Eagle Eye Platinum", tokutei01_name:"IVUSカテーテル", total_reimbursement_price_yen:125000, jan13:"4987350149012", dict_status:"hit" },
        { product_name:"Dragonfly OPTIS", tokutei01_name:"OCTカテーテル", total_reimbursement_price_yen:198000, jan13:"4987350153456", dict_status:"hit" },
        { product_name:"PressureWire X", tokutei01_name:"FFRワイヤ", total_reimbursement_price_yen:156000, jan13:"4987350157890", dict_status:"hit" },
        { product_name:"RotaLink Plus 1.5mm", tokutei01_name:"ロータブレーター用バー", total_reimbursement_price_yen:210000, jan13:"4987350161234", dict_status:"hit" },
        { product_name:"Export Advance", tokutei01_name:"血栓吸引カテーテル", total_reimbursement_price_yen:52000, jan13:"4987350165678", dict_status:"hit" },
        { product_name:"Sapien3 26mm", tokutei01_name:"TAVI弁デバイス", total_reimbursement_price_yen:4250000, jan13:"4987350169012", dict_status:"hit" },
        { product_name:"CS100 Impella CP", tokutei01_name:"Impellaカテーテル", total_reimbursement_price_yen:3800000, jan13:"4987350173456", dict_status:"hit" },
        { product_name:"TactiCath SE 8mm", tokutei01_name:"アブレーションカテーテル", total_reimbursement_price_yen:340000, jan13:"4987350177890", dict_status:"hit" },
        { product_name:"Decanav", tokutei01_name:"マッピングカテーテル", total_reimbursement_price_yen:168000, jan13:"4987350181234", dict_status:"hit" },
        { product_name:"Micra AV", tokutei01_name:"ペースメーカー本体", total_reimbursement_price_yen:1850000, jan13:"4987350185678", dict_status:"hit" },
        { product_name:"Y-connector 3way", tokutei01_name:"", total_reimbursement_price_yen:3500, jan13:"4987350199999", dict_status:"hit" },
        { product_name:"TriStar Multi-purpose", tokutei01_name:"", total_reimbursement_price_yen:12000, jan13:"4987350198765", dict_status:"hit" },
      ],
      patientIds: ["PT-2026-0001","PT-2026-0002","PT-2026-0003","PT-2026-0004","PT-2026-0005","PT-2026-0006"],
      operatorIds: ["OP-NUR-001","OP-NUR-002","OP-CE-001","OP-CE-002","OP-RT-001"],
      procedureIds: ["PR-CATH-001","PR-PCI-001","PR-PCI-003","PR-EP-002","PR-CATH-005","PR-STR-001"],
      doctorIds: ["DR-CARD-001","DR-CARD-002","DR-CARD-003","DR-EP-001","DR-CVS-001"],
      places: ["CATH-1","CATH-2"],
      count: 10
    },
    /* ─── 整形外科（手術室）─── */
    {
      dept: "orthopedics",
      materials: [
        { product_name:"Triathlon CR Total Knee", tokutei01_name:"人工関節", total_reimbursement_price_yen:896000, jan13:"4987350201001", dict_status:"hit" },
        { product_name:"Persona Knee System", tokutei01_name:"人工関節", total_reimbursement_price_yen:920000, jan13:"4987350201002", dict_status:"hit" },
        { product_name:"G7 Acetabular Cup", tokutei01_name:"人工関節", total_reimbursement_price_yen:485000, jan13:"4987350201003", dict_status:"hit" },
        { product_name:"Taperloc Complete Hip Stem", tokutei01_name:"人工関節", total_reimbursement_price_yen:530000, jan13:"4987350201004", dict_status:"hit" },
        { product_name:"Palacos R+G 40g", tokutei01_name:"骨セメント", total_reimbursement_price_yen:18500, jan13:"4987350201005", dict_status:"hit" },
        { product_name:"Simplex P SpeedSet", tokutei01_name:"骨セメント", total_reimbursement_price_yen:16800, jan13:"4987350201006", dict_status:"hit" },
        { product_name:"Neofix Locking Plate 8H", tokutei01_name:"", total_reimbursement_price_yen:186000, jan13:"4987350201007", dict_status:"hit" },
        { product_name:"Synthes LCP 3.5mm 10H", tokutei01_name:"", total_reimbursement_price_yen:192000, jan13:"4987350201008", dict_status:"hit" },
        { product_name:"Cannulated Screw 6.5mm", tokutei01_name:"", total_reimbursement_price_yen:28000, jan13:"4987350201009", dict_status:"hit" },
        { product_name:"SMITH&NEPHEW FAST-FIX 360", tokutei01_name:"", total_reimbursement_price_yen:148000, jan13:"4987350201010", dict_status:"hit" },
        { product_name:"Arthrex BioComposite SwiveLock", tokutei01_name:"", total_reimbursement_price_yen:95000, jan13:"4987350201011", dict_status:"hit" },
        { product_name:"OSferion 60 10g", tokutei01_name:"", total_reimbursement_price_yen:52000, jan13:"4987350201012", dict_status:"hit" },
      ],
      patientIds: ["PT-2026-0007","PT-2026-0001","PT-2026-0003"],
      operatorIds: ["OP-NUR-004","OP-CE-003"],
      procedureIds: ["PR-ORTH-001","PR-ORTH-002","PR-ORTH-003"],
      doctorIds: ["DR-ORTH-001","DR-ORTH-002"],
      places: ["OR-1","OR-2"],
      count: 5
    },
    /* ─── 消化器（内視鏡室 / 手術室）─── */
    {
      dept: "gastro",
      materials: [
        { product_name:"Niti-S Esophageal Stent 18x100mm", tokutei01_name:"食道ステント", total_reimbursement_price_yen:248000, jan13:"4987350301001", dict_status:"hit" },
        { product_name:"WallFlex Duodenal Stent 22x90mm", tokutei01_name:"食道ステント", total_reimbursement_price_yen:265000, jan13:"4987350301002", dict_status:"hit" },
        { product_name:"Evolution Biliary Stent 10x80mm", tokutei01_name:"食道ステント", total_reimbursement_price_yen:198000, jan13:"4987350301003", dict_status:"hit" },
        { product_name:"QuickClip Pro", tokutei01_name:"止血クリップ", total_reimbursement_price_yen:4800, jan13:"4987350301004", dict_status:"hit" },
        { product_name:"SureClip", tokutei01_name:"止血クリップ", total_reimbursement_price_yen:5200, jan13:"4987350301005", dict_status:"hit" },
        { product_name:"Instinct Endoscopic Clip", tokutei01_name:"止血クリップ", total_reimbursement_price_yen:4500, jan13:"4987350301006", dict_status:"hit" },
        { product_name:"DualKnife J 1.5mm", tokutei01_name:"", total_reimbursement_price_yen:68000, jan13:"4987350301007", dict_status:"hit" },
        { product_name:"FlushKnife BT-S 2.0mm", tokutei01_name:"", total_reimbursement_price_yen:72000, jan13:"4987350301008", dict_status:"hit" },
        { product_name:"Coagrasper Hemostatic Forceps", tokutei01_name:"", total_reimbursement_price_yen:38000, jan13:"4987350301009", dict_status:"hit" },
        { product_name:"VisiGlide2 Guidewire 0.025", tokutei01_name:"", total_reimbursement_price_yen:15600, jan13:"4987350301010", dict_status:"hit" },
        { product_name:"EZ Clip HX-610-090L", tokutei01_name:"止血クリップ", total_reimbursement_price_yen:3800, jan13:"4987350301011", dict_status:"hit" },
        { product_name:"Soehendra Biliary Dilator", tokutei01_name:"", total_reimbursement_price_yen:42000, jan13:"4987350301012", dict_status:"hit" },
      ],
      patientIds: ["PT-2026-0008","PT-2026-0002","PT-2026-0005"],
      operatorIds: ["OP-NUR-005","OP-NUR-004"],
      procedureIds: ["PR-GI-001","PR-GI-002","PR-GI-003"],
      doctorIds: ["DR-GI-001","DR-GI-002"],
      places: ["ENDO-1","OR-1"],
      count: 5
    },
    /* ─── 脳神経外科（カテ室 / 手術室）─── */
    {
      dept: "neuro",
      materials: [
        { product_name:"Target Detachable Coil 360 3x8mm", tokutei01_name:"脳動脈瘤コイル", total_reimbursement_price_yen:182000, jan13:"4987350401001", dict_status:"hit" },
        { product_name:"Axium Prime Coil 4x10mm", tokutei01_name:"脳動脈瘤コイル", total_reimbursement_price_yen:175000, jan13:"4987350401002", dict_status:"hit" },
        { product_name:"Deltamaxx Coil 2x6mm", tokutei01_name:"脳動脈瘤コイル", total_reimbursement_price_yen:168000, jan13:"4987350401003", dict_status:"hit" },
        { product_name:"CASPER Rx 10x30mm", tokutei01_name:"頸動脈ステント", total_reimbursement_price_yen:385000, jan13:"4987350401004", dict_status:"hit" },
        { product_name:"Wallstent Carotid 10x24mm", tokutei01_name:"頸動脈ステント", total_reimbursement_price_yen:358000, jan13:"4987350401005", dict_status:"hit" },
        { product_name:"Solitaire X 6x30mm", tokutei01_name:"血栓回収デバイス", total_reimbursement_price_yen:520000, jan13:"4987350401006", dict_status:"hit" },
        { product_name:"Trevo XP ProVue 4x20mm", tokutei01_name:"血栓回収デバイス", total_reimbursement_price_yen:498000, jan13:"4987350401007", dict_status:"hit" },
        { product_name:"Embotrap III 5x33mm", tokutei01_name:"血栓回収デバイス", total_reimbursement_price_yen:510000, jan13:"4987350401008", dict_status:"hit" },
        { product_name:"Excelsior SL-10 Microcatheter", tokutei01_name:"", total_reimbursement_price_yen:86000, jan13:"4987350401009", dict_status:"hit" },
        { product_name:"Synchro2 Microguidewire 0.014", tokutei01_name:"", total_reimbursement_price_yen:52000, jan13:"4987350401010", dict_status:"hit" },
        { product_name:"Headway 17 Microcatheter", tokutei01_name:"", total_reimbursement_price_yen:78000, jan13:"4987350401011", dict_status:"hit" },
        { product_name:"FilterWire EZ 3.5mm", tokutei01_name:"", total_reimbursement_price_yen:145000, jan13:"4987350401012", dict_status:"hit" },
      ],
      patientIds: ["PT-2026-0009","PT-2026-0004","PT-2026-0006"],
      operatorIds: ["OP-NUR-004","OP-CE-003","OP-RT-001"],
      procedureIds: ["PR-NEURO-001","PR-NEURO-002","PR-NEURO-003"],
      doctorIds: ["DR-NEURO-001"],
      places: ["CATH-1","OR-1"],
      count: 4
    },
    /* ─── 泌尿器科（手術室）─── */
    {
      dept: "urology",
      materials: [
        { product_name:"Resonance Ureteral Stent 6Fr 26cm", tokutei01_name:"尿管ステント", total_reimbursement_price_yen:42000, jan13:"4987350501001", dict_status:"hit" },
        { product_name:"Percuflex Plus 6Fr 24cm", tokutei01_name:"尿管ステント", total_reimbursement_price_yen:18500, jan13:"4987350501002", dict_status:"hit" },
        { product_name:"Polaris Ultra Loop 2.4Fr", tokutei01_name:"", total_reimbursement_price_yen:65000, jan13:"4987350501003", dict_status:"hit" },
        { product_name:"LithoVue Single-Use Ureteroscope", tokutei01_name:"", total_reimbursement_price_yen:198000, jan13:"4987350501004", dict_status:"hit" },
        { product_name:"Ho:YAG Laser Fiber 200μm", tokutei01_name:"", total_reimbursement_price_yen:85000, jan13:"4987350501005", dict_status:"hit" },
        { product_name:"Cook Flexor Ureteral Access Sheath 12/14Fr", tokutei01_name:"", total_reimbursement_price_yen:48000, jan13:"4987350501006", dict_status:"hit" },
        { product_name:"NiTinol Stone Basket 1.7Fr", tokutei01_name:"", total_reimbursement_price_yen:56000, jan13:"4987350501007", dict_status:"hit" },
        { product_name:"Amplatz Renal Dilator Set", tokutei01_name:"", total_reimbursement_price_yen:32000, jan13:"4987350501008", dict_status:"hit" },
      ],
      patientIds: ["PT-2026-0007","PT-2026-0003"],
      operatorIds: ["OP-NUR-004","OP-CE-003"],
      procedureIds: ["PR-URO-001","PR-URO-002"],
      doctorIds: ["DR-URO-001"],
      places: ["OR-2"],
      count: 3
    },
    /* ─── 呼吸器外科（手術室）─── */
    {
      dept: "respiratory",
      materials: [
        { product_name:"Ultraflex Tracheobronchial Stent 14x40mm", tokutei01_name:"気管支ステント", total_reimbursement_price_yen:295000, jan13:"4987350601001", dict_status:"hit" },
        { product_name:"AERO Tracheobronchial Stent 16x40mm", tokutei01_name:"気管支ステント", total_reimbursement_price_yen:310000, jan13:"4987350601002", dict_status:"hit" },
        { product_name:"Dumon Silicone Stent 14mm", tokutei01_name:"気管支ステント", total_reimbursement_price_yen:268000, jan13:"4987350601003", dict_status:"hit" },
        { product_name:"Aspira Pleural Drainage Kit", tokutei01_name:"", total_reimbursement_price_yen:42000, jan13:"4987350601004", dict_status:"hit" },
        { product_name:"Thal-Quick Chest Tube 28Fr", tokutei01_name:"", total_reimbursement_price_yen:8500, jan13:"4987350601005", dict_status:"hit" },
        { product_name:"PleurX Drainage Catheter 15.5Fr", tokutei01_name:"", total_reimbursement_price_yen:62000, jan13:"4987350601006", dict_status:"hit" },
        { product_name:"Olympus BF-1TH190 Biopsy Forceps", tokutei01_name:"", total_reimbursement_price_yen:35000, jan13:"4987350601007", dict_status:"hit" },
        { product_name:"Cryoprobe 1.9mm", tokutei01_name:"", total_reimbursement_price_yen:128000, jan13:"4987350601008", dict_status:"hit" },
      ],
      patientIds: ["PT-2026-0008","PT-2026-0009"],
      operatorIds: ["OP-NUR-004","OP-CE-003"],
      procedureIds: ["PR-RESP-001","PR-RESP-002"],
      doctorIds: ["DR-RESP-001"],
      places: ["OR-1"],
      count: 3
    }
  ];

  const pick = (arr)=> arr[Math.floor(Math.random()*arr.length)];
  const items = [];
  const baseDate = new Date();

  /* 各診療科シナリオごとにレコード生成 */
  for (const sc of scenarios){
    for (let i=0; i<sc.count; i++){
      const dayOffset = Math.floor(Math.random()*14);
      const dt = new Date(baseDate);
      dt.setDate(dt.getDate() - dayOffset);
      dt.setHours(8 + Math.floor(Math.random()*10), Math.floor(Math.random()*60));

      const matCount = 2 + Math.floor(Math.random()*4);
      const mats = [];
      const used = new Set();
      for (let j=0; j<matCount; j++){
        let m;
        do { m = pick(sc.materials); } while(used.has(m.product_name) && used.size < sc.materials.length);
        used.add(m.product_name);
        mats.push({
          id: uid("MAT"),
          raw: m.jan13,
          jan13: m.jan13,
          gtin14: null,
          dict_status: m.dict_status,
          product_name: m.product_name,
          product_no: "",
          product_sta: "",
          total_reimbursement_price_yen: m.total_reimbursement_price_yen,
          tokutei01_name: m.tokutei01_name,
          qty: 1 + Math.floor(Math.random()*2)
        });
      }

      const isApproved = Math.random() > 0.3;
      const docId = pick(sc.doctorIds);
      const opId = pick(sc.operatorIds);
      const item = {
        id: uid("DONE"),
        date: dt.toISOString().slice(0,10),
        confirmedAt: dt.toISOString(),
        status: isApproved ? "approved" : "pending",
        patientId: pick(sc.patientIds),
        operatorId: opId,
        procedureId: pick(sc.procedureIds),
        place: pick(sc.places),
        materials: mats,
        assignedDoctorId: docId,
        approved_by: isApproved ? docId : "",
        approved_at: isApproved ? new Date(dt.getTime() + 3600000).toISOString() : "",
        doctor_comment: isApproved && Math.random()>0.5 ? "確認済み。問題なし。" : "",
        history: [{
          at: dt.toISOString(),
          actor: operatorLabel(opId),
          type: "作成",
          changes: ["新規登録"]
        }]
      };
      if (isApproved){
        item.history.unshift({
          at: new Date(dt.getTime()+3600000).toISOString(),
          actor: doctorLabelById(docId),
          type: "承認",
          changes: ["承認: " + fmtDT(item.approved_at)]
        });
      }
      items.push(item);
    }
  }
  return items;
}

/* ========= UI screens ========= */
function screenRole(){
  const hasDemoData = state.done.length > 0;
  return `
    <div class="grid"><div class="card">
      <div class="h1">職種</div><div class="divider"></div>
      <div class="grid">
        ${btn("👨‍⚕️ 医師","role_doctor","primary")}
        ${btn("📶 実施入力","role_field","primary")}
        ${btn("🧾 医事","role_billing","primary")}
      </div>
      <div class="divider"></div>
      <div class="muted" style="font-size:12px;text-align:center;">デモ用</div>
      <div style="height:6px;"></div>
      <div class="grid" style="gap:6px;">
        ${hasDemoData ? "" : btn("🎯 デモデータ投入","load_demo","ghost")}
        ${hasDemoData ? btn("🗑 データリセット","reset_data","ghost") : ""}
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
      <label class="h2" for="doc_dept_sel">診療科</label>
      <select class="select" id="doc_dept_sel">${deptOptions}</select>
      <div class="divider"></div>
      <label class="h2" for="doc_id_sel">医師</label>
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
  const list = pending.length ? pending.map(x=>{
    const chkResults = (x.materials||[]).map(m => runBillingChecks(m, x.materials));
    const ngCount = chkResults.filter(r => r.overall === "ng").length;
    const warnCount = chkResults.filter(r => r.overall === "warn" || r.overall === "confirm").length;
    const ngBadge = ngCount > 0
      ? `<div style="color:#DC2626;font-size:11px;font-weight:700;margin-top:2px;">&#9888; 算定NG ${ngCount}件</div>`
      : "";
    const warnBadge = warnCount > 0
      ? `<div style="color:#d97706;font-size:11px;font-weight:700;margin-top:2px;">&#9888; 要確認 ${warnCount}件</div>`
      : "";
    return `<div class="listItem">
      <div style="display:flex;gap:12px;align-items:center;">
        <input class="check" type="checkbox" data-chk="${x.id}" aria-label="${patientLabel(x.patientId)} の承認を選択">
        <div style="min-width:0;">
          <b>${patientLabel(x.patientId)}</b>
          <div class="muted">${procedureLabel(x.procedureId)} / ${operatorLabel(x.operatorId)}</div>
          <div class="muted" style="font-size:13px;">${fmtDT(x.confirmedAt)}</div>
          ${ngBadge}${warnBadge}
        </div>
      </div>
      <button class="btn small" data-open-approve="${x.id}">詳細</button>
    </div>`;
  }).join("") : `<div class="muted">承認待ちなし</div>`;

  return `
    <div class="grid">
      <div class="card">
        <div class="h1">承認</div><div class="divider"></div>
        <label class="h2" for="bulk_comment">一括コメント（任意）</label>
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
  const mats = (item.materials||[]).map((m, idx)=>{
    const qty = m.qty || 1;
    const chk = runBillingChecks(m, item.materials);
    let statusHtml = "";
    let checksHtml = "";
    const secRef = chk.sectionId ? ` <span style="color:#4b5563;font-size:11px;">[${chk.sectionId}]</span>` : "";
    const noteWarn = chk.requiresNote ? `<span style="color:#d97706;font-size:11px;margin-left:6px;">&#9888; 摘要欄記載要</span>` : "";

    if (chk.overall === "ok") {
      statusHtml = `<div style="color:#059669;font-size:12px;font-weight:700;margin-top:2px;">&#10003; 算定OK${noteWarn}${secRef}</div>`;
    } else if (chk.overall === "ng") {
      statusHtml = `<div style="color:#DC2626;font-size:12px;font-weight:700;margin-top:2px;">&#9888; 算定要件NG${secRef}</div>`;
    } else if (chk.overall === "warn") {
      statusHtml = `<div style="color:#d97706;font-size:12px;font-weight:700;margin-top:2px;">&#9888; 要確認${noteWarn}${secRef}</div>`;
    } else if (chk.overall === "confirm") {
      statusHtml = `<div style="color:#2563eb;font-size:12px;font-weight:700;margin-top:2px;">&#9432; 条件確認${secRef}</div>`;
    } else {
      statusHtml = `<div style="color:#4b5563;font-size:12px;margin-top:2px;">&#x2014; マスタ未登録</div>`;
    }

    // 各チェック結果ごとにUI表示
    const savedChecks = m.billing_checks || [];
    const legacyDec = m.billing_decision || "";
    const legacyNote = m.billing_note || "";
    checksHtml = chk.checks.filter(c => c.status !== "ok" || c.type === "condition").map((c, ci) => {
      const saved = savedChecks[ci] || {};
      const curDec = saved.decision || (ci === 0 ? legacyDec : "") || "";
      const curNote = saved.note || (ci === 0 ? legacyNote : "") || "";
      if (c.type === "condition") {
        const cls = "billing-check billing-check--confirm";
        return `<div class="${cls}">
          <div class="billing-check-msg">${c.message}</div>
          <select data-billing-chk="${idx}-${ci}" style="width:100%;padding:5px;border:1px solid #ddd;border-radius:6px;font-size:12px;margin-top:4px;">
            <option value=""${curDec===""?" selected":""}> -- 選択 -- </option>
            <option value="met"${curDec==="met"?" selected":""}>条件を満たしている</option>
            <option value="not_met"${curDec==="not_met"?" selected":""}>条件を満たしていない</option>
          </select>
        </div>`;
      }
      const cls = c.status === "ng" ? "billing-check billing-check--ng" : "billing-check billing-check--warn";
      return `<div class="${cls}">
        <div class="billing-check-msg">${c.message}</div>
        <select data-billing-chk="${idx}-${ci}" style="width:100%;padding:5px;border:1px solid #ddd;border-radius:6px;font-size:12px;margin-top:4px;">
          <option value=""${curDec===""?" selected":""}> -- 選択 -- </option>
          <option value="bill"${curDec==="bill"?" selected":""}>請求する</option>
          <option value="no_bill"${curDec==="no_bill"?" selected":""}>請求しない</option>
        </select>
        <input type="text" data-billing-chk-note="${idx}-${ci}" value="${(curNote||"").replace(/"/g,"&quot;")}" placeholder="理由（必要時）" aria-label="算定判断の理由" style="width:100%;margin-top:3px;padding:5px;border:1px solid #ddd;border-radius:6px;font-size:12px;box-sizing:border-box;">
      </div>`;
    }).join("");

    return listItem(`<b>${m.product_name||"(不明)"} ×${qty}</b><div class="muted">${tokuteiDisplay(m.tokutei01_name)}</div>${statusHtml}${checksHtml}`);
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
    <label class="h2" for="doctor_comment">コメント</label>
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

/* Field */
function screenFieldHome(){
  return `
    <div class="grid"><div class="card">
      <div class="h1">実施入力</div>
      <div class="grid">
        ${btn("📶 スキャン","go_field_scan","primary")}
        ${btn("📄 下書き","go_field_drafts","primary")}
        ${btn("✅ 実施済み","go_field_done","primary")}
        ${btn("📊 ダッシュボード","go_field_dashboard","ghost")}
      </div>
    </div></div>
  `;
}

function screenDrafts(){
  const list = state.drafts.length ? state.drafts.map(d=>{
    const mode = d.editDoneId ? "（修正）" : "";
    const qtySum = (d.materials||[]).reduce((p,m)=>p+Number(m.qty||1),0);
    return `<div class="listItem">
      <div><b>${patientLabel(d.patientId)}${mode}</b><div class="muted">${operatorLabel(d.operatorId)} / ${procedureLabel(d.procedureId)} / ${qtySum}点</div></div>
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
  const items = state.done.filter(x=>x.date===todayStr());
  const list = items.length ? items.map(x=>{
    const st = x.status==="pending" ? "承認待ち" : "承認済み";
    const hasC = x.doctor_comment ? "💬" : "";
    const qtySum = (x.materials||[]).reduce((p,m)=>p+Number(m.qty||1),0);
    return `<div class="listItem" data-open-done="${x.id}">
      <div style="min-width:0;">
        <b>${patientLabel(x.patientId)} ${hasC}</b>
        <div class="muted">${procedureLabel(x.procedureId)} / ${operatorLabel(x.operatorId)} / ${st}</div>
        <div class="muted" style="font-size:13px;">承認依頼：${doctorLabelById(x.assignedDoctorId)}</div>
      </div>
      <span class="tag">${qtySum}点</span>
    </div>`;
  }).join("") : `<div class="muted">当日データなし</div>`;

  return `<div class="grid">
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
        <div><div class="h1">実施済み</div><div class="muted">当日分</div></div>
        <button class="btn small ghost" id="field_csv">⬇ CSV</button>
      </div>
      <div class="divider"></div>
      <div class="grid">${list}</div>
      <div class="divider"></div>
      ${btn("⬅ 戻る","back_field_home2","ghost")}
    </div>
    <div class="card" id="doneDetail" style="display:none;"></div>
  </div>`;
}

function renderDoneDetail(item){
  const st = item.status==="pending" ? "承認待ち" : "承認済み";
  const approver = doctorLabelById(item.assignedDoctorId);
  const comment = item.doctor_comment ? `
    <div style="border:1px solid #e2e8f0;border-radius:16px;padding:10px;background:#fff;margin:10px 0;">
      <div class="h2">医師コメント</div>
      <div class="muted">${item.doctor_comment}</div>
    </div>` : "";

  const mats = (item.materials||[]).map(m=>{
    const qty = m.qty || 1;
    return listItem(`<b>${m.product_name||"(不明)"} ×${qty}</b><div class="muted">${tokuteiDisplay(m.tokutei01_name)}</div>`);
  }).join("") || `<div class="muted">材料なし</div>`;

  const editButtons = item.status==="pending"
    ? `<div class="row">
         ${btn("✏ 修正","done_edit","primary")}
         ${btn("🗑 削除","done_delete","ghost")}
       </div>`
    : `<div class="muted">承認済みのため修正不可</div>`;

  return `
    <div class="h2">詳細</div>
    ${listItem(`<b>日時</b><div class="muted">${fmtDT(item.confirmedAt)}</div>`)}
    ${listItem(`<b>患者</b><div class="muted">${patientLabel(item.patientId)}</div>`)}
    ${listItem(`<b>入力者</b><div class="muted">${operatorLabel(item.operatorId)}</div>`)}
    ${listItem(`<b>手技</b><div class="muted">${procedureLabel(item.procedureId)}</div>`)}
    ${listItem(`<b>承認依頼</b><div class="muted">${approver}</div>`)}
    ${listItem(`<b>状態</b><div class="muted">${st}</div>`)}
    ${comment}
    <div class="divider"></div>
    <div class="h2">材料</div>
    <div class="grid">${mats}</div>
    <div class="divider"></div>
    ${editButtons}
    <div class="divider"></div>
    <div class="h2">編集履歴</div>
    ${renderHistory(item)}
    <div class="divider"></div>
    ${btn("✖ 閉じる","close_done_detail","ghost")}
  `;
}

/* Field steps */
function screenFieldStep(step){
  ensureScanCtx();
  scanCtx.step = step;

  const stepLabels = ["入力者","患者","手技","スキャン","確認"];
  const stepProgress = `<nav class="step-progress" aria-label="スキャンフロー進捗">
    ${stepLabels.map((l,i)=>{
      const n = i+1;
      const cls = n < step ? "done" : n === step ? "active" : "";
      const lineCls = n < step ? "done" : "";
      const dot = `<div class="step-dot ${cls}" aria-current="${n===step?"step":""}" title="${l}">${n}</div>`;
      return i === 0 ? dot : `<div class="step-line ${lineCls}"></div>${dot}`;
    }).join("")}
  </nav>`;

  const saveBar = `
    <div class="row">
      <button class="btn ghost" id="save_draft_any">💾 下書き</button>
      <button class="btn ghost" id="cancel_flow" aria-label="スキャンフローを中止">✖ 中止</button>
    </div>`;

  if (step===1){
    return `<div class="grid">${stepProgress}<div class="card">
      <div class="h1">入力者</div><div class="divider"></div>
      <select class="select" id="op_select" aria-label="入力者を選択">
        <option value="">選択</option>
        ${OPERATORS.map(o=>`<option value="${o.id}" ${scanCtx.operatorId===o.id?"selected":""}>${o.label}</option>`).join("")}
      </select>
      <div class="divider"></div>${btn("➡ 次へ","to_step2","primary")}
      <div class="divider"></div>${saveBar}
    </div></div>`;
  }
  if (step===2){
    return `<div class="grid">${stepProgress}<div class="card">
      <div class="h1">患者</div><div class="divider"></div>
      <select class="select" id="pt_select" aria-label="患者を選択">
        <option value="">選択</option>
        ${PATIENTS.map(p=>`<option value="${p.id}" ${scanCtx.patientId===p.id?"selected":""}>${p.label}</option>`).join("")}
      </select>
      <div class="divider"></div>${btn("➡ 次へ","to_step3","primary")}
      <div class="divider"></div>${saveBar}
    </div></div>`;
  }
  if (step===3){
    return `<div class="grid">${stepProgress}<div class="card">
      <div class="h1">手技</div>
      <div class="muted">材料からおすすめを表示（⭐）</div>
      <div class="divider"></div>

      <div class="h2">おすすめ</div>
      <div id="suggestProcHost3"></div>

      <div class="divider"></div>
      <select class="select" id="proc_select" aria-label="手技を選択">
        <option value="">選択</option>
        ${PROCEDURES.map(p=>`<option value="${p.id}" ${scanCtx.procedureId===p.id?"selected":""}>${p.label}</option>`).join("")}
      </select>

      <div class="divider"></div>${btn("➡ 次へ","to_step4","primary")}
      <div class="divider"></div>${saveBar}
    </div></div>`;
  }
  if (step===4){
    return `<div class="grid">${stepProgress}<div class="card">
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

  // confirm (step 5)
  return `<div class="grid">${stepProgress}<div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
      <div>
        <div class="h1">確定</div>
        <div class="muted">承認依頼前に確認（⭐おすすめあり）</div>
      </div>
      ${scanCtx.editDoneId ? `<span class="tag">修正</span>` : ``}
    </div>
    <div class="divider"></div>

    <div class="h2">おすすめ手技</div>
    <div id="suggestProcHost5"></div>

    <div class="divider"></div>
    <label class="h2" for="op_select2">入力者</label>
    <select class="select" id="op_select2">
      <option value="">未選択</option>
      ${OPERATORS.map(o=>`<option value="${o.id}" ${scanCtx.operatorId===o.id?"selected":""}>${o.label}</option>`).join("")}
    </select>

    <div class="divider"></div>
    <label class="h2" for="pt_select2">患者</label>
    <select class="select" id="pt_select2">
      <option value="">未選択</option>
      ${PATIENTS.map(p=>`<option value="${p.id}" ${scanCtx.patientId===p.id?"selected":""}>${p.label}</option>`).join("")}
    </select>

    <div class="divider"></div>
    <label class="h2" for="proc_select2">手技</label>
    <select class="select" id="proc_select2">
      <option value="">未選択</option>
      ${PROCEDURES.map(p=>`<option value="${p.id}" ${scanCtx.procedureId===p.id?"selected":""}>${p.label}</option>`).join("")}
    </select>

    <div class="divider"></div>
    <div class="h2">材料</div>
    <div class="grid" id="confirmList"></div>

    <div class="divider"></div>
    <div class="h2">修正内容</div>
    <div id="diffBox" class="grid" style="gap:8px;"></div>

    <div class="divider"></div>
    <div class="row">
      ${btn("＋ 材料を追加","go_add_material","ghost")}
      ${btn("➡ 承認依頼","to_approver_select","primary")}
      ${btn("💾 下書き","save_draft_any2","ghost")}
    </div>
    <div class="divider"></div>
    ${btn("⬅ 戻る","back_step4","ghost")}
  </div></div>`;
}

/* Approver select */
function screenApproverSelect(){
  ensureScanCtx();
  const deptOptions = [`<option value="ALL"${scanCtx.approverDept==="ALL"?" selected":""}>すべて</option>`]
    .concat(doctorDeptList().map(d=>`<option value="${d}"${scanCtx.approverDept===d?" selected":""}>${d}</option>`))
    .join("");

  const docs = sortedApprovers(scanCtx.approverDept);
  const options = docs.map(d=>{
    const label = `${d.dept} ${d.name}（${d.id}）`;
    return `<option value="${d.id}" ${scanCtx.assignedDoctorId===d.id?"selected":""}>${label}</option>`;
  }).join("");

  const recentTop = docs.slice(0,3).map(d=>{
    return `<button class="btn ghost" data-quick-approver="${d.id}">⭐ ${d.name}（${d.dept}）</button>`;
  }).join("");

  return `<div class="grid"><div class="card">
    <div class="h1">承認依頼</div>
    <div class="muted">承認者を選択（診療科で絞り込み／最近使った順）</div>
    <div class="divider"></div>

    <label class="h2" for="approver_dept">診療科</label>
    <select class="select" id="approver_dept">${deptOptions}</select>

    <div class="divider"></div>
    <div class="h2">最近</div>
    <div class="grid" style="gap:10px;">${recentTop || `<div class="muted">最近の選択なし</div>`}</div>

    <div class="divider"></div>
    <label class="h2" for="approver_select">承認者</label>
    <select class="select" id="approver_select">
      <option value="">未選択</option>
      ${options}
    </select>

    <div class="divider"></div>
    <div class="row">
      ${btn("📨 依頼する","request_approval","primary")}
      ${btn("⬅ 戻る","back_to_confirm","ghost")}
    </div>
  </div></div>`;
}

/* Billing screens (v22維持) */
function screenBillingHome(){
  return `<div class="grid"><div class="card">
    <div class="h1">医事</div>
    <div class="grid">
      ${btn("📄 実施入力済み（承認済み）","go_bill_done","primary")}
      ${btn("⏳ 承認待ち","go_bill_pending","primary")}
      ${btn("🔍 UKE突合","go_bill_uke","primary")}
      ${btn("📊 ダッシュボード","go_bill_dashboard","primary")}
      ${btn("⚙ 算定要件マスタ","go_bill_req","primary")}
    </div>
  </div></div>`;
}
/* ========= 算定要件マスタメンテナンスUI ========= */
function screenBillingReqList(){
  const merged = getMergedBillingReq();
  const names = Object.keys(merged).sort((a,b)=>a.localeCompare(b,"ja"));
  const customKeys = Object.keys(billingReqOverrides.additions || {});
  const rows = names.map(name=>{
    const r = merged[name];
    const isCustom = customKeys.includes(name);
    const checks = (r.checks||[]).map(c=>c.type).join(", ");
    const badge = isCustom ? `<span class="req-badge-custom">カスタム</span>` : "";
    return `<div class="listItem" style="flex-direction:column;align-items:stretch;gap:4px;">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <b>${name}${badge}</b>
      </div>
      <div class="muted">セクション: ${r.sectionId||"—"} / チェック: ${(r.checks||[]).length}件${checks ? " ["+checks+"]" : ""}</div>
      <div class="row" style="justify-content:flex-end;gap:6px;margin-top:4px;">
        <button class="btn small ghost bill-req-edit" data-name="${name}">編集</button>
        <button class="btn small ghost bill-req-del" data-name="${name}" style="color:#DC2626;">削除</button>
      </div>
    </div>`;
  }).join("");
  return `<div class="grid"><div class="card">
    <div class="h1">算定要件マスタ</div>
    <div class="muted" style="margin-bottom:12px;">材料の算定要件チェックルールを管理します</div>
    <input class="input" id="reqSearchInput" placeholder="材料名で検索..." aria-label="材料名で検索" style="margin-bottom:10px;">
    <div class="row" style="margin-bottom:12px;">
      ${btn("➕ 新規追加","go_bill_req_new","primary")}
      ${btn("🔄 初期状態に戻す","go_bill_req_reset","ghost")}
    </div>
    <div class="grid" id="reqListContainer">${rows}</div>
    <div style="margin-top:16px;">
      ${btn("⬅ 戻る","back_bill_req_home","ghost")}
    </div>
  </div></div>`;
}

function renderCheckEditorCard(check, index){
  const t = check.type || "maxQty";
  let fields = "";
  if (t === "maxQty"){
    fields = `
      <div class="row" style="gap:8px;margin-bottom:6px;">
        <label style="font-size:13px;font-weight:700;">上限数:</label>
        <input class="input chk-field" data-idx="${index}" data-field="limit" type="number" min="1" value="${check.limit||1}" style="width:80px;">
      </div>
      <div class="row" style="gap:8px;margin-bottom:6px;">
        <label style="font-size:13px;font-weight:700;">単位:</label>
        <input class="input chk-field" data-idx="${index}" data-field="unit" value="${check.unit||""}" style="width:160px;">
      </div>
      <div class="row" style="gap:8px;margin-bottom:6px;">
        <label style="font-size:13px;"><input type="checkbox" class="check chk-field" data-idx="${index}" data-field="overrideWithNote" ${check.overrideWithNote?"checked":""}> 摘要欄記載で上書き可</label>
      </div>
      <div style="margin-bottom:4px;">
        <label style="font-size:13px;font-weight:700;">説明:</label>
        <textarea class="chk-field" data-idx="${index}" data-field="description" rows="2" style="width:100%;border-radius:8px;border:1px solid var(--line);padding:8px;font-size:13px;font-family:inherit;">${check.description||""}</textarea>
      </div>`;
  } else if (t === "simultaneousNg"){
    fields = `
      <div style="margin-bottom:6px;">
        <label style="font-size:13px;font-weight:700;">対象材料（カンマ区切り）:</label>
        <input class="input chk-field" data-idx="${index}" data-field="targets" value="${(check.targets||[]).join(", ")}">
      </div>
      <div style="margin-bottom:6px;">
        <label style="font-size:13px;font-weight:700;">メッセージ:</label>
        <textarea class="chk-field" data-idx="${index}" data-field="message" rows="2" style="width:100%;border-radius:8px;border:1px solid var(--line);padding:8px;font-size:13px;font-family:inherit;">${check.message||""}</textarea>
      </div>
      <div class="row" style="gap:8px;margin-bottom:6px;">
        <label style="font-size:13px;"><input type="checkbox" class="check chk-field" data-idx="${index}" data-field="overrideWithNote" ${check.overrideWithNote?"checked":""}> 摘要欄記載で上書き可</label>
      </div>`;
  } else if (t === "includedIn"){
    fields = `
      <div style="margin-bottom:6px;">
        <label style="font-size:13px;font-weight:700;">親材料:</label>
        <input class="input chk-field" data-idx="${index}" data-field="parent" value="${check.parent||""}">
      </div>
      <div style="margin-bottom:6px;">
        <label style="font-size:13px;font-weight:700;">構成品目（カンマ区切り）:</label>
        <input class="input chk-field" data-idx="${index}" data-field="components" value="${(check.components||[]).join(", ")}">
      </div>
      <div style="margin-bottom:6px;">
        <label style="font-size:13px;font-weight:700;">メッセージ:</label>
        <textarea class="chk-field" data-idx="${index}" data-field="message" rows="2" style="width:100%;border-radius:8px;border:1px solid var(--line);padding:8px;font-size:13px;font-family:inherit;">${check.message||""}</textarea>
      </div>`;
  } else if (t === "condition"){
    fields = `
      <div style="margin-bottom:6px;">
        <label style="font-size:13px;font-weight:700;">条件説明:</label>
        <textarea class="chk-field" data-idx="${index}" data-field="description" rows="2" style="width:100%;border-radius:8px;border:1px solid var(--line);padding:8px;font-size:13px;font-family:inherit;">${check.description||""}</textarea>
      </div>
      <div class="muted" style="font-size:12px;">※ 確認ダイアログが常に表示されます</div>`;
  }
  return `<div class="req-check-card">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
      <b style="font-size:14px;">${t}</b>
      <button class="btn small ghost chk-remove" data-idx="${index}" style="color:#DC2626;width:auto;padding:0 10px;height:32px;font-size:12px;">✕ 削除</button>
    </div>
    ${fields}
  </div>`;
}

function screenBillingReqEdit(name, data, isNew){
  const title = isNew ? "算定要件 新規作成" : "算定要件 編集";
  const checksHtml = (data.checks||[]).map((c,i)=>renderCheckEditorCard(c,i)).join("");
  return `<div class="grid"><div class="card">
    <div class="h1">${title}</div>
    <div style="margin-bottom:12px;">
      <label style="font-size:13px;font-weight:700;display:block;margin-bottom:4px;">材料名（特定保険医療材料名）</label>
      <input class="input" id="reqEditName" value="${name}" ${isNew?"":"readonly"} style="${isNew?"":"background:#f5f5f5;"}">
    </div>
    <div style="margin-bottom:12px;">
      <label style="font-size:13px;font-weight:700;display:block;margin-bottom:4px;">セクションID</label>
      <input class="input" id="reqEditSection" value="${data.sectionId||""}">
    </div>
    <div style="margin-bottom:12px;">
      <label style="font-size:13px;font-weight:700;display:block;margin-bottom:4px;">ルール（留意事項テキスト）</label>
      <textarea id="reqEditRule" rows="3" style="width:100%;border-radius:12px;border:1.5px solid var(--line);padding:12px;font-size:14px;font-family:inherit;">${data.rule||""}</textarea>
    </div>
    <div style="margin-bottom:12px;">
      <label style="font-size:13px;"><input type="checkbox" class="check" id="reqEditRequiresNote" ${data.requiresNote?"checked":""}> 摘要欄記載が必要</label>
    </div>
    <div class="divider"></div>
    <div class="h2">チェックルール</div>
    <div id="checksContainer">${checksHtml}</div>
    <div class="row" style="margin-top:8px;gap:8px;">
      <select class="select" id="addCheckType" style="height:42px;width:auto;flex:1;">
        <option value="maxQty">maxQty</option>
        <option value="simultaneousNg">simultaneousNg</option>
        <option value="includedIn">includedIn</option>
        <option value="condition">condition</option>
      </select>
      <button class="btn small primary" id="addCheckBtn" style="width:auto;">＋ 追加</button>
    </div>
    <div class="row" style="margin-top:16px;gap:8px;">
      ${btn("保存","reqEditSave","primary")}
      ${btn("キャンセル","reqEditCancel","ghost")}
    </div>
  </div></div>`;
}

function billingMaterialCard(m){
  const code = billingMapCode(m);
  const qty = Number(m.qty||1);
  const line1 = [(m.product_name||"(不明)"), `×${qty}`, (m.product_no||""), (m.product_sta||"")].filter(Boolean).join(" ");
  const tok = tokuteiDisplay(m.tokutei01_name);
  const price = m.total_reimbursement_price_yen ? `${jpy(m.total_reimbursement_price_yen)}円` : "";
  return `
    <div style="position:relative;border:1px solid #e2e8f0;border-radius:16px;padding:12px;background:linear-gradient(180deg,#fff,#F0F9FF);">
      <div class="tag" style="position:absolute;top:10px;right:10px;">${code}</div>
      <div style="font-weight:900;font-size:16px;line-height:1.25;padding-right:86px;">${line1}</div>
      <div class="muted" style="margin-top:6px;">${tok}</div>
      <div style="margin-top:6px;font-weight:900;color:#DC2626;">${price}</div>
    </div>`;
}
function renderBillingDetail(item){
  const st = item.status==="pending" ? "承認待ち" : "承認済み";
  const headerInfo = `
    ${listItem(`<b>日時</b><div class="muted">${fmtDT(item.confirmedAt)}</div>`)}
    ${listItem(`<b>患者</b><div class="muted">${patientLabel(item.patientId)}</div>`)}
    ${listItem(`<b>手技</b><div class="muted">${procedureLabel(item.procedureId)}</div>`)}
    ${listItem(`<b>入力者</b><div class="muted">${operatorLabel(item.operatorId)}</div>`)}
    ${listItem(`<b>承認依頼</b><div class="muted">${doctorLabelById(item.assignedDoctorId)}</div>`)}
    ${listItem(`<b>状態</b><div class="muted">${st}</div>`)}
    ${listItem(`<b>承認者</b><div class="muted">${doctorLabelById(item.approved_by||"")}</div>`)}
    ${listItem(`<b>承認日時</b><div class="muted">${item.approved_at?fmtDT(item.approved_at):"—"}</div>`)}
  `;
  const comment = item.doctor_comment ? `
    <div style="border:1px solid #e2e8f0;border-radius:16px;padding:10px;background:#fff;margin-top:10px;">
      <div class="h2">医師コメント</div>
      <div class="muted">${item.doctor_comment}</div>
    </div>` : "";
  const mats = (item.materials||[]).map(m=>billingMaterialCard(m)).join("") || `<div class="muted">材料なし</div>`;
  return `
    <div class="h2">詳細</div>
    <div class="divider"></div>
    <div class="grid">${headerInfo}</div>
    ${comment}
    <div class="divider"></div>
    <div class="grid" style="gap:10px;">${mats}</div>
    <div class="divider"></div>
    <div class="h2">編集履歴</div>
    ${renderHistory(item)}
    <div class="divider"></div>
    ${btn("✖ 閉じる","close_bill_detail","ghost")}
  `;
}
function screenBillingList(kind){
  const isPending = kind==="pending";
  const approverOptions = [
    `<option value="ALL">すべて</option>`,
    `<option value="NONE">未承認</option>`,
    `<option value="BILLING">医事課（最終承認）</option>`,
    ...DOCTORS.map(d=>`<option value="${d.id}">${d.dept} ${d.name}（${d.id}）</option>`)
  ].join("");
  const dateOptions = `<option value="TODAY">今日</option><option value="7D">直近7日</option><option value="ALL">全期間</option>`;
  const bulkApproverOptions = [
    `<option value="BILLING">医事課（最終承認）</option>`,
    ...DOCTORS.map(d=>`<option value="${d.id}">${d.dept} ${d.name}（${d.id}）</option>`)
  ].join("");

  return `<div class="grid">
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
        <div><div class="h1">${isPending ? "承認待ち" : "実施入力済み（承認済み）"}</div></div>
        <button class="btn small ghost" id="bill_csv">⬇ CSV</button>
      </div>

      <div class="divider"></div>
      <div class="grid" style="gap:10px;">
        <div>
          <label class="h2" for="bill_filter_approver">承認者</label>
          <select class="select" id="bill_filter_approver">${approverOptions}</select>
        </div>
        <div>
          <label class="h2" for="bill_filter_approvedat">承認日時</label>
          <select class="select" id="bill_filter_approvedat">${dateOptions}</select>
        </div>
      </div>

      ${isPending ? `
        <div class="divider"></div>
        <div class="h2">一括承認（最終手段）</div>
        <div class="muted">点検済みのものを医事でまとめて承認</div>
        <div style="height:8px;"></div>
        <label class="h2" for="bill_bulk_approver">承認者</label>
        <select class="select" id="bill_bulk_approver">${bulkApproverOptions}</select>
        <div style="height:10px;"></div>
        ${btn("✅ 選択を一括承認","bill_bulk_approve","primary")}
      ` : ""}

      <div class="divider"></div>
      <div class="grid" id="billList"></div>

      <div class="divider"></div>
      ${btn("⬅ 戻る","back_billing_home","ghost")}
    </div>

    <div class="card" id="billDetail" style="display:none;"></div>
  </div>`;
}

/* ========= UKE突合画面 ========= */
function buildUkeData(periodFilter){
  const now = Date.now();
  const startOfToday = new Date();
  startOfToday.setHours(0,0,0,0);

  let items = state.done.slice();
  if (periodFilter && periodFilter !== "ALL"){
    items = items.filter(x=>{
      const t = x.confirmedAt ? new Date(x.confirmedAt).getTime() : 0;
      if (!t) return false;
      if (periodFilter === "TODAY") return t >= startOfToday.getTime();
      if (periodFilter === "7D") return (now - t) <= 7*24*3600000;
      if (periodFilter === "30D") return (now - t) <= 30*24*3600000;
      if (periodFilter === "90D") return (now - t) <= 90*24*3600000;
      return true;
    });
  }

  const approved = items.filter(x=>x.status==="approved");
  const pending = items.filter(x=>x.status==="pending");
  const allItems = items;
  const rows = [];
  allItems.forEach(item=>{
    const assignedDoc = DOCTORS.find(d=>d.id===item.assignedDoctorId);
    const dept = assignedDoc ? assignedDoc.dept : "";
    (item.materials||[]).forEach(m=>{
      const code = billingMapCode(m);
      const price = Number(m.total_reimbursement_price_yen || 0);
      const qty = Number(m.qty || 1);
      const billingChk = runBillingChecks(m, item.materials);
      rows.push({
        itemId: item.id,
        itemStatus: item.status,
        dept: dept,
        patientId: item.patientId,
        patient: patientLabel(item.patientId),
        procedureId: item.procedureId,
        procedure: procedureLabel(item.procedureId),
        operatorId: item.operatorId,
        operator: operatorLabel(item.operatorId),
        confirmedAt: item.confirmedAt,
        materialName: m.product_name || "(不明)",
        tokutei: m.tokutei01_name || "",
        jan13: m.jan13 || "",
        billingCode: code,
        price: price,
        qty: qty,
        lineTotal: price * qty,
        hasBillingCode: code !== "—",
        approved_by: item.approved_by || "",
        doctor_comment: item.doctor_comment || "",
        billingReqStatus: billingChk.overall,
        billingReqChecks: billingChk.checks,
        billingReqRule: billingChk.rule || "",
        billingDecision: m.billing_decision || "",
        billingChecks: m.billing_checks || [],
        billingNote: m.billing_note || ""
      });
    });
  });
  return { rows, approvedCount: approved.length, pendingCount: pending.length, totalItems: allItems.length };
}

function renderUkeResults(periodFilter, deptFilter){
  const { rows: allRows, approvedCount, pendingCount, totalItems } = buildUkeData(periodFilter);

  /* 診療科フィルター適用 */
  const rows = (deptFilter && deptFilter !== "ALL") ? allRows.filter(r=>r.dept===deptFilter) : allRows;

  const matched = rows.filter(r=>r.hasBillingCode);
  const unmatched = rows.filter(r=>!r.hasBillingCode);
  const totalPrice = rows.reduce((s,r)=>s+r.lineTotal, 0);
  const matchedPrice = matched.reduce((s,r)=>s+r.lineTotal, 0);
  const unmatchedPrice = unmatched.reduce((s,r)=>s+r.lineTotal, 0);
  const matchRate = rows.length ? Math.round(matched.length / rows.length * 100) : 0;
  const lostRevenue = unmatchedPrice;

  /* --- 算定要件NG/warn集計 --- */
  const billingNgRows = rows.filter(r=>r.billingReqStatus === "ng");
  const billingWarnRows = rows.filter(r=>r.billingReqStatus === "warn" || r.billingReqStatus === "confirm");
  const billingNoBillRows = rows.filter(r=>r.billingDecision === "no_bill");
  const billingNgPrice = billingNgRows.reduce((s,r)=>s+r.lineTotal, 0);
  const billingWarnPrice = billingWarnRows.reduce((s,r)=>s+r.lineTotal, 0);

  /* --- 請求漏れリスク：NG未判断（UKEコードはあるが算定NGで医師未判断）--- */
  const undecidedNgRows = rows.filter(r=>r.billingReqStatus === "ng" && !r.billingDecision && r.hasBillingCode);
  const undecidedNgPrice = undecidedNgRows.reduce((s,r)=>s+r.lineTotal, 0);

  /* --- 診療科別サマリー集計 --- */
  const deptStats = new Map();
  allRows.forEach(r=>{
    const d = r.dept || "(未設定)";
    if (!deptStats.has(d)) deptStats.set(d, { total:0, matched:0, unmatched:0, totalPrice:0, unmatchedPrice:0, undecidedNg:0, undecidedNgPrice:0 });
    const s = deptStats.get(d);
    s.total++;
    s.totalPrice += r.lineTotal;
    if (r.hasBillingCode){ s.matched++; }
    else { s.unmatched++; s.unmatchedPrice += r.lineTotal; }
    if (r.billingReqStatus === "ng" && !r.billingDecision){ s.undecidedNg++; s.undecidedNgPrice += r.lineTotal; }
  });
  const deptSummaryHtml = Array.from(deptStats.entries())
    .sort((a,b)=>(b[1].unmatchedPrice+b[1].undecidedNgPrice) - (a[1].unmatchedPrice+a[1].undecidedNgPrice))
    .map(([dept, s])=>{
      const rate = s.total ? Math.round(s.matched / s.total * 100) : 0;
      const riskTotal = s.unmatchedPrice + s.undecidedNgPrice;
      const isActive = deptFilter === dept;
      const border = isActive ? "2px solid var(--primary)" : "1px solid #e2e8f0";
      return `<div data-dept-card="${dept}" style="border:${border};border-radius:16px;padding:10px;background:linear-gradient(180deg,#fff,#F0F9FF);cursor:pointer;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div style="font-weight:900;font-size:14px;">${dept}</div>
          <div style="font-weight:900;font-size:14px;color:${rate>=80?'#059669':'#DC2626'};">${rate}%</div>
        </div>
        <div style="display:flex;gap:10px;margin-top:4px;">
          <div class="muted" style="font-size:12px;">${s.total}材料</div>
          <div style="font-size:12px;font-weight:900;color:#059669;">${s.matched}紐付</div>
          <div style="font-size:12px;font-weight:900;color:#DC2626;">${s.unmatched}漏れ</div>
          ${s.undecidedNg ? `<div style="font-size:12px;font-weight:900;color:#d97706;">${s.undecidedNg}NG未判断</div>` : ""}
        </div>
        ${riskTotal > 0 ? `<div style="font-size:12px;font-weight:900;color:#DC2626;margin-top:2px;">リスク額: ${jpy(riskTotal)}円</div>` : ""}
      </div>`;
    }).join("");

  /* --- 商品名でグルーピング --- */
  function groupByProduct(list){
    const map = new Map();
    list.forEach(r=>{
      const key = r.materialName;
      if (!map.has(key)) map.set(key, { name:key, tokutei:r.tokutei, jan13:r.jan13, unitPrice:r.price, totalQty:0, totalPrice:0, items:[] });
      const g = map.get(key);
      g.totalQty += r.qty;
      g.totalPrice += r.lineTotal;
      g.items.push(r);
    });
    return Array.from(map.values()).sort((a,b)=>b.totalPrice - a.totalPrice);
  }

  /* --- 未マッチ：商品別グループ＋折り畳み --- */
  const unmatchedGroups = groupByProduct(unmatched);
  const unmatchedHtml = unmatchedGroups.length ? unmatchedGroups.map((g,gi)=>{
    const detailRows = g.items.map(r=>{
      const statusTag = r.itemStatus==="pending"
        ? `<span class="tag" style="background:#fef3c7;color:#92400e;border-color:#fde68a;font-size:11px;">承認待ち</span>`
        : `<span class="tag" style="background:#FEE2E2;color:#DC2626;border-color:rgba(220,38,38,.35);font-size:11px;">未マッチ</span>`;
      const reqTag = r.billingReqStatus === "ng"
        ? `<span class="tag" style="background:#FEF2F2;color:#DC2626;border-color:rgba(220,38,38,.25);font-size:10px;">算定NG</span>`
        : r.billingReqStatus === "warn"
        ? `<span class="tag" style="background:#fffbeb;color:#d97706;border-color:#fde68a;font-size:10px;">要確認</span>`
        : r.billingReqStatus === "confirm"
        ? `<span class="tag" style="background:#eff6ff;color:#2563eb;border-color:#bfdbfe;font-size:10px;">条件確認</span>`
        : r.billingReqStatus === "ok"
        ? `<span class="tag" style="background:#f0fdf4;color:#059669;border-color:#d1fae5;font-size:10px;">算定OK</span>`
        : "";
      const decTag = r.billingDecision === "no_bill"
        ? `<span class="tag" style="background:#fef3c7;color:#92400e;border-color:#fde68a;font-size:10px;">請求しない</span>`
        : r.billingDecision === "bill"
        ? `<span class="tag" style="background:#dbeafe;color:#1d4ed8;border-color:#93c5fd;font-size:10px;">請求する</span>`
        : "";
      return `<div style="padding:8px 0;border-top:1px solid #e2e8f0;">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;">
          <div style="flex:1;min-width:0;">
            <div class="muted" style="font-size:12px;">${r.dept ? `${r.dept} / ` : ""}${r.patient} / ${r.procedure}</div>
            <div class="muted" style="font-size:11px;">x${r.qty} / ${fmtDT(r.confirmedAt)}</div>
          </div>
          <div style="text-align:right;white-space:nowrap;">
            <div style="font-size:13px;font-weight:900;color:#DC2626;">${jpy(r.lineTotal)}円</div>
            ${statusTag} ${reqTag} ${decTag}
          </div>
        </div>
        ${billingCheckDetailHtml(r.billingReqChecks)}
      </div>`;
    }).join("");

    return `<div style="border:1px solid rgba(220,38,38,.3);border-radius:16px;overflow:hidden;background:linear-gradient(180deg,#fff,#FEF2F2);">
      <div style="padding:12px;">
        <div style="display:flex;justify-content:space-between;align-items:start;">
          <div style="flex:1;min-width:0;">
            <div style="font-weight:900;font-size:15px;color:#DC2626;">${g.name}</div>
            <div class="muted" style="font-size:13px;">${tokuteiDisplay(g.tokutei) || "(特定保険医療材料名なし)"}</div>
            <div class="muted" style="font-size:12px;">JAN: ${g.jan13 || "—"}</div>
          </div>
          <div style="text-align:right;white-space:nowrap;">
            <div style="font-size:18px;font-weight:900;color:#DC2626;">${jpy(g.totalPrice)}円</div>
            <div style="font-size:14px;font-weight:900;">x${g.totalQty}</div>
          </div>
        </div>
      </div>
      <details style="border-top:1px solid #e2e8f0;">
        <summary style="padding:8px 12px;font-size:13px;font-weight:900;color:var(--muted);cursor:pointer;user-select:none;">明細（${g.items.length}件）</summary>
        <div style="padding:0 12px 10px;">${detailRows}</div>
      </details>
    </div>`;
  }).join("") : `<div class="muted">未マッチ材料なし（全件UKEコード紐付済み）</div>`;

  /* --- マッチ済み：商品別グループ＋折り畳み --- */
  const matchedGroups = groupByProduct(matched);
  const matchedHtml = matchedGroups.length ? matchedGroups.map((g,gi)=>{
    const code = g.items[0]?.billingCode || "—";
    const ngCnt = g.items.filter(r=>r.billingReqStatus==="ng").length;
    const warnCnt = g.items.filter(r=>r.billingReqStatus==="warn"||r.billingReqStatus==="confirm").length;
    const detailRows = g.items.map(r=>{
      const reqTag = r.billingReqStatus === "ng"
        ? `<span class="tag" style="background:#FEF2F2;color:#DC2626;border-color:rgba(220,38,38,.25);font-size:10px;">算定NG</span>`
        : r.billingReqStatus === "warn"
        ? `<span class="tag" style="background:#fffbeb;color:#d97706;border-color:#fde68a;font-size:10px;">要確認</span>`
        : r.billingReqStatus === "confirm"
        ? `<span class="tag" style="background:#eff6ff;color:#2563eb;border-color:#bfdbfe;font-size:10px;">条件確認</span>`
        : "";
      return `<div style="padding:6px 0;border-top:1px solid #e2e8f0;">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;">
        <div class="muted" style="font-size:12px;flex:1;min-width:0;">${r.dept ? `${r.dept} / ` : ""}${r.patient} / ${r.procedure} / x${r.qty} / ${fmtDT(r.confirmedAt)}</div>
        <div style="white-space:nowrap;">${reqTag}</div>
      </div>
      ${billingCheckDetailHtml(r.billingReqChecks)}
    </div>`;
    }).join("");

    const checkBadges = (ngCnt > 0 ? `<span class="tag" style="background:#FEF2F2;color:#DC2626;border-color:rgba(220,38,38,.25);font-size:10px;">NG ${ngCnt}</span> ` : "")
      + (warnCnt > 0 ? `<span class="tag" style="background:#fffbeb;color:#d97706;border-color:#fde68a;font-size:10px;">要確認 ${warnCnt}</span>` : "");

    return `<div style="border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;background:#fff;">
      <div style="padding:10px 12px;display:flex;justify-content:space-between;align-items:center;">
        <div style="flex:1;min-width:0;">
          <div style="font-weight:900;font-size:14px;">${g.name} ${checkBadges}</div>
          <div class="muted" style="font-size:12px;">${tokuteiDisplay(g.tokutei) || "(特定保険医療材料名なし)"}</div>
        </div>
        <div style="text-align:right;white-space:nowrap;">
          <div style="font-weight:900;">${jpy(g.totalPrice)}円</div>
          <div style="font-size:13px;font-weight:900;">x${g.totalQty}</div>
          <span class="tag">${code}</span>
        </div>
      </div>
      ${g.items.length > 1 ? `<details style="border-top:1px solid #e2e8f0;">
        <summary style="padding:6px 12px;font-size:12px;color:var(--muted);cursor:pointer;user-select:none;">明細（${g.items.length}件）</summary>
        <div style="padding:0 12px 8px;">${detailRows}</div>
      </details>` : ""}
    </div>`;
  }).join("") : `<div class="muted">マッチ済み材料なし</div>`;

  const deptLabel = (deptFilter && deptFilter !== "ALL") ? ` [${deptFilter}]` : "";

  const host = $("#ukeResults");
  if (!host) return;

  host.innerHTML = `
    <div class="card">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div style="border:1px solid #e2e8f0;border-radius:16px;padding:12px;background:linear-gradient(180deg,#fff,#F0F9FF);text-align:center;">
          <div class="muted" style="font-size:12px;">対象材料数${deptLabel}</div>
          <div style="font-size:28px;font-weight:900;">${rows.length}</div>
          <div class="muted" style="font-size:11px;">実施${totalItems}件中</div>
        </div>
        <div style="border:1px solid ${matchRate>=80?'#d1fae5':'rgba(220,38,38,.35)'};border-radius:16px;padding:12px;background:linear-gradient(180deg,#fff,${matchRate>=80?'#f0fdf4':'#FEF2F2'});text-align:center;">
          <div class="muted" style="font-size:12px;">マッチ率</div>
          <div style="font-size:28px;font-weight:900;color:${matchRate>=80?'#059669':'#DC2626'};">${matchRate}%</div>
          <div class="muted" style="font-size:11px;">${rows.length}材料中</div>
        </div>
        <div style="border:1px solid #d1fae5;border-radius:16px;padding:12px;background:linear-gradient(180deg,#fff,#f0fdf4);text-align:center;">
          <div class="muted" style="font-size:12px;">請求可能（コード紐付済み）</div>
          <div style="font-size:20px;font-weight:900;color:#059669;">${matched.length}件</div>
          <div style="font-size:14px;font-weight:900;color:#059669;">${jpy(matchedPrice)}円</div>
        </div>
        <div style="border:1px solid rgba(220,38,38,.35);border-radius:16px;padding:12px;background:linear-gradient(180deg,#fff,#FEF2F2);text-align:center;">
          <div class="muted" style="font-size:12px;">コードなし</div>
          <div style="font-size:20px;font-weight:900;color:#DC2626;">${unmatched.length}件</div>
          <div style="font-size:14px;font-weight:900;color:#DC2626;">${jpy(unmatchedPrice)}円</div>
        </div>
      </div>

      <div class="divider"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;">
        <div style="border:1px solid #e2e8f0;border-radius:16px;padding:12px;background:#fff;text-align:center;">
          <div class="muted" style="font-size:12px;">償還価格合計</div>
          <div style="font-size:22px;font-weight:900;">${jpy(totalPrice)}円</div>
        </div>
        <div style="border:1px solid ${lostRevenue>0?'rgba(220,38,38,.4)':'#d1fae5'};border-radius:16px;padding:12px;background:linear-gradient(180deg,#fff,${lostRevenue>0?'#FEF2F2':'#f0fdf4'});text-align:center;">
          <div class="muted" style="font-size:12px;">コードなし漏れ額</div>
          <div style="font-size:22px;font-weight:900;color:${lostRevenue>0?'#DC2626':'#059669'};">${jpy(lostRevenue)}円</div>
        </div>
        <div style="border:1px solid ${undecidedNgPrice>0?'rgba(245,158,11,.4)':'#d1fae5'};border-radius:16px;padding:12px;background:linear-gradient(180deg,#fff,${undecidedNgPrice>0?'#fffbeb':'#f0fdf4'});text-align:center;">
          <div class="muted" style="font-size:12px;">NG未判断リスク</div>
          <div style="font-size:22px;font-weight:900;color:${undecidedNgPrice>0?'#d97706':'#059669'};">${jpy(undecidedNgPrice)}円</div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="h2">診療科別サマリー</div>
      <div class="muted" style="font-size:12px;margin-bottom:8px;">カードをタップすると、その診療科のみに絞り込みます。</div>
      <div class="grid" style="gap:8px;" id="ukeDeptCards">${deptSummaryHtml}</div>
    </div>

    ${lostRevenue > 0 ? `
    <div class="card" style="border-color:rgba(220,38,38,.3);background:linear-gradient(180deg,#fff,#FEF2F2);">
      <div style="font-weight:900;font-size:15px;color:#DC2626;margin-bottom:4px;">ブラックボックスの可視化</div>
      <div class="muted" style="font-size:13px;line-height:1.5;">算定要件を満たさず請求されなかった材料は、従来は査定もされず見過ごされていました。LinQ VALは使用実績を全件記録し、請求コードとの突合で「請求できていない材料」を自動検出します。</div>
      <div style="margin-top:8px;font-weight:900;font-size:14px;color:#DC2626;">推定損失額：${jpy(lostRevenue)}円（対象期間内）</div>
    </div>` : ""}

    ${(billingNgRows.length + billingWarnRows.length) > 0 ? (()=>{
      const billingDetailRows = rows.filter(r=>["ng","warn","confirm"].includes(r.billingReqStatus));
      return `
    <div class="card" style="border-color:rgba(245,158,11,.4);background:linear-gradient(180deg,#fff,#fffbeb);">
      <div class="h2" style="color:#d97706;">算定要件チェック</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">
        <div style="border:1px solid rgba(220,38,38,.35);border-radius:16px;padding:10px;background:#fff;text-align:center;">
          <div class="muted" style="font-size:11px;">算定要件NG</div>
          <div style="font-size:20px;font-weight:900;color:#DC2626;">${billingNgRows.length}件</div>
          <div style="font-size:13px;font-weight:900;color:#DC2626;">${jpy(billingNgPrice)}円</div>
        </div>
        <div style="border:1px solid #fde68a;border-radius:16px;padding:10px;background:#fff;text-align:center;">
          <div class="muted" style="font-size:11px;">要確認</div>
          <div style="font-size:20px;font-weight:900;color:#d97706;">${billingWarnRows.length}件</div>
          <div style="font-size:13px;font-weight:900;color:#d97706;">${jpy(billingWarnPrice)}円</div>
        </div>
        <div style="border:1px solid #e2e8f0;border-radius:16px;padding:10px;background:#fff;text-align:center;">
          <div class="muted" style="font-size:11px;">請求しない</div>
          <div style="font-size:20px;font-weight:900;">${billingNoBillRows.length}件</div>
        </div>
      </div>
      ${billingDetailRows.length ? `
      <details style="margin-top:12px;">
        <summary style="font-size:13px;font-weight:900;color:var(--muted);cursor:pointer;user-select:none;">材料別の詳細（${billingDetailRows.length}件）</summary>
        <div style="margin-top:8px;display:flex;flex-direction:column;gap:8px;">
          ${billingDetailRows
            .sort((a,b)=>{ const ord = {ng:0,warn:1,confirm:2}; return (ord[a.billingReqStatus]??3) - (ord[b.billingReqStatus]??3) || b.lineTotal - a.lineTotal; })
            .map(r=>{
              const overallColor = r.billingReqStatus === "ng" ? "#DC2626" : r.billingReqStatus === "warn" ? "#d97706" : "#2563eb";
              const overallLabel = r.billingReqStatus === "ng" ? "NG" : r.billingReqStatus === "warn" ? "要確認" : "条件確認";
              const decTag = r.billingDecision === "no_bill"
                ? `<span class="tag" style="background:#fef3c7;color:#92400e;border-color:#fde68a;font-size:10px;">請求しない</span>`
                : r.billingDecision === "bill"
                ? `<span class="tag" style="background:#dbeafe;color:#1d4ed8;border-color:#93c5fd;font-size:10px;">請求する</span>` : "";
              return `<div style="border:1px solid rgba(0,0,0,.08);border-radius:12px;padding:10px;background:#fff;">
                <div style="display:flex;justify-content:space-between;align-items:start;gap:6px;">
                  <div style="flex:1;min-width:0;">
                    <div style="font-weight:900;font-size:13px;">${r.materialName}</div>
                    <div class="muted" style="font-size:11px;">${r.dept ? r.dept+" / " : ""}${r.patient} / ${r.procedure}</div>
                  </div>
                  <div style="text-align:right;white-space:nowrap;">
                    <span style="font-weight:900;font-size:12px;color:${overallColor};">${overallLabel}</span>
                    <div style="font-size:12px;font-weight:900;">x${r.qty} / ${jpy(r.lineTotal)}円</div>
                    ${decTag}
                  </div>
                </div>
                ${billingCheckDetailHtml(r.billingReqChecks)}
              </div>`;
            }).join("")}
        </div>
      </details>` : ""}
    </div>`;
    })() : ""}

    ${undecidedNgRows.length > 0 ? (()=>{
      const ngGroups = (()=>{
        const m = new Map();
        undecidedNgRows.forEach(r=>{
          const k = r.materialName;
          if(!m.has(k)) m.set(k, {name:k,tokutei:r.tokutei,billingCode:r.billingCode,totalQty:0,totalPrice:0,items:[]});
          const g = m.get(k);
          g.totalQty += r.qty;
          g.totalPrice += r.lineTotal;
          g.items.push(r);
        });
        return Array.from(m.values()).sort((a,b)=>b.totalPrice-a.totalPrice);
      })();
      return `
    <div class="card" style="border-color:rgba(245,158,11,.4);background:linear-gradient(180deg,#fff,#fffbeb);">
      <div class="h2" style="color:#d97706;">NG未判断材料（${undecidedNgRows.length}件 / ${jpy(undecidedNgPrice)}円）${deptLabel}</div>
      <div class="muted" style="font-size:12px;margin-bottom:8px;">UKEコードは紐付済みだが、算定要件NGかつ医師が請求可否を未選択の材料です。承認画面で確認が必要です。</div>
      <div class="grid" style="gap:8px;">
        ${ngGroups.map(g=>{
          const detRows = g.items.map(r=>{
            const reqTag = r.billingReqStatus === "ng"
              ? '<span class="tag" style="background:#FEF2F2;color:#DC2626;border-color:rgba(220,38,38,.25);font-size:10px;">算定NG</span>' : "";
            return '<div style="padding:8px 0;border-top:1px solid rgba(245,158,11,.2);">'
              + '<div style="display:flex;justify-content:space-between;align-items:center;gap:6px;">'
              + '<div style="flex:1;min-width:0;">'
              + '<div class="muted" style="font-size:12px;">' + (r.dept?r.dept+" / ":"") + r.patient + " / " + r.procedure + '</div>'
              + '<div class="muted" style="font-size:11px;">x' + r.qty + " / " + fmtDT(r.confirmedAt) + '</div>'
              + '</div>'
              + '<div style="text-align:right;white-space:nowrap;">'
              + '<div style="font-size:13px;font-weight:900;color:#d97706;">' + jpy(r.lineTotal) + '円</div>'
              + reqTag
              + '</div></div>'
              + billingCheckDetailHtml(r.billingReqChecks)
              + '</div>';
          }).join("");
          return '<div style="border:1px solid rgba(245,158,11,.35);border-radius:16px;overflow:hidden;background:linear-gradient(180deg,#fff,#fffbeb);">'
            + '<div style="padding:12px;">'
            + '<div style="display:flex;justify-content:space-between;align-items:start;">'
            + '<div style="flex:1;min-width:0;">'
            + '<div style="font-weight:900;font-size:15px;color:#d97706;">' + g.name + '</div>'
            + '<div class="muted" style="font-size:13px;">' + (tokuteiDisplay(g.tokutei) || "(特定保険医療材料名なし)") + '</div>'
            + '<div class="muted" style="font-size:12px;">UKE: ' + g.billingCode + '</div>'
            + '</div>'
            + '<div style="text-align:right;white-space:nowrap;">'
            + '<div style="font-size:18px;font-weight:900;color:#d97706;">' + jpy(g.totalPrice) + '円</div>'
            + '<div style="font-size:14px;font-weight:900;">x' + g.totalQty + '</div>'
            + '</div></div></div>'
            + (g.items.length > 0 ? '<details style="border-top:1px solid rgba(245,158,11,.25);"><summary style="padding:8px 12px;font-size:13px;font-weight:900;color:var(--muted);cursor:pointer;user-select:none;">明細（' + g.items.length + '件）</summary><div style="padding:0 12px 10px;">' + detRows + '</div></details>' : '')
            + '</div>';
        }).join("")}
      </div>
    </div>`;
    })() : ""}

    <div class="card">
      <div class="h2" style="color:#DC2626;">UKEコードなし材料（${unmatched.length}件）${deptLabel}</div>
      <div class="muted" style="font-size:12px;margin-bottom:8px;">UKE請求コードが紐付いていない材料。算定要件の確認またはbilling_mapへの追加が必要です。</div>
      <div class="grid" style="gap:8px;">${unmatchedHtml}</div>
    </div>

    <div class="card">
      <div class="h2" style="color:#059669;">コード紐付済み（${matched.length}件）${deptLabel}</div>
      <div class="grid" style="gap:6px;">${matchedHtml}</div>
    </div>`;
}

function screenUkeReconciliation(){
  const deptOpts = [`<option value="ALL">全診療科</option>`]
    .concat(doctorDeptList().map(d=>`<option value="${d}">${d}</option>`))
    .join("");

  return `<div class="grid">
    <div class="card">
      <div class="h1">UKE突合チェック</div>
      <div class="muted" style="line-height:1.5;">実施記録の材料をUKE請求コード（billing_map）と突合し、「ズレ」と「請求漏れ」を検出します。</div>
      <div class="divider"></div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div>
          <label class="h2" for="uke_period">対象期間</label>
          <select class="select" id="uke_period">
            <option value="TODAY">今日</option>
            <option value="7D">直近7日</option>
            <option value="30D" selected>直近30日</option>
            <option value="90D">直近90日</option>
            <option value="ALL">全期間</option>
          </select>
        </div>
        <div>
          <label class="h2" for="uke_dept">診療科</label>
          <select class="select" id="uke_dept">${deptOpts}</select>
        </div>
      </div>
      <div style="height:6px;"></div>
      <div class="muted" style="font-size:12px;">カスタム期間</div>
      <div style="display:flex;gap:8px;margin-top:4px;">
        <input type="date" class="input" id="uke_from" aria-label="開始日" style="font-size:15px;">
        <span style="align-self:center;">〜</span>
        <input type="date" class="input" id="uke_to" aria-label="終了日" style="font-size:15px;">
      </div>
      <div style="height:6px;"></div>
      ${btn("カスタム期間で絞り込み","uke_custom_apply","ghost")}
    </div>

    <div id="ukeResults"></div>

    <div class="card">
      ${btn("⬇ UKE突合CSV出力","uke_csv","ghost")}
      <div style="height:8px;"></div>
      ${btn("⬅ 戻る","back_uke","ghost")}
    </div>
  </div>`;
}

/* ========= ダッシュボード画面 ========= */
function buildDashboardData(){
  const all = state.done || [];
  const approved = all.filter(x=>x.status==="approved");
  const pending = all.filter(x=>x.status==="pending");

  // 材料集計
  const matMap = new Map();
  const procMap = new Map();
  const doctorMap = new Map();
  const dailyMap = new Map();

  // 算定要件集計
  let billingNgCount = 0;
  let billingNgPrice = 0;
  let billingWarnCount = 0;
  let billingWarnPrice = 0;
  let billingNoBillCount = 0;
  let billingNoBillPrice = 0;
  let billingUndecidedNgCount = 0;
  let billingUndecidedNgPrice = 0;
  let billingNoCodeCount = 0;
  let billingNoCodePrice = 0;
  const billingNgMap = new Map();
  const billingDetailItems = [];
  const billingLeakItems = [];
  const billingLeakDeptMap = new Map();

  all.forEach(item=>{
    // 手技別
    const proc = procedureLabel(item.procedureId);
    procMap.set(proc, (procMap.get(proc)||0)+1);

    // 承認医師別
    if (item.approved_by) {
      const doc = doctorLabelById(item.approved_by);
      doctorMap.set(doc, (doctorMap.get(doc)||0)+1);
    }

    // 日別
    const day = (item.confirmedAt||"").slice(0,10) || "不明";
    dailyMap.set(day, (dailyMap.get(day)||0)+1);

    // 材料別 + 算定要件チェック
    (item.materials||[]).forEach(m=>{
      const key = m.product_name || m.tokutei01_name || "(不明)";
      const prev = matMap.get(key) || { count:0, totalPrice:0 };
      const qty = Number(m.qty||1);
      const price = Number(m.total_reimbursement_price_yen||0);
      prev.count += qty;
      prev.totalPrice += price * qty;
      matMap.set(key, prev);

      const chk = runBillingChecks(m, item.materials);
      if (chk.overall === "ng") {
        billingNgCount += qty;
        billingNgPrice += price * qty;
        const reason = chk.checks.filter(c=>c.status==="ng").map(c=>c.message).join("; ") || chk.rule || "不明";
        const rprev = billingNgMap.get(reason) || { count:0, price:0 };
        rprev.count += qty;
        rprev.price += price * qty;
        billingNgMap.set(reason, rprev);
        if (!m.billing_decision) {
          billingUndecidedNgCount += qty;
          billingUndecidedNgPrice += price * qty;
        }
      }
      if (chk.overall === "warn" || chk.overall === "confirm") {
        billingWarnCount += qty;
        billingWarnPrice += price * qty;
      }
      if (m.billing_decision === "no_bill") {
        billingNoBillCount += qty;
        billingNoBillPrice += price * qty;
      }
      if (["ng","warn","confirm"].includes(chk.overall)) {
        billingDetailItems.push({
          name: m.product_name || m.tokutei01_name || "(不明)",
          qty, price: price * qty,
          overall: chk.overall,
          checks: chk.checks,
          patient: patientLabel(item.patientId),
          procedure: procedureLabel(item.procedureId),
          decision: m.billing_decision || ""
        });
      }

      /* 請求漏れリスク詳細: UKEコードなし or 未判断NG */
      const ukeCode = billingMapCode(m);
      const hasCode = ukeCode !== "—";
      const assignedDoc = DOCTORS.find(dc=>dc.id===item.assignedDoctorId);
      const dept = assignedDoc ? assignedDoc.dept : "(未設定)";
      const isUndecidedNg = chk.overall === "ng" && !m.billing_decision;
      if (!hasCode || isUndecidedNg) {
        const leakType = !hasCode ? "nocode" : "undecided_ng";
        billingLeakItems.push({
          leakType,
          name: m.product_name || m.tokutei01_name || "(不明)",
          tokutei: m.tokutei01_name || "",
          ukeCode,
          qty, price: price * qty,
          overall: chk.overall,
          checks: chk.checks,
          patient: patientLabel(item.patientId),
          procedure: procedureLabel(item.procedureId),
          dept,
          date: (item.confirmedAt||"").slice(0,10),
          decision: m.billing_decision || "",
          rule: chk.rule || ""
        });
        const ds = billingLeakDeptMap.get(dept) || { nocode:0, nocodePrice:0, undecidedNg:0, undecidedNgPrice:0 };
        if (!hasCode){ ds.nocode += qty; ds.nocodePrice += price * qty; }
        if (isUndecidedNg){ ds.undecidedNg += qty; ds.undecidedNgPrice += price * qty; }
        billingLeakDeptMap.set(dept, ds);
      }
      if (!hasCode) {
        billingNoCodeCount += qty;
        billingNoCodePrice += price * qty;
      }
    });
  });

  // 総額
  let totalPrice = 0;
  matMap.forEach(v=>{ totalPrice += v.totalPrice; });

  // ソート: 使用数TOP
  const matTop = Array.from(matMap.entries())
    .sort((a,b)=>b[1].count-a[1].count)
    .slice(0,10);
  const procTop = Array.from(procMap.entries())
    .sort((a,b)=>b[1]-a[1])
    .slice(0,8);
  const doctorTop = Array.from(doctorMap.entries())
    .sort((a,b)=>b[1]-a[1])
    .slice(0,8);
  const dailySorted = Array.from(dailyMap.entries())
    .sort((a,b)=>a[0].localeCompare(b[0]))
    .slice(-14);

  const billingNgTop = Array.from(billingNgMap.entries())
    .sort((a,b)=>b[1].price - a[1].price)
    .slice(0,8);

  return { all, approved, pending, matTop, procTop, doctorTop, dailySorted, totalPrice,
    billingNgCount, billingNgPrice, billingWarnCount, billingWarnPrice,
    billingNoBillCount, billingNoBillPrice,
    billingUndecidedNgCount, billingUndecidedNgPrice, billingNgTop, billingDetailItems,
    billingNoCodeCount, billingNoCodePrice, billingLeakItems, billingLeakDeptMap };
}

function barChart(entries, maxVal, colorFn){
  if (!entries.length) return `<div class="muted">データなし</div>`;
  return entries.map(([label, val], i)=>{
    const pct = maxVal > 0 ? Math.max(4, Math.round(val / maxVal * 100)) : 4;
    const color = colorFn ? colorFn(label, val) : "var(--primary)";
    const delay = (i * 60);
    return `<div style="margin-bottom:8px;">
      <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:3px;align-items:baseline;">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:68%;color:var(--text2);">${label}</span>
        <span style="font-weight:900;font-size:14px;color:var(--text);font-variant-numeric:tabular-nums;">${val}</span>
      </div>
      <div style="width:100%;height:22px;background:rgba(240,212,224,.3);border-radius:11px;overflow:hidden;">
        <div style="width:${pct}%;height:100%;background:${color};border-radius:11px;transition:width .5s cubic-bezier(.22,1,.36,1) ${delay}ms;"></div>
      </div>
    </div>`;
  }).join("");
}

function screenDashboard(){
  const d = buildDashboardData();
  const matMax = d.matTop.length ? d.matTop[0][1].count : 1;
  const procMax = d.procTop.length ? d.procTop[0][1] : 1;
  const doctorMax = d.doctorTop.length ? d.doctorTop[0][1] : 1;
  const dailyMax = d.dailySorted.length ? Math.max(...d.dailySorted.map(x=>x[1])) : 1;

  return `<div class="grid">
    <div class="card">
      <div class="h1">ダッシュボード</div>
      <div class="muted">実施記録データの統計サマリー</div>
      <div class="divider"></div>

      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">
        <div style="border:1px solid #e2e8f0;border-radius:16px;padding:10px;background:#fff;text-align:center;">
          <div class="muted" style="font-size:11px;">全件</div>
          <div style="font-size:24px;font-weight:900;">${d.all.length}</div>
        </div>
        <div style="border:1px solid #d1fae5;border-radius:16px;padding:10px;background:linear-gradient(180deg,#fff,#f0fdf4);text-align:center;">
          <div class="muted" style="font-size:11px;">承認済</div>
          <div style="font-size:24px;font-weight:900;color:#059669;">${d.approved.length}</div>
        </div>
        <div style="border:1px solid rgba(220,38,38,.35);border-radius:16px;padding:10px;background:linear-gradient(180deg,#fff,#FEF2F2);text-align:center;">
          <div class="muted" style="font-size:11px;">承認待ち</div>
          <div style="font-size:24px;font-weight:900;color:#DC2626;">${d.pending.length}</div>
        </div>
      </div>

      <div style="margin-top:12px;border:1px solid #e2e8f0;border-radius:16px;padding:12px;background:#fff;text-align:center;">
        <div class="muted" style="font-size:12px;">償還価格累計</div>
        <div style="font-size:26px;font-weight:900;">${jpy(d.totalPrice)}円</div>
      </div>
    </div>

    <div class="card">
      <div class="h2">材料使用ランキング（TOP10）</div>
      <div class="divider"></div>
      ${barChart(d.matTop.map(([k,v])=>[k,v.count]), matMax, ()=>"linear-gradient(90deg,#0891B2,#22D3EE)")}
    </div>

    <div class="card">
      <div class="h2">材料コストランキング（TOP10）</div>
      <div class="divider"></div>
      ${(()=>{
        const costTop = d.matTop.slice().sort((a,b)=>b[1].totalPrice-a[1].totalPrice);
        const costMax = costTop.length ? costTop[0][1].totalPrice : 1;
        return barChart(costTop.map(([k,v])=>[k+` (${jpy(v.totalPrice)}円)`,v.totalPrice]), costMax, ()=>"linear-gradient(90deg,#f59e0b,#fbbf24)");
      })()}
    </div>

    <div class="card">
      <div class="h2">手技別件数</div>
      <div class="divider"></div>
      ${barChart(d.procTop, procMax, ()=>"linear-gradient(90deg,#3b82f6,#60a5fa)")}
    </div>

    <div class="card">
      <div class="h2">承認医師別件数</div>
      <div class="divider"></div>
      ${barChart(d.doctorTop, doctorMax, ()=>"linear-gradient(90deg,#8b5cf6,#a78bfa)")}
    </div>

    <div class="card">
      <div class="h2">日別実施件数（直近14日）</div>
      <div class="divider"></div>
      ${barChart(d.dailySorted, dailyMax, ()=>"linear-gradient(90deg,#059669,#34d399)")}
    </div>

    <div class="card" style="border-color:rgba(220,38,38,.3);background:linear-gradient(180deg,#fff,#FEF2F2);">
      <div class="h2" style="color:#DC2626;">算定要件チェック</div>
      <div class="divider"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <div style="border:1px solid rgba(220,38,38,.35);border-radius:16px;padding:10px;background:#fff;text-align:center;">
          <div class="muted" style="font-size:11px;">算定要件NG</div>
          <div style="font-size:22px;font-weight:900;color:#DC2626;">${d.billingNgCount}件</div>
          <div style="font-size:13px;font-weight:900;color:#DC2626;">${jpy(d.billingNgPrice)}円</div>
        </div>
        <div style="border:1px solid #fde68a;border-radius:16px;padding:10px;background:#fff;text-align:center;">
          <div class="muted" style="font-size:11px;">要確認（warn/条件）</div>
          <div style="font-size:22px;font-weight:900;color:#d97706;">${d.billingWarnCount}件</div>
          <div style="font-size:13px;font-weight:900;color:#d97706;">${jpy(d.billingWarnPrice)}円</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr;gap:8px;margin-top:8px;">
        <div style="border:1px solid #e2e8f0;border-radius:16px;padding:10px;background:#fff;text-align:center;">
          <div class="muted" style="font-size:11px;">医師判断「請求しない」</div>
          <div style="font-size:22px;font-weight:900;">${d.billingNoBillCount}件</div>
          <div style="font-size:13px;font-weight:900;">${jpy(d.billingNoBillPrice)}円</div>
        </div>
      </div>
      ${d.billingNgTop.length ? `
      <div style="margin-top:12px;">
        <div class="muted" style="font-size:12px;margin-bottom:6px;">NG理由別内訳</div>
        ${barChart(d.billingNgTop.map(([k,v])=>[k+` (${jpy(v.price)}円)`, v.count]), d.billingNgTop.length ? d.billingNgTop[0][1].count : 1, ()=>"linear-gradient(90deg,#DC2626,#EF4444)")}
      </div>` : ""}
      ${d.billingDetailItems.length ? `
      <details style="margin-top:12px;">
        <summary style="font-size:13px;font-weight:900;color:var(--muted);cursor:pointer;user-select:none;">算定要件NG/要確認 材料の詳細（${d.billingDetailItems.length}件）</summary>
        <div style="margin-top:8px;display:flex;flex-direction:column;gap:8px;">
          ${d.billingDetailItems.map(it=>{
            const overallColor = it.overall === "ng" ? "#DC2626" : it.overall === "warn" ? "#d97706" : "#2563eb";
            const overallLabel = it.overall === "ng" ? "NG" : it.overall === "warn" ? "要確認" : "条件確認";
            const decLabel = it.decision === "no_bill" ? `<span class="tag" style="background:#fef3c7;color:#92400e;border-color:#fde68a;font-size:10px;">請求しない</span>`
              : it.decision === "bill" ? `<span class="tag" style="background:#dbeafe;color:#1d4ed8;border-color:#93c5fd;font-size:10px;">請求する</span>` : "";
            return `<div style="border:1px solid rgba(0,0,0,.08);border-radius:12px;padding:10px;background:#fff;">
              <div style="display:flex;justify-content:space-between;align-items:start;gap:6px;">
                <div style="flex:1;min-width:0;">
                  <div style="font-weight:900;font-size:13px;">${it.name}</div>
                  <div class="muted" style="font-size:11px;">${it.patient} / ${it.procedure}</div>
                </div>
                <div style="text-align:right;white-space:nowrap;">
                  <span style="font-weight:900;font-size:12px;color:${overallColor};">${overallLabel}</span>
                  <div style="font-size:12px;font-weight:900;">x${it.qty} / ${jpy(it.price)}円</div>
                  ${decLabel}
                </div>
              </div>
              ${billingCheckDetailHtml(it.checks)}
            </div>`;
          }).join("")}
        </div>
      </details>` : ""}
    </div>

    ${(d.billingUndecidedNgCount > 0 || d.billingNoCodeCount > 0) ? (()=>{
      const totalLeakCount = d.billingUndecidedNgCount + d.billingNoCodeCount;
      const totalLeakPrice = d.billingUndecidedNgPrice + d.billingNoCodePrice;

      /* 診療科別内訳テーブル */
      const deptEntries = Array.from(d.billingLeakDeptMap.entries()).sort((a,b)=>(b[1].nocodePrice+b[1].undecidedNgPrice)-(a[1].nocodePrice+a[1].undecidedNgPrice));
      const deptRows = deptEntries.map(([dept,s])=>{
        const total = s.nocodePrice + s.undecidedNgPrice;
        return `<div style="display:grid;grid-template-columns:1fr auto auto auto;gap:6px;align-items:center;padding:6px 0;border-bottom:1px solid rgba(245,158,11,.15);font-size:12px;">
          <div style="font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${dept}</div>
          <div style="text-align:right;color:#d97706;">${s.nocode?s.nocode+"件":""}</div>
          <div style="text-align:right;color:#DC2626;">${s.undecidedNg?s.undecidedNg+"件":""}</div>
          <div style="text-align:right;font-weight:900;">${jpy(total)}円</div>
        </div>`;
      }).join("");

      /* 材料別明細（金額降順） */
      const sortedLeaks = d.billingLeakItems.slice().sort((a,b)=>b.price-a.price);
      const nocodeItems = sortedLeaks.filter(it=>it.leakType==="nocode");
      const undecidedItems = sortedLeaks.filter(it=>it.leakType==="undecided_ng");

      const leakItemHtml = (it)=>{
        const typeColor = it.leakType === "nocode" ? "#d97706" : "#DC2626";
        const typeLabel = it.leakType === "nocode" ? "コードなし" : "NG未判断";
        return `<div style="border:1px solid rgba(0,0,0,.08);border-radius:12px;padding:10px;background:#fff;">
          <div style="display:flex;justify-content:space-between;align-items:start;gap:6px;">
            <div style="flex:1;min-width:0;">
              <div style="font-weight:900;font-size:13px;line-height:1.3;">${it.name}</div>
              <div class="muted" style="font-size:11px;">${it.tokutei||"特定保険材料名なし"}</div>
              <div class="muted" style="font-size:11px;">${it.patient} / ${it.procedure}</div>
              <div class="muted" style="font-size:11px;">${it.dept} / ${it.date}</div>
            </div>
            <div style="text-align:right;white-space:nowrap;">
              <span style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:10px;font-weight:700;color:#fff;background:${typeColor};">${typeLabel}</span>
              <div style="font-size:13px;font-weight:900;margin-top:4px;">x${it.qty} / ${jpy(it.price)}円</div>
              <div class="muted" style="font-size:10px;">UKE: ${it.ukeCode}</div>
            </div>
          </div>
          ${it.rule ? `<div class="muted" style="font-size:11px;margin-top:4px;padding:4px 6px;background:#fffbeb;border-radius:6px;">💡 ${it.rule}</div>` : ""}
          ${billingCheckDetailHtml(it.checks)}
        </div>`;
      };

      return `
    <div class="card" style="border-color:rgba(245,158,11,.4);background:linear-gradient(180deg,#fff,#fffbeb);">
      <div class="h2" style="color:#d97706;">請求漏れリスク</div>
      <div class="muted" style="font-size:13px;line-height:1.5;margin-bottom:8px;">UKE請求コードが紐付かない材料、または算定要件NGで医師が請求可否を未判断の材料です。</div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <div style="border:1px solid rgba(245,158,11,.35);border-radius:16px;padding:10px;background:#fff;text-align:center;">
          <div class="muted" style="font-size:11px;">リスク件数合計</div>
          <div style="font-size:22px;font-weight:900;color:#d97706;">${totalLeakCount}件</div>
        </div>
        <div style="border:1px solid rgba(245,158,11,.35);border-radius:16px;padding:10px;background:#fff;text-align:center;">
          <div class="muted" style="font-size:11px;">推定損失額合計</div>
          <div style="font-size:22px;font-weight:900;color:#d97706;">${jpy(totalLeakPrice)}円</div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px;">
        <div style="border:1px solid rgba(217,119,6,.25);border-radius:12px;padding:8px 10px;background:#fffbeb;">
          <div class="muted" style="font-size:10px;">UKEコードなし</div>
          <div style="font-weight:900;color:#d97706;">${d.billingNoCodeCount}件 / ${jpy(d.billingNoCodePrice)}円</div>
        </div>
        <div style="border:1px solid rgba(220,38,38,.25);border-radius:12px;padding:8px 10px;background:#FEF2F2;">
          <div class="muted" style="font-size:10px;">NG未判断</div>
          <div style="font-weight:900;color:#DC2626;">${d.billingUndecidedNgCount}件 / ${jpy(d.billingUndecidedNgPrice)}円</div>
        </div>
      </div>

      ${deptEntries.length ? `
      <details style="margin-top:12px;">
        <summary style="font-size:13px;font-weight:900;color:var(--muted);cursor:pointer;user-select:none;">診療科別 請求漏れ内訳</summary>
        <div style="margin-top:8px;">
          <div style="display:grid;grid-template-columns:1fr auto auto auto;gap:6px;padding:4px 0;border-bottom:1px solid rgba(245,158,11,.3);font-size:11px;color:var(--muted);">
            <div>診療科</div><div style="text-align:right;">コードなし</div><div style="text-align:right;">NG未判断</div><div style="text-align:right;">金額</div>
          </div>
          ${deptRows}
        </div>
      </details>` : ""}

      ${nocodeItems.length ? `
      <details style="margin-top:12px;">
        <summary style="font-size:13px;font-weight:900;color:#d97706;cursor:pointer;user-select:none;">UKEコードなし材料の詳細（${nocodeItems.length}件）</summary>
        <div style="margin-top:8px;display:flex;flex-direction:column;gap:8px;">
          ${nocodeItems.map(leakItemHtml).join("")}
        </div>
      </details>` : ""}

      ${undecidedItems.length ? `
      <details style="margin-top:12px;">
        <summary style="font-size:13px;font-weight:900;color:#DC2626;cursor:pointer;user-select:none;">NG未判断材料の詳細（${undecidedItems.length}件）</summary>
        <div style="margin-top:8px;display:flex;flex-direction:column;gap:8px;">
          ${undecidedItems.map(leakItemHtml).join("")}
        </div>
      </details>` : ""}
    </div>`;
    })() : ""}

    <div class="card">
      ${btn("⬅ 戻る","back_dashboard","ghost")}
    </div>
  </div>`;
}

/* ========= painters ========= */
function paintMatList(){
  const matList = $("#matList");
  if (!matList) return;

  const html = (scanCtx?.materials||[]).slice(0,12).map(m=>{
    const qty = Number(m.qty||1);
    const left = `<b>${m.product_name||"(不明)"} ×${qty}</b><div class="muted">${tokuteiDisplay(m.tokutei01_name)}</div>`;
    const right = `
      <span class="tag">${m.dict_status||""}</span>
      <button class="btn small ghost" data-dec="${m.id}" aria-label="数量を減らす">−</button>
      <button class="btn small ghost" data-one="${m.id}" aria-label="1つ削除">🗑</button>
      <button class="btn small ghost" data-all="${m.id}" aria-label="すべて削除">✖</button>
    `;
    return listItem(left, right);
  }).join("") || `<div class="muted">材料なし</div>`;

  matList.innerHTML = html;

  const after = ()=>{
    upsertDraft();
    paintMatList();
    updateSummaryUI();
    updateSuggestionUI();
  };

  matList.querySelectorAll("[data-dec]").forEach(b=> b.onclick=()=>{ decMaterialById(scanCtx.materials, b.getAttribute("data-dec")); after(); });
  matList.querySelectorAll("[data-one]").forEach(b=> b.onclick=()=>{ decMaterialById(scanCtx.materials, b.getAttribute("data-one")); after(); });
  matList.querySelectorAll("[data-all]").forEach(b=> b.onclick=()=>{ removeMaterialRowById(scanCtx.materials, b.getAttribute("data-all")); after(); });
}

function paintConfirmList(){
  const box = $("#confirmList");
  if (!box) return;

  const mats = (scanCtx.materials||[]).map(m=>{
    const qty = Number(m.qty||1);
    const left = `<b>${m.product_name||"(不明)"} ×${qty}</b><div class="muted">${tokuteiDisplay(m.tokutei01_name)}</div>`;
    const right = `
      <button class="btn small ghost" data-cdec="${m.id}" aria-label="数量を減らす">−</button>
      <button class="btn small ghost" data-cone="${m.id}" aria-label="1つ削除">🗑</button>
      <button class="btn small ghost" data-call="${m.id}" aria-label="すべて削除">✖</button>
    `;
    return listItem(left, right);
  }).join("") || `<div class="muted">材料なし</div>`;

  box.innerHTML = mats;

  const after = ()=>{
    upsertDraft();
    paintConfirmList();
    refreshDiffBox();
    updateSummaryUI();
    updateSuggestionUI();
  };

  box.querySelectorAll("[data-cdec]").forEach(b=> b.onclick=()=>{ decMaterialById(scanCtx.materials, b.getAttribute("data-cdec")); after(); });
  box.querySelectorAll("[data-cone]").forEach(b=> b.onclick=()=>{ decMaterialById(scanCtx.materials, b.getAttribute("data-cone")); after(); });
  box.querySelectorAll("[data-call]").forEach(b=> b.onclick=()=>{ removeMaterialRowById(scanCtx.materials, b.getAttribute("data-call")); after(); });
}

function refreshDiffBox(){
  const diffEl = $("#diffBox");
  if (!diffEl) return;

  if (!scanCtx.editDoneId){
    diffEl.innerHTML = `<div class="muted">新規作成</div>`;
    return;
  }
  const base = scanCtx._baseSnapshot || state.done.find(x=>x.id===scanCtx.editDoneId);
  if (!base){
    diffEl.innerHTML = `<div class="muted">差分算出不可（ベースなし）</div>`;
    return;
  }
  const pseudoNew = {
    operatorId: scanCtx.operatorId,
    patientId: scanCtx.patientId,
    procedureId: scanCtx.procedureId,
    assignedDoctorId: scanCtx.assignedDoctorId,
    materials: scanCtx.materials
  };
  const changes = summarizeChangesDetailed(base, pseudoNew);
  diffEl.innerHTML = changes.map(c=>`<div class="listItem"><div><b>${c}</b></div></div>`).join("");
}

/* ========= router ========= */
function setRolePill(){
  const map = {doctor:"医師", field:"実施入力", billing:"医事"};
  $("#rolePill").textContent = `職種：${map[role] || "未選択"}`;
}

function renderWithGuard(){
  try{
    render();
  } catch(e){
    const app = $("#app");
    app.innerHTML = `<div class="card">
      <div class="h1">画面エラー</div>
      <div class="muted">${String(e?.stack || e)}</div>
      <div class="divider"></div>
      ${btn("職種へ戻る","err_to_role","primary")}
    </div>`;
    $("#err_to_role").onclick = ()=>{ role=""; save(); setView("/role"); };
  }
}

function render(){
  setRolePill();
  $("#btnRole").onclick = gotoRole;
  $("#rolePill").onclick = gotoRole;

  const v = view();
  const app = $("#app");

  // 画面に応じてブラウザタブのタイトルを更新
  const titleMap = {
    "/role":"職種選択",
    "/doctor/login":"医師ログイン",
    "/doctor/approvals":"承認一覧",
    "/doctor/docs":"Docs",
    "/field/scan/step/1":"スキャン: 入力者",
    "/field/scan/step/2":"スキャン: 患者",
    "/field/scan/step/3":"スキャン: 手技",
    "/field/scan/step/4":"スキャン: 材料",
    "/field/scan/step/5":"スキャン: 確認",
    "/field/approver":"承認者選択",
    "/field/drafts":"下書き一覧",
    "/field/done":"実施済み一覧",
    "/field/dashboard":"ダッシュボード",
    "/billing/done":"承認済み",
    "/billing/pending":"承認待ち",
    "/billing/uke":"UKE突合",
    "/billing/requirements":"算定要件マスタ",
    "/billing/dashboard":"ダッシュボード",
  };
  const pageTitle = titleMap[v] || (role==="doctor"?"医師ホーム":role==="field"?"実施入力":role==="billing"?"医事ホーム":"LinQ VAL");
  document.title = `${pageTitle} - LinQ VAL`;

  if (!v.startsWith("/field/scan/step/4")) stopScannerIfAny();

if (!role || v === "/role"){
  app.innerHTML = screenRole();
  updateSummaryUI();

  // ✅ 職種ボタンのイベントを付与（v23で抜けていた）
  const toDoctor = $("#role_doctor");
  const toField  = $("#role_field");
  const toBill   = $("#role_billing");

  if (toDoctor) toDoctor.onclick = ()=>{
    role = "doctor";
    save();
    setView("/doctor/login");
    renderWithGuard();
  };
  if (toField) toField.onclick = ()=>{
    role = "field";
    save();
    setView("/");
    renderWithGuard();
  };
  if (toBill) toBill.onclick = ()=>{
    role = "billing";
    save();
    setView("/");
    renderWithGuard();
  };

  const demoBtn = $("#load_demo");
  if (demoBtn) demoBtn.onclick = ()=>{
    const items = generateDemoData();
    state.done = state.done.concat(items);
    save();
    toastShow({title:"デモデータ投入", sub:`${items.length}件の実施記録を追加`});
    renderWithGuard();
  };

  const resetBtn = $("#reset_data");
  if (resetBtn) resetBtn.onclick = ()=>{
    if (!confirm("全データをリセットしますか？")) return;
    state = defaultState();
    save();
    toastShow({title:"リセット完了", sub:"全データを削除しました"});
    renderWithGuard();
  };

  return;
}



  /* ---- doctor ---- */
  if (role==="doctor"){
    const deptOk = (doctorProfile.dept||"").trim().length>0;
    const idOk   = (doctorProfile.doctorId||"").trim().length>0;

    if ((!deptOk || !idOk) && v !== "/doctor/login"){
      setView("/doctor/login");
      return renderWithGuard();
    }

    if (v === "/doctor/login"){
      app.innerHTML = screenDoctorLogin();
      updateSummaryUI();

      const deptSel = $("#doc_dept_sel");
      const docSel = $("#doc_id_sel");

      deptSel.onchange = ()=>{
        doctorProfile.dept = deptSel.value || "";
        doctorProfile.doctorId = "";
        save();
        const list = DOCTORS
          .filter(d=> !doctorProfile.dept || d.dept===doctorProfile.dept)
          .slice()
          .sort((a,b)=>(a.name||"").localeCompare(b.name||"","ja"));
        docSel.innerHTML = [`<option value="">選択</option>`]
          .concat(list.map(d=>`<option value="${d.id}">${d.name}（${d.id}）</option>`))
          .join("");
      };

      $("#doc_login_go").onclick=()=>{
        const dept = deptSel.value || "";
        const did = docSel.value || "";
        if (!dept){ toastShow({title:"未選択", sub:"診療科"}); return; }
        if (!did){ toastShow({title:"未選択", sub:"医師"}); return; }
        doctorProfile.dept = dept;
        doctorProfile.doctorId = did;
        save();
        setView("/");
        renderWithGuard();
      };

      $("#doc_login_clear").onclick=()=>{
        doctorProfile = {dept:"", doctorId:""};
        save();
        renderWithGuard();
      };
      return;
    }

    if (v === "/" || v === ""){
      app.innerHTML = screenDoctorHome();
      updateSummaryUI();
      $("#doc_logout").onclick=()=>{
        doctorProfile = {dept:"", doctorId:""};
        save();
        setView("/doctor/login");
        renderWithGuard();
      };
      $("#go_doc_approve").onclick=()=>{ setView("/doctor/approvals"); renderWithGuard(); };
      $("#go_doc_docs").onclick=()=>{ setView("/doctor/docs"); renderWithGuard(); };
      return;
    }

    if (v === "/doctor/approvals"){
      app.innerHTML = screenDoctorApprovals();
      updateSummaryUI();
      $("#back_doc_home").onclick=()=>{ setView("/"); renderWithGuard(); };

      $("#bulk_approve").onclick=()=>{
        const bulkText = $("#bulk_comment").value || "";
        const checked = Array.from(document.querySelectorAll("[data-chk]"))
          .filter(x=>x.checked)
          .map(x=>x.getAttribute("data-chk"));
        if (!checked.length){ toastShow({title:"選択なし", sub:"チェックしてください"}); return; }

        const hasIssue = checked.some(id => {
          const it = state.done.find(x=>x.id===id);
          return (it?.materials||[]).some(m =>
            ["ng","warn","confirm"].includes(runBillingChecks(m, it.materials).overall)
          );
        });
        if (hasIssue && !confirm("算定要件の確認が必要な材料が含まれています。\n個別確認せずに承認しますか？")) return;

        checked.forEach(id=>{
          const it = state.done.find(x=>x.id===id);
          if (!it) return;
          it.status="approved";
          it.approved_at = iso();
          it.approved_by = doctorProfile.doctorId;
          if (bulkText.trim()){
            it.doctor_comment = it.doctor_comment ? `${it.doctor_comment}\n---\n${bulkText}` : bulkText;
          }
          pushHistory(it, { at: iso(), actor:`${doctorProfile.dept} ${doctorProfile.doctorId}`, type:"承認", changes:[`承認: ${fmtDT(it.approved_at)}`] });
        });
        save();
        toastShow({title:"一括承認", sub:`${checked.length}件`});
        renderWithGuard();
      };

      document.querySelectorAll("[data-open-approve]").forEach(b=>{
        b.onclick=()=>{
          const id = b.getAttribute("data-open-approve");
          const item = state.done.find(x=>x.id===id);
          if (!item) return;
          const box = $("#approveDetail");
          box.innerHTML = renderApprovalDetail(item);
          box.style.display="block";
          $("#doctor_comment").value = item.doctor_comment || "";
          $("#close_detail").onclick=()=>{ box.style.display="none"; };

          $("#approve_with_comment").onclick=()=>{
            item.status="approved";
            item.approved_at = iso();
            item.approved_by = doctorProfile.doctorId;
            item.doctor_comment = $("#doctor_comment").value || "";
            (item.materials||[]).forEach((m, idx) => {
              // 新フォーマット: チェックごとの判断を保存
              const chkSels = document.querySelectorAll(`[data-billing-chk^="${idx}-"]`);
              if (chkSels.length > 0) {
                m.billing_checks = [];
                chkSels.forEach(sel => {
                  const parts = sel.dataset.billingChk.split("-");
                  const chkIdx = Number(parts[1]);
                  const noteEl = document.querySelector(`[data-billing-chk-note="${idx}-${chkIdx}"]`);
                  m.billing_checks[chkIdx] = {
                    decision: sel.value || null,
                    note: noteEl?.value || ""
                  };
                });
                // 後方互換: 最初のチェックの判断をbilling_decisionにも反映
                const first = m.billing_checks.find(c => c && c.decision);
                m.billing_decision = first?.decision || null;
                m.billing_note = first?.note || "";
              }
            });
            pushHistory(item, { at: iso(), actor:`${doctorProfile.dept} ${doctorProfile.doctorId}`, type:"承認", changes:[`承認: ${fmtDT(item.approved_at)}`, "コメント更新"] });
            save();
            toastShow({title:"承認", sub:"保存"});
            box.style.display="none";
            renderWithGuard();
          };
        };
      });
      return;
    }

    if (v === "/doctor/docs"){
      app.innerHTML = screenDoctorDocs();
      updateSummaryUI();
      $("#back_doc_home2").onclick=()=>{ setView("/"); renderWithGuard(); };

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
          <textarea id="doc_text"></textarea>
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
  }

  /* ---- field ---- */
  if (role==="field"){
    updateSummaryUI();

    if (v === "/" || v === ""){
      app.innerHTML = screenFieldHome();
      updateSummaryUI();

      $("#go_field_scan").onclick=()=>{
        scanCtx=null;
        candidate={code:"",ts:0,count:0};
        lastScan={anyTs:0,raw:"",sameTs:0};
        setView("/field/scan/step/1");
        renderWithGuard();
      };
      $("#go_field_drafts").onclick=()=>{ setView("/field/drafts"); renderWithGuard(); };
      $("#go_field_done").onclick=()=>{ setView("/field/done"); renderWithGuard(); };
      $("#go_field_dashboard").onclick=()=>{ setView("/field/dashboard"); renderWithGuard(); };
      return;
    }

    if (v === "/field/dashboard"){
      app.innerHTML = screenDashboard();
      updateSummaryUI();
      $("#back_dashboard").onclick=()=>{ setView("/"); renderWithGuard(); };
      return;
    }

    if (v === "/field/drafts"){
      app.innerHTML = screenDrafts();
      updateSummaryUI();
      $("#back_field_home").onclick=()=>{ setView("/"); renderWithGuard(); };

      document.querySelectorAll("[data-resume]").forEach(b=>{
        b.onclick=()=>{
          const id = b.getAttribute("data-resume");
          const d = state.drafts.find(x=>x.id===id);
          if (!d) return;
          scanCtx = {
            draftId:d.id,
            step:d.step||1,
            operatorId:d.operatorId||"",
            patientId:d.patientId||"",
            procedureId:d.procedureId||"",
            place:d.place||"未設定",
            materials: deepClone(d.materials||[]),
            createdAt:d.createdAt||iso(),
            updatedAt:d.updatedAt||iso(),
            editDoneId: d.editDoneId || null,
            assignedDoctorId: d.assignedDoctorId || "",
            approverDept: d.approverDept || "ALL",
            _baseSnapshot: null
          };
          updateSummaryUI();
          setView(`/field/scan/step/${scanCtx.step}`);
          renderWithGuard();
        };
      });
      return;
    }

    if (v === "/field/done"){
      app.innerHTML = screenDone();
      updateSummaryUI();
      $("#back_field_home2").onclick=()=>{ setView("/"); renderWithGuard(); };

      const todayItems = state.done.filter(x=>x.date===todayStr());
      $("#field_csv").onclick=()=> exportDoneCSV(todayItems, `linqval_done_${todayStr()}.csv`);

      document.querySelectorAll("[data-open-done]").forEach(el=>{
        el.onclick=()=>{
          const id = el.getAttribute("data-open-done");
          const item = state.done.find(x=>x.id===id);
          if (!item) return;
          const box = $("#doneDetail");
          box.innerHTML = renderDoneDetail(item);
          box.style.display="block";

          $("#close_done_detail").onclick=()=>{ box.style.display="none"; };

          const editBtn = $("#done_edit");
          if (editBtn){
            editBtn.onclick=()=>{
              if (item.status !== "pending"){ toastShow({title:"修正不可", sub:"承認済み"}); return; }
              scanCtx = {
                draftId: uid("DRAFT"),
                step: 5,
                operatorId: item.operatorId || "",
                patientId: item.patientId || "",
                procedureId: item.procedureId || "",
                place: item.place || "未設定",
                materials: deepClone(item.materials || []),
                createdAt: iso(),
                updatedAt: iso(),
                editDoneId: item.id,
                assignedDoctorId: item.assignedDoctorId || "",
                approverDept: (DOCTORS.find(d=>d.id===item.assignedDoctorId)?.dept) || "ALL",
                _baseSnapshot: deepClone(item)
              };
              upsertDraft();
              updateSummaryUI();
              box.style.display="none";
              setView("/field/scan/step/5");
              renderWithGuard();
            };
          }

          const delBtn = $("#done_delete");
          if (delBtn){
            delBtn.onclick=()=>{
              if (item.status !== "pending"){ toastShow({title:"削除不可", sub:"承認済み"}); return; }
              if (!confirm("この実施記録を削除しますか？この操作は元に戻せません。")) return;
              pushHistory(item, { at: iso(), actor: operatorLabel(item.operatorId), type:"削除", changes:["データ削除"] });
              state.done = state.done.filter(x=>x.id!==item.id);
              save();
              toastShow({title:"削除", sub:"承認待ちを削除"});
              box.style.display="none";
              renderWithGuard();
            };
          }
        };
      });
      return;
    }

    if (v.startsWith("/field/scan/step/")){
      const step = Number(v.split("/").pop());
      app.innerHTML = screenFieldStep(step);
      updateSummaryUI();
      updateSuggestionUI();

      const saveDraftExit = ()=>{
        upsertDraft();
        stopScannerIfAny();
        toastShow({title:"下書き", sub:"保存"});
        scanCtx=null;
        updateSummaryUI();
        setView("/field/drafts");
        renderWithGuard();
      };
      const cancel = ()=>{
        stopScannerIfAny();
        scanCtx=null;
        updateSummaryUI();
        setView("/");
        renderWithGuard();
      };
      $("#save_draft_any") && ($("#save_draft_any").onclick=saveDraftExit);
      $("#save_draft_any2") && ($("#save_draft_any2").onclick=saveDraftExit);
      $("#cancel_flow") && ($("#cancel_flow").onclick=cancel);

      if (step===1){
        $("#to_step2").onclick=()=>{
          ensureScanCtx();
          scanCtx.operatorId=$("#op_select").value||"";
          upsertDraft();
          updateSummaryUI();
          setView("/field/scan/step/2");
          renderWithGuard();
        };
        return;
      }
      if (step===2){
        $("#to_step3").onclick=()=>{
          ensureScanCtx();
          scanCtx.patientId=$("#pt_select").value||"";
          upsertDraft();
          updateSummaryUI();
          setView("/field/scan/step/3");
          renderWithGuard();
        };
        return;
      }
      if (step===3){
        updateSuggestionUI();
        $("#to_step4").onclick=()=>{
          ensureScanCtx();
          scanCtx.procedureId=$("#proc_select").value||"";
          upsertDraft();
          updateSummaryUI();
          setView("/field/scan/step/4");
          renderWithGuard();
        };
        // 手で選んでもサマリー更新
        $("#proc_select").onchange=()=>{
          scanCtx.procedureId = $("#proc_select").value || "";
          upsertDraft();
          updateSummaryUI();
          updateSuggestionUI();
        };
        return;
      }
      if (step===4){
        ensureScanCtx();
        paintMatList();
        updateSummaryUI();
        updateSuggestionUI();

        const startBtn=$("#scan_start"), stopBtn=$("#scan_stop"), target=$("#scannerTarget");
        const setBtns=(run)=>{ startBtn.disabled=!!run; stopBtn.disabled=!run; };

        if (!scannerInst){
          scannerInst = new Scanner({
            targetEl: target,
            onDetected: (raw)=>{ handleDetected(raw); },
            onError: (e)=>toastShow({title:"Start失敗", sub:e.message})
          });
        } else scannerInst.targetEl = target;

        setBtns(scannerInst.isRunning?.()||false);
        startBtn.onclick=async()=>{ await scannerInst.start(); setBtns(true); };
        stopBtn.onclick=()=>{ scannerInst.stop(); setBtns(false); };

        $("#to_confirm").onclick=()=>{
          stopScannerIfAny();
          upsertDraft();
          updateSummaryUI();
          setView("/field/scan/step/5");
          renderWithGuard();
        };
        return;
      }

      // step 5 confirm
      ensureScanCtx();
      paintConfirmList();
      refreshDiffBox();
      updateSummaryUI();
      updateSuggestionUI();

      $("#op_select2").onchange=()=>{ scanCtx.operatorId=$("#op_select2").value||""; upsertDraft(); refreshDiffBox(); updateSummaryUI(); updateSuggestionUI(); };
      $("#pt_select2").onchange=()=>{ scanCtx.patientId=$("#pt_select2").value||""; upsertDraft(); refreshDiffBox(); updateSummaryUI(); updateSuggestionUI(); };
      $("#proc_select2").onchange=()=>{ scanCtx.procedureId=$("#proc_select2").value||""; upsertDraft(); refreshDiffBox(); updateSummaryUI(); updateSuggestionUI(); };

      $("#go_add_material").onclick=()=>{ upsertDraft(); setView("/field/scan/step/4"); renderWithGuard(); };
      $("#back_step4").onclick=()=>{ setView("/field/scan/step/4"); renderWithGuard(); };
      $("#to_approver_select").onclick=()=>{
        if (!scanCtx.operatorId){ toastShow({title:"未選択", sub:"入力者"}); return; }
        if (!scanCtx.patientId){ toastShow({title:"未選択", sub:"患者"}); return; }
        if (!scanCtx.procedureId){ toastShow({title:"未選択", sub:"手技"}); return; }
        if (!scanCtx.materials?.length){ toastShow({title:"材料なし", sub:"スキャンしてください"}); return; }
        upsertDraft();
        setView("/field/approver");
        renderWithGuard();
      };
      return;
    }

    if (v === "/field/approver"){
      app.innerHTML = screenApproverSelect();
      updateSummaryUI();
      updateSuggestionUI();

      $("#approver_dept").onchange=()=>{
        scanCtx.approverDept = $("#approver_dept").value || "ALL";
        upsertDraft();
        renderWithGuard();
      };

      document.querySelectorAll("[data-quick-approver]").forEach(b=>{
        b.onclick=()=>{
          scanCtx.assignedDoctorId = b.getAttribute("data-quick-approver");
          upsertDraft();
          try { $("#approver_select").value = scanCtx.assignedDoctorId; } catch {}
        };
      });
      $("#approver_select").onchange=()=>{ scanCtx.assignedDoctorId = $("#approver_select").value || ""; upsertDraft(); };

      $("#back_to_confirm").onclick=()=>{ setView("/field/scan/step/5"); renderWithGuard(); };

      $("#request_approval").onclick=()=>{
        const did = (scanCtx.assignedDoctorId||"").trim();
        if (!did){ toastShow({title:"未選択", sub:"承認者"}); return; }
        touchRecentApprover(did);

        if (scanCtx.editDoneId){
          const it = state.done.find(x=>x.id===scanCtx.editDoneId);
          if (!it){ toastShow({title:"エラー", sub:"対象なし"}); return; }
          if (it.status !== "pending"){ toastShow({title:"修正不可", sub:"承認済み"}); return; }

          const before = scanCtx._baseSnapshot ? deepClone(scanCtx._baseSnapshot) : deepClone(it);

          it.operatorId = scanCtx.operatorId;
          it.patientId  = scanCtx.patientId;
          it.procedureId= scanCtx.procedureId;
          it.materials  = deepClone(scanCtx.materials||[]);
          it.assignedDoctorId = did;
          it.updatedAt = iso();
          it.revisedAt = iso();

          pushHistory(it, { at: iso(), actor: operatorLabel(scanCtx.operatorId), type:"修正", changes: summarizeChangesDetailed(before, it) });
          save();
          toastShow({title:"更新", sub:"承認待ち"});
        } else {
          const it = {
            id: uid("DONE"),
            date: todayStr(),
            operatorId: scanCtx.operatorId,
            patientId: scanCtx.patientId,
            procedureId: scanCtx.procedureId,
            place: scanCtx.place || "未設定",
            materials: deepClone(scanCtx.materials||[]),
            status: "pending",
            confirmedAt: iso(),
            approved_at: "",
            approved_by: "",
            doctor_comment: "",
            assignedDoctorId: did,
            history: []
          };
          pushHistory(it, { at: iso(), actor: operatorLabel(scanCtx.operatorId), type:"作成", changes:[`承認依頼: ${doctorLabelById(did)}`] });
          state.done.unshift(it);
          save();
          toastShow({title:"承認依頼", sub:"承認待ちへ"});
        }

        state.drafts = state.drafts.filter(d=>d.id!==scanCtx.draftId);
        save();

        scanCtx=null;
        updateSummaryUI();
        setView("/field/done");
        renderWithGuard();
      };
      return;
    }
  }

  /* ---- billing ---- */
  if (role==="billing"){
    updateSummaryUI();
    if (v === "/" || v === ""){
      app.innerHTML = screenBillingHome();
      $("#go_bill_done").onclick=()=>{ setView("/billing/done"); renderWithGuard(); };
      $("#go_bill_pending").onclick=()=>{ setView("/billing/pending"); renderWithGuard(); };
      $("#go_bill_uke").onclick=()=>{ setView("/billing/uke"); renderWithGuard(); };
      $("#go_bill_dashboard").onclick=()=>{ setView("/billing/dashboard"); renderWithGuard(); };
      $("#go_bill_req").onclick=()=>{ setView("/billing/requirements"); renderWithGuard(); };
      return;
    }

    /* ---- 算定要件マスタメンテナンスUI ---- */
    if (v === "/billing/requirements/new"){
      const emptyData = { sectionId:"", rule:"", requiresNote:false, checks:[] };
      let editData = deepClone(emptyData);
      app.innerHTML = screenBillingReqEdit("", editData, true);
      const bindCheckEvents = ()=>{
        document.querySelectorAll(".chk-remove").forEach(el=>{
          el.onclick=()=>{
            editData.checks.splice(Number(el.dataset.idx),1);
            $("#checksContainer").innerHTML = editData.checks.map((c,i)=>renderCheckEditorCard(c,i)).join("");
            bindCheckEvents();
          };
        });
      };
      bindCheckEvents();
      $("#addCheckBtn").onclick=()=>{
        const t = $("#addCheckType").value;
        const newChk = { type:t };
        if (t==="maxQty") Object.assign(newChk, {limit:1, unit:"", overrideWithNote:false, description:""});
        if (t==="simultaneousNg") Object.assign(newChk, {targets:[], message:"", overrideWithNote:false});
        if (t==="includedIn") Object.assign(newChk, {parent:"", components:[], message:""});
        if (t==="condition") Object.assign(newChk, {description:"", requiresConfirm:true});
        editData.checks.push(newChk);
        $("#checksContainer").innerHTML = editData.checks.map((c,i)=>renderCheckEditorCard(c,i)).join("");
        bindCheckEvents();
      };
      $("#reqEditSave").onclick=()=>{
        const matName = $("#reqEditName").value.trim();
        if(!matName){ toastShow({title:"エラー",sub:"材料名を入力してください"}); return; }
        document.querySelectorAll(".chk-field").forEach(el=>{
          const idx = Number(el.dataset.idx);
          const field = el.dataset.field;
          if(idx>=0 && idx<editData.checks.length && field){
            if(el.type==="checkbox") editData.checks[idx][field]=el.checked;
            else if(el.type==="number") editData.checks[idx][field]=Number(el.value);
            else if(field==="targets"||field==="components") editData.checks[idx][field]=el.value.split(",").map(s=>s.trim()).filter(Boolean);
            else editData.checks[idx][field]=el.value;
          }
        });
        editData.sectionId = $("#reqEditSection").value.trim();
        editData.rule = $("#reqEditRule").value;
        editData.requiresNote = $("#reqEditRequiresNote").checked;
        billingReqOverrides.additions[matName] = editData;
        billingReqOverrides.deletions = (billingReqOverrides.deletions||[]).filter(k=>k!==matName);
        save();
        toastShow({title:"保存しました",sub:matName});
        setView("/billing/requirements"); renderWithGuard();
      };
      $("#reqEditCancel").onclick=()=>{ setView("/billing/requirements"); renderWithGuard(); };
      return;
    }

    if (v.startsWith("/billing/requirements/edit/")){
      const matName = decodeURIComponent(v.replace("/billing/requirements/edit/",""));
      const merged = getMergedBillingReq();
      const srcData = merged[matName] || { sectionId:"", rule:"", requiresNote:false, checks:[] };
      let editData = deepClone(srcData);
      app.innerHTML = screenBillingReqEdit(matName, editData, false);
      const bindCheckEvents = ()=>{
        document.querySelectorAll(".chk-remove").forEach(el=>{
          el.onclick=()=>{
            editData.checks.splice(Number(el.dataset.idx),1);
            $("#checksContainer").innerHTML = editData.checks.map((c,i)=>renderCheckEditorCard(c,i)).join("");
            bindCheckEvents();
          };
        });
      };
      bindCheckEvents();
      $("#addCheckBtn").onclick=()=>{
        const t = $("#addCheckType").value;
        const newChk = { type:t };
        if (t==="maxQty") Object.assign(newChk, {limit:1, unit:"", overrideWithNote:false, description:""});
        if (t==="simultaneousNg") Object.assign(newChk, {targets:[], message:"", overrideWithNote:false});
        if (t==="includedIn") Object.assign(newChk, {parent:"", components:[], message:""});
        if (t==="condition") Object.assign(newChk, {description:"", requiresConfirm:true});
        editData.checks.push(newChk);
        $("#checksContainer").innerHTML = editData.checks.map((c,i)=>renderCheckEditorCard(c,i)).join("");
        bindCheckEvents();
      };
      $("#reqEditSave").onclick=()=>{
        document.querySelectorAll(".chk-field").forEach(el=>{
          const idx = Number(el.dataset.idx);
          const field = el.dataset.field;
          if(idx>=0 && idx<editData.checks.length && field){
            if(el.type==="checkbox") editData.checks[idx][field]=el.checked;
            else if(el.type==="number") editData.checks[idx][field]=Number(el.value);
            else if(field==="targets"||field==="components") editData.checks[idx][field]=el.value.split(",").map(s=>s.trim()).filter(Boolean);
            else editData.checks[idx][field]=el.value;
          }
        });
        editData.sectionId = $("#reqEditSection").value.trim();
        editData.rule = $("#reqEditRule").value;
        editData.requiresNote = $("#reqEditRequiresNote").checked;
        billingReqOverrides.additions[matName] = editData;
        billingReqOverrides.deletions = (billingReqOverrides.deletions||[]).filter(k=>k!==matName);
        save();
        toastShow({title:"保存しました",sub:matName});
        setView("/billing/requirements"); renderWithGuard();
      };
      $("#reqEditCancel").onclick=()=>{ setView("/billing/requirements"); renderWithGuard(); };
      return;
    }

    if (v === "/billing/requirements"){
      app.innerHTML = screenBillingReqList();
      const searchInput = $("#reqSearchInput");
      const container = $("#reqListContainer");
      const filterList = ()=>{
        const q = (searchInput.value||"").trim().toLowerCase();
        container.querySelectorAll(".listItem").forEach(el=>{
          const name = (el.querySelector("b")?.textContent||"").toLowerCase();
          el.style.display = (!q || name.includes(q)) ? "" : "none";
        });
      };
      searchInput.oninput = filterList;
      document.querySelectorAll(".bill-req-edit").forEach(el=>{
        el.onclick=()=>{ setView("/billing/requirements/edit/"+encodeURIComponent(el.dataset.name)); renderWithGuard(); };
      });
      document.querySelectorAll(".bill-req-del").forEach(el=>{
        el.onclick=()=>{
          if(!confirm(`「${el.dataset.name}」を削除しますか？`)) return;
          const name = el.dataset.name;
          billingReqOverrides.deletions = billingReqOverrides.deletions || [];
          if(!billingReqOverrides.deletions.includes(name)) billingReqOverrides.deletions.push(name);
          delete (billingReqOverrides.additions||{})[name];
          save();
          toastShow({title:"削除しました",sub:name});
          setView("/billing/requirements"); renderWithGuard();
        };
      });
      $("#go_bill_req_new").onclick=()=>{ setView("/billing/requirements/new"); renderWithGuard(); };
      $("#go_bill_req_reset").onclick=()=>{
        if(!confirm("カスタム変更をすべて初期状態に戻しますか？")) return;
        billingReqOverrides = { additions:{}, deletions:[] };
        save();
        toastShow({title:"初期状態に戻しました"});
        setView("/billing/requirements"); renderWithGuard();
      };
      $("#back_bill_req_home").onclick=()=>{ setView("/"); renderWithGuard(); };
      return;
    }

    if (v === "/billing/uke"){
      app.innerHTML = screenUkeReconciliation();

      let currentPeriod = "30D";
      let currentDept = "ALL";
      let customFrom = "";
      let customTo = "";

      const periodSel = $("#uke_period");
      const deptSel = $("#uke_dept");
      const fromInput = $("#uke_from");
      const toInput = $("#uke_to");

      /* 共通の再描画関数 */
      const origRender = renderUkeResults;
      const refresh = ()=>{
        if (currentPeriod === "CUSTOM"){
          const fTs = customFrom ? new Date(customFrom + "T00:00:00").getTime() : 0;
          const tTs = customTo ? new Date(customTo + "T23:59:59").getTime() : Infinity;
          const backup = state.done;
          state.done = backup.filter(x=>{
            const t = x.confirmedAt ? new Date(x.confirmedAt).getTime() : 0;
            return t >= fTs && t <= tTs;
          });
          origRender("ALL", currentDept);
          state.done = backup;
        } else {
          origRender(currentPeriod, currentDept);
        }
        /* 診療科カードのクリックイベントをバインド */
        bindDeptCards();
      };

      const bindDeptCards = ()=>{
        document.querySelectorAll("[data-dept-card]").forEach(el=>{
          el.onclick = ()=>{
            const dept = el.getAttribute("data-dept-card");
            if (currentDept === dept){
              /* 同じ診療科を再タップ → 全診療科に戻す */
              currentDept = "ALL";
              deptSel.value = "ALL";
            } else {
              currentDept = dept;
              deptSel.value = dept;
              /* プルダウンに無い場合もあるので念のため */
              if (deptSel.value !== dept) deptSel.value = "ALL";
            }
            refresh();
          };
        });
      };

      /* プリセット期間 */
      periodSel.onchange = ()=>{
        currentPeriod = periodSel.value;
        customFrom = "";
        customTo = "";
        fromInput.value = "";
        toInput.value = "";
        refresh();
      };

      /* 診療科プルダウン */
      deptSel.onchange = ()=>{
        currentDept = deptSel.value;
        refresh();
      };

      /* カスタム期間 */
      $("#uke_custom_apply").onclick = ()=>{
        customFrom = fromInput.value || "";
        customTo = toInput.value || "";
        if (!customFrom && !customTo){
          toastShow({title:"期間未指定", sub:"開始日または終了日を入力してください"});
          return;
        }
        periodSel.value = "ALL";
        currentPeriod = "CUSTOM";
        refresh();
        toastShow({title:"カスタム期間", sub:`${customFrom || "—"} 〜 ${customTo || "—"}`});
      };

      /* 初回描画 */
      refresh();

      $("#back_uke").onclick=()=>{ setView("/"); renderWithGuard(); };
      $("#uke_csv").onclick=()=>{
        const { rows } = buildUkeData(currentPeriod === "CUSTOM" ? "ALL" : currentPeriod);
        let filtered = (currentDept && currentDept !== "ALL") ? rows.filter(r=>r.dept===currentDept) : rows;
        if (currentPeriod === "CUSTOM"){
          const fTs = customFrom ? new Date(customFrom + "T00:00:00").getTime() : 0;
          const tTs = customTo ? new Date(customTo + "T23:59:59").getTime() : Infinity;
          filtered = filtered.filter(r=>{
            const t = r.confirmedAt ? new Date(r.confirmedAt).getTime() : 0;
            return t >= fTs && t <= tTs;
          });
        }
        const headers = ["dept","patient","procedure","operator","confirmedAt","materialName","tokutei","jan13","billingCode","price","qty","lineTotal","hasBillingCode","itemStatus","billingReqStatus","billingReqRule","billingDecision","billingChecks","billingNote"];
        const lines = filtered.map(r=> headers.map(h=> escapeCSV(r[h])).join(","));
        const csv = "\uFEFF" + headers.join(",") + "\n" + lines.join("\n");
        const blob = new Blob([csv], {type:"text/csv;charset=utf-8"});
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `linqval_uke_${todayStr()}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
        toastShow({title:"CSV出力", sub:`UKE突合 ${filtered.length}件`});
      };
      return;
    }

    if (v === "/billing/dashboard"){
      app.innerHTML = screenDashboard();
      $("#back_dashboard").onclick=()=>{ setView("/"); renderWithGuard(); };
      return;
    }

    if (v === "/billing/done" || v === "/billing/pending"){
      const kind = v.endsWith("pending") ? "pending" : "done";
      app.innerHTML = screenBillingList(kind);

      $("#back_billing_home").onclick=()=>{ setView("/"); renderWithGuard(); };

      $("#bill_csv").onclick=()=>{
        const items = state.done.filter(x=> kind==="pending" ? x.status==="pending" : x.status==="approved");
        exportDoneCSV(items, `linqval_billing_${kind}_${todayStr()}.csv`);
      };

      const approverSel = $("#bill_filter_approver");
      const approvedSel = $("#bill_filter_approvedat");
      approverSel.value = "ALL";
      approvedSel.value = (kind==="pending") ? "ALL" : "TODAY";

      const applyFilters = ()=>{
        const approver = approverSel.value;
        const approvedWindow = approvedSel.value;

        const now = Date.now();
        const inWindow = (ts)=>{
          if (!ts) return false;
          const t = new Date(ts).getTime();
          if (approvedWindow==="ALL") return true;
          if (approvedWindow==="TODAY"){
            const d = new Date();
            const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
            return t >= start;
          }
          if (approvedWindow==="7D"){
            return (now - t) <= 7*24*60*60*1000;
          }
          return true;
        };

        let items = state.done.slice();
        items = items.filter(x=> kind==="pending" ? x.status==="pending" : x.status==="approved");

        if (approver !== "ALL"){
          if (approver === "NONE") items = items.filter(x=>!x.approved_by);
          else items = items.filter(x=>x.approved_by === approver);
        }
        if (approvedWindow !== "ALL"){
          items = items.filter(x=> x.approved_at && inWindow(x.approved_at));
        }

        const box = $("#billList");
        if (!items.length){
          box.innerHTML = `<div class="muted">該当なし</div>`;
          return;
        }

        box.innerHTML = items.map(x=>{
          const qtySum = (x.materials||[]).reduce((p,m)=>p+Number(m.qty||1),0);
          const c  = x.doctor_comment ? "💬" : "";
          const row = `
            <div>
              <b>${patientLabel(x.patientId)} ${c}</b>
              <div class="muted">${procedureLabel(x.procedureId)} / ${operatorLabel(x.operatorId)}</div>
              <div class="muted" style="font-size:13px;">承認者: ${doctorLabelById(x.approved_by||"")} / ${x.approved_at?fmtDT(x.approved_at):"—"}</div>
            </div>
            <span class="tag">${qtySum}点</span>
          `;

          if (kind==="pending"){
            return `<div class="listItem">
              <div style="display:flex;gap:12px;align-items:center;">
                <input class="check" type="checkbox" data-bchk="${x.id}" aria-label="承認待ちレコードを選択">
                <div style="flex:1;min-width:0;" data-openbill="${x.id}">${row}</div>
              </div>
            </div>`;
          }
          return `<div class="listItem" data-openbill="${x.id}">${row}</div>`;
        }).join("");

        box.querySelectorAll("[data-openbill]").forEach(el=>{
          el.onclick=()=>{
            const id = el.getAttribute("data-openbill");
            const item = state.done.find(x=>x.id===id);
            if(!item) return;
            const detail=$("#billDetail");
            detail.innerHTML = renderBillingDetail(item);
            detail.style.display="block";
            $("#close_bill_detail").onclick=()=>{ detail.style.display="none"; };
          };
        });
      };

      approverSel.onchange = applyFilters;
      approvedSel.onchange = applyFilters;
      applyFilters();

      if (kind==="pending"){
        $("#bill_bulk_approve").onclick=()=>{
          const approver = $("#bill_bulk_approver").value || "BILLING";
          const checked = Array.from(document.querySelectorAll("[data-bchk]"))
            .filter(x=>x.checked)
            .map(x=>x.getAttribute("data-bchk"));
          if (!checked.length){ toastShow({title:"選択なし", sub:"チェックしてください"}); return; }

          checked.forEach(id=>{
            const it = state.done.find(x=>x.id===id);
            if (!it) return;
            if (it.status !== "pending") return;
            it.status="approved";
            it.approved_at = iso();
            it.approved_by = approver;
            pushHistory(it, { at: iso(), actor:"医事課", type:"医事一括承認", changes:[`承認者: ${doctorLabelById(approver)}`, `承認: ${fmtDT(it.approved_at)}`] });
          });
          save();
          toastShow({title:"一括承認", sub:`${checked.length}件`});
          applyFilters();
        };
      }
      return;
    }
  }

  setView("/role");
  renderWithGuard();
}

/* ========= boot ========= */
(async function(){
  await bootData();
  window.addEventListener("hashchange", renderWithGuard);
  if (!location.hash) location.hash="#/role";
  renderWithGuard();
})();
