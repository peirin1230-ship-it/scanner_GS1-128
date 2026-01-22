import { Scanner, parseGS1ForGTIN14, normalizeJan13 } from "./scan.js";

/* ========= settings ========= */
const LS = {
  role: "linqval_role_v3",
  state: "linqval_state_v22",
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
function save(){
  localStorage.setItem(LS.role, role);
  localStorage.setItem(LS.state, JSON.stringify(state));
  localStorage.setItem(LS.doctor, JSON.stringify(doctorProfile));
  localStorage.setItem(LS.recentApprovers, JSON.stringify(recentApprovers));
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
function materialLabel(m){
  const n = m?.product_name || "(不明)";
  const t = m?.tokutei01_name || "";
  return t ? `${n} / ${t}` : n;
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
      doctor_comment: it.doctor_comment || "",
    };
    const mats = Array.isArray(it.materials) ? it.materials : [];
    if (!mats.length){
      rows.push({...base, qty:"", mat_product_name:"", mat_tokutei01_name:"", mat_total_reimbursement_price_yen:"", mat_jan13:"", mat_gtin14:"", mat_raw:"", mat_dict_status:"", billingmap_code:""});
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
          mat_raw: m.raw || "",
          mat_dict_status: m.dict_status || "",
          billingmap_code: billingMapCode(m),
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
    "mat_jan13","mat_gtin14","mat_raw","mat_dict_status","billingmap_code"
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

  // field以外は非表示
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
    <div style="border:1px solid #f2d2dd;border-radius:16px;padding:10px;background:#fff;margin:10px 0;">
      <div class="h2">医師コメント</div>
      <div class="muted">${item.doctor_comment}</div>
    </div>` : "";

  const mats = (item.materials||[]).map(m=>{
    const qty = m.qty || 1;
    return listItem(`<b>${m.product_name||"(不明)"} ×${qty}</b><div class="muted">${m.tokutei01_name||""}</div>`);
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

  // confirm (step 5)
  return `<div class="grid"><div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
      <div>
        <div class="h1">確定</div>
        <div class="muted">承認依頼前に確認</div>
      </div>
      ${scanCtx.editDoneId ? `<span class="tag">修正</span>` : ``}
    </div>
    <div class="divider"></div>

    <div class="h2">入力者</div>
    <select class="select" id="op_select2">
      <option value="">未選択</option>
      ${OPERATORS.map(o=>`<option value="${o.id}" ${scanCtx.operatorId===o.id?"selected":""}>${o.label}</option>`).join("")}
    </select>

    <div class="divider"></div>
    <div class="h2">患者</div>
    <select class="select" id="pt_select2">
      <option value="">未選択</option>
      ${PATIENTS.map(p=>`<option value="${p.id}" ${scanCtx.patientId===p.id?"selected":""}>${p.label}</option>`).join("")}
    </select>

    <div class="divider"></div>
    <div class="h2">手技</div>
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

    <div class="h2">診療科</div>
    <select class="select" id="approver_dept">${deptOptions}</select>

    <div class="divider"></div>
    <div class="h2">最近</div>
    <div class="grid" style="gap:10px;">${recentTop || `<div class="muted">最近の選択なし</div>`}</div>

    <div class="divider"></div>
    <div class="h2">承認者</div>
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

/* Billing screens (v21維持) */
function screenBillingHome(){
  return `<div class="grid"><div class="card">
    <div class="h1">医事</div>
    <div class="grid">
      ${btn("📄 実施入力済み（承認済み）","go_bill_done","primary")}
      ${btn("⏳ 承認待ち","go_bill_pending","primary")}
    </div>
  </div></div>`;
}
function billingMaterialCard(m){
  const code = billingMapCode(m);
  const qty = Number(m.qty||1);
  const line1 = [(m.product_name||"(不明)"), `×${qty}`, (m.product_no||""), (m.product_sta||"")].filter(Boolean).join(" ");
  const tok = (m.tokutei01_name||"");
  const price = m.total_reimbursement_price_yen ? `${jpy(m.total_reimbursement_price_yen)}円` : "";
  return `
    <div style="position:relative;border:1px solid #f2d2dd;border-radius:16px;padding:12px;background:linear-gradient(180deg,#fff,#fff7fa);">
      <div class="tag" style="position:absolute;top:10px;right:10px;">${code}</div>
      <div style="font-weight:900;font-size:16px;line-height:1.25;padding-right:86px;">${line1}</div>
      <div class="muted" style="margin-top:6px;">${tok}</div>
      <div style="margin-top:6px;font-weight:900;color:#ff3b6b;">${price}</div>
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
    <div style="border:1px solid #f2d2dd;border-radius:16px;padding:10px;background:#fff;margin-top:10px;">
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
          <div class="h2">承認者</div>
          <select class="select" id="bill_filter_approver">${approverOptions}</select>
        </div>
        <div>
          <div class="h2">承認日時</div>
          <select class="select" id="bill_filter_approvedat">${dateOptions}</select>
        </div>
      </div>

      ${isPending ? `
        <div class="divider"></div>
        <div class="h2">一括承認（最終手段）</div>
        <div class="muted">点検済みのものを医事でまとめて承認</div>
        <div style="height:8px;"></div>
        <div class="h2">承認者</div>
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

/* ========= painters ========= */
function paintMatList(){
  const matList = $("#matList");
  if (!matList) return;

  const html = (scanCtx?.materials||[]).slice(0,12).map(m=>{
    const qty = Number(m.qty||1);
    const left = `<b>${m.product_name||"(不明)"} ×${qty}</b><div class="muted">${m.tokutei01_name||""}</div>`;
    const right = `
      <span class="tag">${m.dict_status||""}</span>
      <button class="btn small ghost" data-dec="${m.id}">−</button>
      <button class="btn small ghost" data-one="${m.id}">🗑</button>
      <button class="btn small ghost" data-all="${m.id}">✖</button>
    `;
    return listItem(left, right);
  }).join("") || `<div class="muted">材料なし</div>`;

  matList.innerHTML = html;

  matList.querySelectorAll("[data-dec]").forEach(b=>{
    b.onclick = ()=>{
      decMaterialById(scanCtx.materials, b.getAttribute("data-dec"));
      upsertDraft();
      paintMatList();
      updateSummaryUI();
    };
  });
  matList.querySelectorAll("[data-one]").forEach(b=>{
    b.onclick = ()=>{
      decMaterialById(scanCtx.materials, b.getAttribute("data-one"));
      upsertDraft();
      paintMatList();
      updateSummaryUI();
    };
  });
  matList.querySelectorAll("[data-all]").forEach(b=>{
    b.onclick = ()=>{
      removeMaterialRowById(scanCtx.materials, b.getAttribute("data-all"));
      upsertDraft();
      paintMatList();
      updateSummaryUI();
    };
  });
}

function paintConfirmList(){
  const box = $("#confirmList");
  if (!box) return;

  const mats = (scanCtx.materials||[]).map(m=>{
    const qty = Number(m.qty||1);
    const left = `<b>${m.product_name||"(不明)"} ×${qty}</b><div class="muted">${m.tokutei01_name||""}</div>`;
    const right = `
      <button class="btn small ghost" data-cdec="${m.id}">−</button>
      <button class="btn small ghost" data-cone="${m.id}">🗑</button>
      <button class="btn small ghost" data-call="${m.id}">✖</button>
    `;
    return listItem(left, right);
  }).join("") || `<div class="muted">材料なし</div>`;

  box.innerHTML = mats;

  const afterChange = ()=>{
    upsertDraft();
    paintConfirmList();
    refreshDiffBox();
    updateSummaryUI();
  };

  box.querySelectorAll("[data-cdec]").forEach(b=> b.onclick=()=>{ decMaterialById(scanCtx.materials, b.getAttribute("data-cdec")); afterChange(); });
  box.querySelectorAll("[data-cone]").forEach(b=> b.onclick=()=>{ decMaterialById(scanCtx.materials, b.getAttribute("data-cone")); afterChange(); });
  box.querySelectorAll("[data-call]").forEach(b=> b.onclick=()=>{ removeMaterialRowById(scanCtx.materials, b.getAttribute("data-call")); afterChange(); });
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

  if (!v.startsWith("/field/scan/step/4")) stopScannerIfAny();

  if (!role || v === "/role"){
    app.innerHTML = screenRole();
    updateSummaryUI();
    $("#role_doctor").onclick=()=>{ role="doctor"; save(); setView("/doctor/login"); renderWithGuard(); };
    $("#role_field").onclick =()=>{ role="field";  save(); setView("/"); renderWithGuard(); };
    $("#role_billing").onclick=()=>{ role="billing";save(); setView("/"); renderWithGuard(); };
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
    // サマリーは field の全画面で表示
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
        $("#to_step4").onclick=()=>{
          ensureScanCtx();
          scanCtx.procedureId=$("#proc_select").value||"";
          upsertDraft();
          updateSummaryUI();
          setView("/field/scan/step/4");
          renderWithGuard();
        };
        return;
      }
      if (step===4){
        ensureScanCtx();
        paintMatList();
        updateSummaryUI();

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

      // onchangeでrenderしない：サマリーは即更新
      $("#op_select2").onchange=()=>{ scanCtx.operatorId=$("#op_select2").value||""; upsertDraft(); refreshDiffBox(); updateSummaryUI(); };
      $("#pt_select2").onchange=()=>{ scanCtx.patientId=$("#pt_select2").value||""; upsertDraft(); refreshDiffBox(); updateSummaryUI(); };
      $("#proc_select2").onchange=()=>{ scanCtx.procedureId=$("#proc_select2").value||""; upsertDraft(); refreshDiffBox(); updateSummaryUI(); };

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
                <input class="check" type="checkbox" data-bchk="${x.id}">
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
