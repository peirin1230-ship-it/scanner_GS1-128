import { Scanner, parseGS1ForGTIN14, normalizeJan13 } from "./scan.js";

/* =========================
   Tuning
========================= */
const LS = { role:"linqval_role_v1", state:"linqval_state_v7" };
const TOAST_MS = 5400;

// A) 2〜3秒 +2秒 => 4.5秒
const ANY_SCAN_COOLDOWN_MS = 4500;
const SAME_CODE_COOLDOWN_MS = 8000;

/* =========================
   Helpers
========================= */
const $ = (s)=>document.querySelector(s);
const iso = ()=>new Date().toISOString();
const jpy = (n)=> (Number(n||0)).toLocaleString("ja-JP");
function safeParse(s, fb){ try { return JSON.parse(s); } catch { return fb; } }
function uid(prefix="ID"){ return `${prefix}-${Math.random().toString(16).slice(2,10)}-${Date.now().toString(36)}`; }

function toastShow({ title, price, sub }){
  $("#toastTitle").textContent = title || "OK"; // 商品名が主役
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
  return `<div class="listItem"><div style="flex:1;">${htmlLeft}</div><div>${htmlRight}</div></div>`;
}

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
   Fallback data (候補0件防止)
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
const FALLBACK_PROC_SUG = { base:["pr1","pr2","pr3"], byTokuteiName:{}, byProductName:{} };
const FALLBACK_BILLMAP = { byTokuteiName:{}, byProductName:{} };

async function loadJSON(path, fallback){
  try{ const r = await fetch(path, {cache:"no-store"}); if(!r.ok) return fallback; return await r.json(); }
  catch{ return fallback; }
}

let OPERATORS=[], PATIENTS=[], PROCEDURES=[], PROC_SUG={}, BILLMAP={};
async function bootData(){
  OPERATORS = await loadJSON("./data/operators.json", FALLBACK_OPERATORS);
  PATIENTS  = await loadJSON("./data/patients.json",  FALLBACK_PATIENTS);
  PROCEDURES= await loadJSON("./data/procedures.json",FALLBACK_PROCEDURES);
  PROC_SUG  = await loadJSON("./data/procedure_suggest.json", FALLBACK_PROC_SUG);
  BILLMAP   = await loadJSON("./data/billing_map.json", FALLBACK_BILLMAP);

  if (!Array.isArray(OPERATORS)||!OPERATORS.length) OPERATORS=FALLBACK_OPERATORS;
  if (!Array.isArray(PATIENTS)||!PATIENTS.length) PATIENTS=FALLBACK_PATIENTS;
  if (!Array.isArray(PROCEDURES)||!PROCEDURES.length) PROCEDURES=FALLBACK_PROCEDURES;
}

/* =========================
   Dict CSV helpers
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
  return {
    product_name,
    total_reimbursement_price_yen: total,
    tokutei01_name,
    tokutei_details
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
   Billing map code (医事側で表示)
========================= */
function billingMapCode(material){
  const t = material?.tokutei01_name || "";
  const p = material?.product_name || "";
  return BILLMAP.byTokuteiName?.[t] || BILLMAP.byProductName?.[p] || "—";
}

/* =========================
   Procedure suggest
========================= */
function suggestProcedureIds(materials){
  const base = PROC_SUG.base || [];
  const extra=[];
  for (const m of (materials||[])){
    const name = m.tokutei01_name || "";
    extra.push(...(PROC_SUG.byTokuteiName?.[name] || []));
  }
  const seen=new Set(); const out=[];
  for (const id of [...base, ...extra]){
    if (!id || seen.has(id)) continue;
    seen.add(id); out.push(id);
  }
  if (!out.length) return PROCEDURES.slice(0,3).map(x=>x.id);
  return out.slice(0,6);
}

/* =========================
   Routing + flow ctx
========================= */
let scannerInst=null;
let scanCtx=null; // {draftId, step, operatorId, patientId, procedureId, place, materials[]}
let lastScan = { anyTs:0, raw:"", sameTs:0 };

function setView(hash){ location.hash = `#${hash}`; }
function view(){ return (location.hash || "#/").slice(1); }
function ensureRole(){
  if (!role){
    if (view() !== "/role") setView("/role");
    return false;
  }
  return true;
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

function screenDoctorHome(){
  return `<div class="grid"><div class="card">
    <div class="h1">医師</div>
    <div class="grid">
      ${btn("✅ 承認","go_doc_approve","primary")}
      ${btn("📝 Docs","go_doc_docs","primary")}
    </div>
  </div></div>`;
}

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
    <div class="divider"></div>${btn("⬅ 戻る","back_field_home","ghost")}
  </div></div>`;
}

function screenDone(){
  const today = new Date().toISOString().slice(0,10);
  const items = state.done.filter(x=>x.date===today);
  const list = items.length ? items.map(x=>{
    const pt = PATIENTS.find(p=>p.id===x.patientId)?.label || x.patientId;
    const op = OPERATORS.find(o=>o.id===x.operatorId)?.label || x.operatorId;
    const st = x.status==="pending" ? "承認待ち" : "承認済";
    return listItem(`<b>${pt}</b><div class="muted">${op} / ${st}</div>`, `<span class="tag">${(x.materials||[]).length}点</span>`);
  }).join("") : `<div class="muted">当日データなし</div>`;

  return `<div class="grid"><div class="card">
    <div class="h1">実施済み</div><div class="divider"></div>
    <div class="grid">${list}</div>
    <div class="divider"></div>${btn("⬅ 戻る","back_field_home2","ghost")}
  </div></div>`;
}

function screenFieldStep(step){
  ensureScanCtx(); scanCtx.step=step;

  const opLabel = OPERATORS.find(o=>o.id===scanCtx.operatorId)?.label || "未選択";
  const ptLabel = PATIENTS.find(p=>p.id===scanCtx.patientId)?.label || "未選択";
  const prLabel = PROCEDURES.find(p=>p.id===scanCtx.procedureId)?.label || "未選択";

  const saveBar = `<div class="row">
    <button class="btn ghost" id="save_draft_any">💾 下書き</button>
    <button class="btn ghost" id="cancel_flow">✖ 中止</button>
  </div>`;

  if (step===1){
    return `<div class="grid"><div class="card">
      <div class="h1">入力者</div><div class="divider"></div>
      <select class="select" id="op_select">
        <option value="">選択</option>${OPERATORS.map(o=>`<option value="${o.id}">${o.label}</option>`).join("")}
      </select>
      <div class="divider"></div>${btn("➡ 次へ","to_step2","primary")}
      <div class="divider"></div>${saveBar}
    </div></div>`;
  }
  if (step===2){
    return `<div class="grid"><div class="card">
      <div class="h1">患者</div><div class="divider"></div>
      <select class="select" id="pt_select">
        <option value="">選択</option>${PATIENTS.map(p=>`<option value="${p.id}">${p.label}</option>`).join("")}
      </select>
      <div class="divider"></div>${btn("➡ 次へ","to_step3","primary")}
      <div class="divider"></div>${saveBar}
    </div></div>`;
  }
  if (step===3){
    const sugIds = suggestProcedureIds(scanCtx.materials);
    const sugBtns = sugIds.map(id=>{
      const p = PROCEDURES.find(x=>x.id===id);
      return p ? `<button class="btn small ghost" data-sug="${p.id}">${p.label}</button>` : "";
    }).join("");
    return `<div class="grid"><div class="card">
      <div class="h1">手技</div><div class="divider"></div>
      <div class="row">${sugBtns || `<span class="muted">候補なし</span>`}</div>
      <div class="divider"></div>
      <select class="select" id="proc_select">
        <option value="">選択</option>${PROCEDURES.map(p=>`<option value="${p.id}">${p.label}</option>`).join("")}
      </select>
      <div class="divider"></div>${btn("➡ 次へ","to_step4","primary")}
      <div class="divider"></div>${saveBar}
    </div></div>`;
  }

  if (step===4){
    const mats = (scanCtx.materials||[]).slice(0,8).map(m=>{
      const left = `<span class="chip mat">材料</span>
        <div style="margin-top:6px;"><b>${m.product_name||"(不明)"}</b></div>
        <div class="muted">${m.tokutei01_name||""}</div>`;
      return listItem(left, `<span class="tag">${m.dict_status}</span>`);
    }).join("") || `<div class="muted">材料なし</div>`;

    return `<div class="grid"><div class="card">
      <div class="h1">材料</div>

      <div class="row" style="margin-top:8px;">
        <span class="chip patient">患者</span><span style="font-weight:900;">${ptLabel}</span>
        <span class="chip proc">手技</span><span style="font-weight:900;">${prLabel}</span>
      </div>
      <div class="row" style="margin-top:6px;">
        <span class="chip" style="background:#fff;border-color:#f2d2dd;">入力者</span><span style="font-weight:900;">${opLabel}</span>
      </div>

      <div class="divider"></div>
      <div class="videoBox" id="scannerTarget"></div>

      <div class="divider"></div>
      <div class="row">
        <button class="btn primary" id="scan_start">▶ Start</button>
        <button class="btn ghost" id="scan_stop" disabled>■ Stop</button>
        <button class="btn ghost" id="to_confirm">✅ 確定</button>
      </div>

      <div class="divider"></div>
      <div class="grid" id="matList">${mats}</div>

      <div class="divider"></div>${saveBar}
    </div></div>`;
  }

  // confirm（コードは出さない）
  const mats = (scanCtx.materials||[]).map(m=>{
    const left = `<span class="chip mat">材料</span>
      <div style="margin-top:6px;"><b>${m.product_name||"(不明)"}</b></div>
      <div class="muted">${m.tokutei01_name||""}</div>`;
    return listItem(left,"");
  }).join("") || `<div class="muted">材料なし</div>`;

  return `<div class="grid"><div class="card">
    <div class="h1">確定</div>
    <div class="row" style="margin-top:8px;"><span class="chip patient">患者</span><span style="font-weight:900;">${ptLabel}</span></div>
    <div class="row" style="margin-top:6px;"><span class="chip proc">手技</span><span style="font-weight:900;">${prLabel}</span></div>
    <div class="row" style="margin-top:6px;"><span class="chip" style="background:#fff;border-color:#f2d2dd;">入力者</span><span style="font-weight:900;">${opLabel}</span></div>
    <div class="divider"></div>
    <div class="grid">${mats}</div>
    <div class="divider"></div>
    <div class="row">
      ${btn("✅ 実施済み","confirm_done","primary")}
      ${btn("⬅ 戻る","back_step4","ghost")}
      ${btn("💾 下書き","save_draft_any2","ghost")}
    </div>
  </div></div>`;
}

/* Billing */
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
  const items = state.done.filter(x=>x.date===today).filter(x=> isPending ? x.status==="pending" : x.status!=="pending");

  const list = items.length ? items.map(x=>{
    const pt = PATIENTS.find(p=>p.id===x.patientId)?.label || x.patientId;
    const op = OPERATORS.find(o=>o.id===x.operatorId)?.label || x.operatorId;
    return `<div class="listItem" data-openbill="${x.id}">
      <div><b>${pt}</b><div class="muted">${op}</div></div>
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
function renderBillingDetail(item){
  const mats = (item.materials||[]).map(m=>{
    const code = billingMapCode(m); // billing_mapのコード
    const top = triRow(m.product_name, m.tokutei01_name, code, m.total_reimbursement_price_yen||0);
    const detail = renderTokuteiDetails(m.tokutei_details||[]);
    return `${top}${detail}`;
  }).join("") || `<div class="muted">材料なし</div>`;

  return `
    <div class="h2">詳細</div>
    <div class="divider"></div>
    <div class="h2">材料</div>
    <div class="grid">${mats}</div>
    <div class="divider"></div>
    ${btn("✖ 閉じる","close_bill_detail","ghost")}
  `;
}

/* =========================
   Render + bind
========================= */
function render(){
  setRolePill(role);

  const v = view();
  const app = $("#app");

  // scan以外でカメラ停止
  if (!v.startsWith("/field/scan/step/4") && scannerInst?.isRunning?.()) scannerInst.stop();

  // role未選択なら role画面へ（ここで止める。hashchangeで再描画）
  if (v !== "/role" && !ensureRole()) return;

  // ヘッダの職種変更
  $("#btnRole").onclick = ()=>{ role=""; save(); setView("/role"); render(); };

  if (v === "/role"){
    app.innerHTML = screenRole();
    $("#role_doctor").onclick=()=>{ role="doctor"; save(); setView("/"); render(); };
    $("#role_field").onclick =()=>{ role="field";  save(); setView("/"); render(); };
    $("#role_billing").onclick=()=>{ role="billing";save(); setView("/"); render(); };
    return;
  }

  /* ------- Doctor minimal (home only for now) ------- */
  if (role==="doctor"){
    app.innerHTML = screenDoctorHome();
    // 必要ならここに承認/Docsを戻せます（今は画面遷移の安定を優先）
    return;
  }

  /* ------- Field ------- */
  if (role==="field"){
    if (v === "/"){
      app.innerHTML = screenFieldHome();
      $("#go_field_scan").onclick=()=>{ scanCtx=null; lastScan={anyTs:0,raw:"",sameTs:0}; setView("/field/scan/step/1"); render(); };
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
        if (scannerInst?.isRunning?.()) scannerInst.stop();
        toastShow({title:"下書き", sub:"保存"});
        scanCtx=null;
        setView("/field/drafts"); render();
      };
      const cancel = ()=>{
        if (scannerInst?.isRunning?.()) scannerInst.stop();
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
        document.querySelectorAll("[data-sug]").forEach(b=>{
          b.onclick=()=>{ scanCtx.procedureId=b.getAttribute("data-sug"); $("#proc_select").value=scanCtx.procedureId; };
        });
        $("#to_step4").onclick=()=>{
          ensureScanCtx();
          scanCtx.procedureId=$("#proc_select").value||scanCtx.procedureId||"";
          upsertDraft();
          setView("/field/scan/step/4"); render();
        };
        return;
      }

      if (step===4){
        const startBtn=$("#scan_start"), stopBtn=$("#scan_stop"), matList=$("#matList"), target=$("#scannerTarget");

        const paintMats=()=>{
          const mats=(scanCtx.materials||[]).slice(0,8).map(m=>{
            const left = `<span class="chip mat">材料</span>
              <div style="margin-top:6px;"><b>${m.product_name||"(不明)"}</b></div>
              <div class="muted">${m.tokutei01_name||""}</div>`;
            return listItem(left, `<span class="tag">${m.dict_status}</span>`);
          }).join("") || `<div class="muted">材料なし</div>`;
          matList.innerHTML=mats;
        };
        const setBtns=(run)=>{ startBtn.disabled=!!run; stopBtn.disabled=!run; };

        const onDetected = async (raw)=>{
          const t = Date.now();
          if (t - lastScan.anyTs < ANY_SCAN_COOLDOWN_MS) return;
          if (raw === lastScan.raw && (t - lastScan.sameTs) < SAME_CODE_COOLDOWN_MS) return;

          lastScan.anyTs = t;
          if (raw === lastScan.raw) lastScan.sameTs = t;
          else { lastScan.raw = raw; lastScan.sameTs = t; }

          const s = String(raw||"");
          const jan13 = normalizeJan13(s);
          const gtin14 = parseGS1ForGTIN14(s);

          const item = {
            id: uid("MAT"),
            raw:s,
            jan13:jan13||null,
            gtin14:gtin14||null,
            dict_status:"unknown",
            product_name:"",
            total_reimbursement_price_yen:0,
            tokutei01_name:"",
            tokutei_details:[]
          };

          if (jan13){
            const r = await lookupByJan13(jan13);
            item.dict_status = r.status;
            if (r.status==="hit"){
              Object.assign(item, mapDictRow(r.row));
              toastShow({ title:item.product_name, price:item.total_reimbursement_price_yen, sub:item.tokutei01_name });
            } else if (r.status==="no_match"){
              toastShow({ title:"読み取りOK", sub:"辞書0件（回収対象）" });
            } else {
              toastShow({ title:"読み取りOK", sub:"辞書取得失敗（回収対象）" });
            }
          } else if (gtin14){
            const g = await lookupJanFromGtin14(gtin14);
            if (g.status==="hit"){
              item.jan13 = g.jan13;
              const r = await lookupByJan13(g.jan13);
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
          } else {
            toastShow({ title:"読み取りOK", sub:"形式不明（raw保存）" });
          }

          scanCtx.materials.unshift(item);
          upsertDraft();
          paintMats();
        };

        if (!scannerInst){
          scannerInst = new Scanner({ targetEl: target, onDetected, onError:(e)=>toastShow({title:"Start失敗", sub:e.message}) });
        } else scannerInst.targetEl = target;

        paintMats();
        setBtns(scannerInst.isRunning?.()||false);

        startBtn.onclick=async()=>{ await scannerInst.start(); setBtns(true); };
        stopBtn.onclick=()=>{ scannerInst.stop(); setBtns(false); };

        $("#to_confirm").onclick=()=>{
          if (scannerInst?.isRunning?.()) scannerInst.stop();
          upsertDraft();
          setView("/field/scan/step/5"); render();
        };
        return;
      }

      // confirm
      $("#back_step4").onclick=()=>{ setView("/field/scan/step/4"); render(); };
      $("#confirm_done").onclick=()=>{
        ensureScanCtx();
        if (!scanCtx.operatorId){ toastShow({title:"未選択", sub:"入力者"}); return; }
        if (!scanCtx.patientId){ toastShow({title:"未選択", sub:"患者"}); return; }
        if (!scanCtx.procedureId){ toastShow({title:"未選択", sub:"手技"}); return; }
        if (!scanCtx.materials?.length){ toastShow({title:"材料なし", sub:"スキャンしてください"}); return; }

        state.done.unshift({
          id: uid("DONE"),
          date: new Date().toISOString().slice(0,10),
          operatorId: scanCtx.operatorId,
          patientId: scanCtx.patientId,
          place: scanCtx.place || "未設定",
          procedureId: scanCtx.procedureId,
          materials: scanCtx.materials || [],
          status: "pending",
          confirmedAt: iso()
        });
        state.drafts = state.drafts.filter(d=>d.id!==scanCtx.draftId);
        save();

        scanCtx=null;
        lastScan={anyTs:0,raw:"",sameTs:0};
        toastShow({title:"確定", sub:"承認待ちへ"});
        setView("/field/done"); render();
      };
      return;
    }

    // fallback
    setView("/"); render(); return;
  }

  /* ------- Billing ------- */
  if (role==="billing"){
    if (v==="/"){
      app.innerHTML = screenBillingHome();
      $("#go_bill_done").onclick=()=>{ setView("/billing/done"); render(); };
      $("#go_bill_pending").onclick=()=>{ setView("/billing/pending"); render(); };
      $("#back_bill_home").onclick=()=>{ role=""; save(); setView("/role"); render(); };
      return;
    }
    if (v==="/billing/done" || v==="/billing/pending"){
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
}

/* =========================
   Boot (★ここが今回の肝：先にhashchange登録)
========================= */
(async function(){
  await bootData();

  // ★先に登録（これで “#/role に変えたのに描画されない” が消えます）
  window.addEventListener("hashchange", render);

  if (!location.hash) location.hash="#/";
  setRolePill(role);
  save();
  render();
})();
