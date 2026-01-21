import { Scanner, parseGS1ForGTIN14, normalizeJan13 } from "./scan.js";

const LS = {
  role: "linqval_role_v1",
  state: "linqval_state_simple_v1",
};

const TOAST_MS = 5400;

const ROLES = [
  { id:"doctor", label:"医師" },
  { id:"field",  label:"実施入力モード" },
  { id:"billing",label:"医事課" },
];

const $ = (s)=>document.querySelector(s);
const now = ()=>new Date();
const iso = ()=>new Date().toISOString();
const jpy = (n)=> (Number(n||0)).toLocaleString("ja-JP");

function loadJSON(path, fallback){
  return fetch(path, { cache:"no-store" })
    .then(r=> r.ok ? r.json() : fallback)
    .catch(()=> fallback);
}

function safeParse(s, fb){ try { return JSON.parse(s); } catch { return fb; } }

function uid(prefix="ID"){
  return `${prefix}-${Math.random().toString(16).slice(2,10)}-${Date.now().toString(36)}`;
}

function toastShow({ title, price, sub }){
  $("#toastTitle").textContent = title || "OK";
  $("#toastPrice").textContent = price ? `${jpy(price)}円` : "";
  $("#toastSub").textContent = sub || "";
  $("#toast").classList.add("show");
  setTimeout(()=> $("#toast").classList.remove("show"), TOAST_MS);
}

function setRolePill(roleId){
  const r = ROLES.find(x=>x.id===roleId);
  $("#rolePill").textContent = `職種：${r ? r.label : "未選択"}`;
}

function defaultState(){
  return {
    // 実施入力データ
    drafts: [],      // {id, step, operatorId, patientId, procedureId, materials[], createdAt, updatedAt}
    done: [],        // {id, date, operatorId, patientId, place, procedureId, materials[], status: "pending"|"approved", confirmedAt}
    // 医師承認
    approvals: [],   // derived: pending items from done
    // Docs
    docs: {          // per patientId
      "": { symptom:"", reply:"", other:"" }
    }
  };
}

let role = localStorage.getItem(LS.role) || "";
let state = safeParse(localStorage.getItem(LS.state), null) || defaultState();

function save(){
  localStorage.setItem(LS.role, role);
  localStorage.setItem(LS.state, JSON.stringify(state));
}

// 読み込みデータ（ダミー）
let OPERATORS = [];
let PATIENTS  = [];
let PROCEDURES= [];
let PROC_SUG  = {}; // { base:[], byMaterialTokutei:{}, byMaterialName:{} }
let BILLMAP   = {}; // { byTokuteiName:{}, byProductName:{} }

async function bootData(){
  OPERATORS = await loadJSON("./data/operators.json", []);
  PATIENTS  = await loadJSON("./data/patients.json", []);
  PROCEDURES= await loadJSON("./data/procedures.json", []);
  PROC_SUG  = await loadJSON("./data/procedure_suggest.json", { base:[], byTokuteiName:{}, byProductName:{} });
  BILLMAP   = await loadJSON("./data/billing_map.json", { byTokuteiName:{}, byProductName:{} });
}

// ---- Split辞書照合（あなたの既存構成を利用） ----
async function fetchText(url){
  const res = await fetch(url, { cache:"no-store" });
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  return await res.text();
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
  const jan3=jan13.slice(0,3);
  const jan4=jan13.slice(0,4);
  return `./dict_jan/${jan3}/${jan4}.csv`;
}
function buildGtinPath(gtin14){
  const gt3=gtin14.slice(0,3);
  const gt4=gtin14.slice(0,4);
  return `./gtin_index/${gt3}/${gt4}.csv`;
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
  const manufacturer_name = pickRow(row, ["manufacturer_name","メーカー","maker","製造販売業者"]);
  const product_no = pickRow(row, ["product_no","製品番号","品番","型番"]);
  const product_sta = pickRow(row, ["product_sta","規格","spec","規格・サイズ"]);
  const tokutei_name = pickRow(row, ["tokutei_name","償還名称","特定材名称","特定保険医療材料名称"]);
  const priceRaw = pickRow(row, ["total_reimbursement_price_yen","償還価格合計","price","償還価格"]);
  const price = priceRaw ? Number(priceRaw.replace(/[^\d]/g,"")) : 0;
  return { product_name, manufacturer_name, product_no, product_sta, tokutei_name, total_reimbursement_price_yen: price };
}

async function lookupByJan13(jan13){
  const url = buildJanPath(jan13);
  try{
    const csv = await fetchText(url);
    const rows = csvToObjects(csv);
    const keys = ["jan13","JAN13","jan","JAN","code","barcode"];
    const hit = rows.filter(r => keys.some(k => r[k] === jan13));
    if (!hit.length) return { status:"no_match", jan13 };
    return { status:"hit", jan13, row: hit[0], all: hit };
  } catch(e){
    return { status:"dict_fetch_error", jan13, error: e.message };
  }
}

async function lookupJanFromGtin14(gtin14){
  const url = buildGtinPath(gtin14);
  try{
    const csv = await fetchText(url);
    const rows = csvToObjects(csv);
    const gtKeys = ["gtin14","GTIN14","gtin","GTIN","01","ai01"];
    const janKeys= ["jan13","JAN13","jan","JAN"];
    const found = rows.find(r => gtKeys.some(k => r[k] === gtin14));
    if (!found) return { status:"no_match", gtin14 };
    const jan13 = janKeys.map(k=>found[k]).find(v=> String(v||"").match(/^\d{13}$/));
    if (!jan13) return { status:"no_match", gtin14 };
    return { status:"hit", gtin14, jan13 };
  } catch(e){
    return { status:"dict_fetch_error", gtin14, error: e.message };
  }
}

// ---- 医事コード（仮） ----
function billingCodeFor(material){
  const t = material.tokutei_name || "";
  const p = material.product_name || "";
  const byT = BILLMAP.byTokuteiName?.[t];
  if (byT) return byT;
  const byP = BILLMAP.byProductName?.[p];
  if (byP) return byP;
  return "—";
}

// ---- 手技サジェスト（仮） ----
function suggestProcedures({ selectedProcedureId, materials }){
  // 仕様：
  // - 手技選択画面でサジェスト表示（base）
  // - 材料入力後に、材料に応じた手技サジェスト表示
  const base = PROC_SUG.base || [];
  const extra = [];
  for (const m of (materials||[])){
    const t = m.tokutei_name || "";
    const p = m.product_name || "";
    const a = PROC_SUG.byTokuteiName?.[t] || [];
    const b = PROC_SUG.byProductName?.[p] || [];
    extra.push(...a, ...b);
  }
  // 重複排除
  const seen = new Set();
  const out = [];
  for (const id of [...base, ...extra]){
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.slice(0, 6);
}

// ---- Router（シンプル：roleでホームが変わる） ----
let scanner = null;
let scanCtx = null; // {draftId, step, operatorId, patientId, procedureId, materials[]}

function setView(hash){ location.hash = `#${hash}`; }
function view(){ return (location.hash || "#/").slice(1); }

function ensureRole(){
  if (!role){
    setView("/role");
    return false;
  }
  return true;
}

// ---- UI building blocks ----
function btn(label, id, kind=""){
  const cls = kind === "primary" ? "btn primary" : kind === "ghost" ? "btn ghost" : "btn";
  return `<button class="${cls}" id="${id}">${label}</button>`;
}
function listButton({ title, sub, id, right="" }){
  return `
    <div class="listItem">
      <div>
        <b>${title}</b>
        ${sub ? `<div class="muted">${sub}</div>` : ""}
      </div>
      <div>${right || `<button class="btn small" id="${id}">開く</button>`}</div>
    </div>
  `;
}

// ---- Screens ----
function screenRole(){
  return `
    <div class="grid">
      <div class="card">
        <div class="h1">職種を選択</div>
        <div class="muted">最初だけ（今後は記憶）</div>
        <div class="divider"></div>
        <div class="grid">
          ${btn("① 医師", "role_doctor", "primary")}
          ${btn("② 実施入力モード", "role_field", "primary")}
          ${btn("③ 医事課", "role_billing", "primary")}
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
          ${btn("① 承認依頼", "go_doc_approve", "primary")}
          ${btn("② Docs", "go_doc_docs", "primary")}
        </div>
      </div>
    </div>
  `;
}

function screenDoctorApprovals(){
  // 承認待ち（実施入力 done のうち status=pending）
  const pending = state.done.filter(x=>x.status==="pending");
  const list = pending.length ? pending.map(x=>{
    const patient = PATIENTS.find(p=>p.id===x.patientId)?.label || x.patientId;
    const operator= OPERATORS.find(o=>o.id===x.operatorId)?.label || x.operatorId;
    const title = `${patient}`;
    const sub = `${operator} / ${x.place || "場所未設定"} / ${new Date(x.confirmedAt).toLocaleString("ja-JP")}`;
    return `
      <div class="listItem">
        <div style="display:flex;gap:12px;align-items:center;">
          <input class="check" type="checkbox" data-chk="${x.id}">
          <div>
            <b>${title}</b>
            <div class="muted">${sub}</div>
          </div>
        </div>
        <button class="btn small" data-open="${x.id}">詳細</button>
      </div>
    `;
  }).join("") : `<div class="muted">承認待ちはありません</div>`;

  return `
    <div class="grid">
      <div class="card">
        <div class="h1">承認依頼</div>
        <div class="muted">チェックして一括承認できます</div>
        <div class="divider"></div>
        <div class="grid">
          ${list}
        </div>
        <div class="divider"></div>
        <div class="row">
          ${btn("一括承認", "bulk_approve", "primary")}
          ${btn("戻る", "back_doc_home", "ghost")}
        </div>
      </div>
      <div class="card" id="approveDetail" style="display:none;"></div>
    </div>
  `;
}

function renderApprovalDetail(item){
  const patient = PATIENTS.find(p=>p.id===item.patientId)?.label || item.patientId;
  const operator= OPERATORS.find(o=>o.id===item.operatorId)?.label || item.operatorId;
  const proc    = PROCEDURES.find(p=>p.id===item.procedureId)?.label || "未選択";
  const mats = (item.materials||[]).map(m=>{
    const code = billingCodeFor(m);
    return `
      <div class="listItem">
        <div>
          <b>${m.product_name || "(不明)"}</b>
          <div class="muted">${m.tokutei_name || ""}</div>
          <div class="muted">医事コード：${code} / ${m.total_reimbursement_price_yen ? `${jpy(m.total_reimbursement_price_yen)}円` : ""}</div>
        </div>
      </div>
    `;
  }).join("") || `<div class="muted">材料なし</div>`;

  return `
    <div class="h2">詳細</div>
    <div class="muted">${patient} / ${operator}</div>
    <div class="divider"></div>
    <div class="h2">手技</div>
    <div class="listItem"><b>${proc}</b></div>
    <div class="divider"></div>
    <div class="h2">材料</div>
    <div class="grid">${mats}</div>
    <div class="divider"></div>
    <div class="row">
      <button class="btn primary" id="approve_one" data-id="${item.id}">この1件を承認</button>
      <button class="btn ghost" id="close_detail">閉じる</button>
    </div>
  `;
}

function screenDoctorDocs(){
  return `
    <div class="grid">
      <div class="card">
        <div class="h1">Docs</div>
        <div class="muted">項目別に保存できます</div>
        <div class="divider"></div>

        <div class="muted">患者</div>
        <select class="select" id="docs_patient">
          ${PATIENTS.map(p=>`<option value="${p.id}">${p.label}</option>`).join("")}
        </select>

        <div class="divider"></div>
        <div class="grid">
          ${btn("症状詳記", "docs_symptom", "primary")}
          ${btn("返書", "docs_reply", "primary")}
          ${btn("その他", "docs_other", "primary")}
          ${btn("戻る", "back_doc_home2", "ghost")}
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
        <div class="h1">実施入力モード</div>
        <div class="grid">
          ${btn("① スキャン", "go_field_scan", "primary")}
          ${btn("② 下書き", "go_field_drafts", "primary")}
          ${btn("③ 実施済み", "go_field_done", "primary")}
        </div>
      </div>
    </div>
  `;
}

/**
 * スキャン導線（仕様）
 * 入力者選択 → 患者ID選択 → 手技選択（サジェスト）→ 材料（スキャン）→ 確定
 * ※途中保存：常にOK（下書きへ）
 * ※材料入力後：材料に応じた手技サジェスト表示
 */
function screenFieldStep(step){
  // scanCtx を作る or 既存を使う
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
      updatedAt: iso(),
    };
  }
  scanCtx.step = step;

  // 共通：途中保存ボタン
  const saveDraftBar = `
    <div class="row">
      <button class="btn ghost" id="save_draft_any">途中保存（下書き）</button>
      <button class="btn ghost" id="cancel_flow">中止</button>
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
          ${btn("次へ", "to_step2", "primary")}
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
          <div class="h1">患者ID</div>
          <div class="divider"></div>
          <select class="select" id="pt_select">
            <option value="">選択</option>
            ${PATIENTS.map(p=>`<option value="${p.id}">${p.label}</option>`).join("")}
          </select>
          <div class="divider"></div>
          ${btn("次へ", "to_step3", "primary")}
          <div class="divider"></div>
          ${saveDraftBar}
        </div>
      </div>
    `;
  }

  if (step === 3){
    const sugIds = suggestProcedures({ selectedProcedureId: scanCtx.procedureId, materials: scanCtx.materials });
    const sugChips = sugIds.map(id=>{
      const p = PROCEDURES.find(x=>x.id===id);
      return p ? `<button class="btn small ghost" data-sug="${p.id}">${p.label}</button>` : "";
    }).join("");

    return `
      <div class="grid">
        <div class="card">
          <div class="h1">手技</div>
          <div class="muted">サジェスト</div>
          <div class="divider"></div>
          <div class="row">${sugChips || `<span class="muted">候補なし</span>`}</div>
          <div class="divider"></div>

          <div class="muted">選択</div>
          <select class="select" id="proc_select">
            <option value="">選択</option>
            ${PROCEDURES.map(p=>`<option value="${p.id}" ${scanCtx.procedureId===p.id?"selected":""}>${p.label}</option>`).join("")}
          </select>

          <div class="divider"></div>
          ${btn("次へ", "to_step4", "primary")}
          <div class="divider"></div>
          ${saveDraftBar}
        </div>
      </div>
    `;
  }

  if (step === 4){
    // 材料入力（スキャン画面）＋材料に応じた手技サジェスト表示
    const running = scanner?.isRunning?.() || false;

    const mats = (scanCtx.materials||[]).slice(0,6).map(m=>`
      <div class="listItem">
        <div>
          <b>${m.product_name || "(不明)"}</b>
          <div class="muted">${m.tokutei_name || ""}</div>
        </div>
        <div class="tag">${m.dict_status}</div>
      </div>
    `).join("") || `<div class="muted">まだ材料がありません</div>`;

    const sugIds = suggestProcedures({ selectedProcedureId: scanCtx.procedureId, materials: scanCtx.materials });
    const sugChips = sugIds.map(id=>{
      const p = PROCEDURES.find(x=>x.id===id);
      return p ? `<button class="btn small ghost" data-mat-sug="${p.id}">${p.label}</button>` : "";
    }).join("");

    return `
      <div class="grid">
        <div class="card">
          <div class="h1">材料</div>
          <div class="muted">スキャン</div>
          <div class="divider"></div>
          <div class="videoBox" id="scannerTarget"></div>
          <div class="divider"></div>

          <div class="row">
            <button class="btn primary" id="scan_start" ${running?"disabled":""}>Start</button>
            <button class="btn ghost" id="scan_stop" ${!running?"disabled":""}>Stop</button>
          </div>

          <div class="divider"></div>
          <div class="h2">材料→手技サジェスト</div>
          <div class="row">${sugChips || `<span class="muted">候補なし</span>`}</div>

          <div class="divider"></div>
          <div class="grid">${mats}</div>

          <div class="divider"></div>
          ${btn("確定画面へ", "to_confirm", "primary")}
          <div class="divider"></div>
          ${saveDraftBar}
        </div>
      </div>
    `;
  }

  // Confirm
  const op = OPERATORS.find(o=>o.id===scanCtx.operatorId)?.label || "未選択";
  const pt = PATIENTS.find(p=>p.id===scanCtx.patientId)?.label || "未選択";
  const pr = PROCEDURES.find(p=>p.id===scanCtx.procedureId)?.label || "未選択";

  const mats = (scanCtx.materials||[]).map(m=>{
    const code = billingCodeFor(m);
    return `
      <div class="listItem">
        <div>
          <b>${m.product_name || "(不明)"}</b>
          <div class="muted">${m.tokutei_name || ""}</div>
          <div class="muted">医事コード：${code} / ${m.total_reimbursement_price_yen ? `${jpy(m.total_reimbursement_price_yen)}円` : ""}</div>
        </div>
      </div>
    `;
  }).join("") || `<div class="muted">材料なし</div>`;

  return `
    <div class="grid">
      <div class="card">
        <div class="h1">確定</div>
        <div class="divider"></div>
        <div class="grid">
          <div class="listItem"><b>入力者</b><span class="tag">${op}</span></div>
          <div class="listItem"><b>患者</b><span class="tag">${pt}</span></div>
          <div class="listItem"><b>手技</b><span class="tag">${pr}</span></div>
        </div>
        <div class="divider"></div>
        <div class="h2">材料</div>
        <div class="grid">${mats}</div>
        <div class="divider"></div>
        <div class="row">
          ${btn("実施済みとして確定", "confirm_done", "primary")}
          ${btn("戻る（材料）", "back_step4", "ghost")}
        </div>
        <div class="divider"></div>
        ${btn("途中保存（下書き）", "save_draft_any2", "ghost")}
      </div>
    </div>
  `;
}

function screenDrafts(){
  const list = state.drafts.length ? state.drafts.map(d=>{
    const pt = PATIENTS.find(p=>p.id===d.patientId)?.label || "患者未選択";
    const op = OPERATORS.find(o=>o.id===d.operatorId)?.label || "入力者未選択";
    return `
      <div class="listItem">
        <div>
          <b>${pt}</b>
          <div class="muted">${op} / step:${d.step}</div>
        </div>
        <button class="btn small" data-resume="${d.id}">続き</button>
      </div>
    `;
  }).join("") : `<div class="muted">下書きはありません</div>`;

  return `
    <div class="grid">
      <div class="card">
        <div class="h1">下書き</div>
        <div class="divider"></div>
        <div class="grid">${list}</div>
        <div class="divider"></div>
        ${btn("戻る", "back_field_home", "ghost")}
      </div>
    </div>
  `;
}

function screenDone(){
  // フィルタ：今日 / 患者 / 入力者 / 場所（読み込み）
  const todayStr = new Date().toISOString().slice(0,10);
  return `
    <div class="grid">
      <div class="card">
        <div class="h1">実施済み</div>
        <div class="muted">当日分のみ表示</div>
        <div class="divider"></div>

        <div class="muted">絞り込み</div>
        <div class="grid">
          <select class="select" id="done_filter">
            <option value="today">今日</option>
            <option value="patient">患者</option>
            <option value="operator">入力者</option>
            <option value="place">場所</option>
          </select>

          <div id="done_filter_value"></div>
        </div>

        <div class="divider"></div>
        <div class="grid" id="done_list"></div>

        <div class="divider"></div>
        ${btn("戻る", "back_field_home2", "ghost")}
      </div>
    </div>
  `;
}

function screenBillingHome(){
  return `
    <div class="grid">
      <div class="card">
        <div class="h1">医事課</div>
        <div class="grid">
          ${btn("① 実施入力済み", "go_bill_done", "primary")}
          ${btn("② 承認待ち", "go_bill_pending", "primary")}
          ${btn("③ マスタメンテナンス", "go_bill_master", "primary")}
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
    const sub = `${operator} / ${x.place || "場所未設定"} / ${new Date(x.confirmedAt).toLocaleString("ja-JP")}`;
    const priceSum = (x.materials||[]).reduce((a,m)=>a+(m.total_reimbursement_price_yen||0),0);

    return `
      <div class="listItem" data-openbill="${x.id}">
        <div>
          <b>${patient}</b>
          <div class="muted">${sub}</div>
          <div class="muted">合計：${jpy(priceSum)}円</div>
        </div>
        <div class="tag">${isPending ? "承認待ち" : "実施入力済み"}</div>
      </div>
    `;
  }).join("") : `<div class="muted">対象データなし</div>`;

  return `
    <div class="grid">
      <div class="card">
        <div class="h1">${isPending ? "承認待ち" : "実施入力済み"}</div>
        <div class="divider"></div>
        <div class="grid">${list}</div>
        <div class="divider"></div>
        ${btn("戻る", "back_billing_home", "ghost")}
      </div>
      <div class="card" id="billDetail" style="display:none;"></div>
    </div>
  `;
}

function renderBillingDetail(item){
  const patient = PATIENTS.find(p=>p.id===item.patientId)?.label || item.patientId;
  const operator= OPERATORS.find(o=>o.id===item.operatorId)?.label || item.operatorId;
  const proc    = PROCEDURES.find(p=>p.id===item.procedureId)?.label || "未選択";
  const mats = (item.materials||[]).map(m=>{
    const code = billingCodeFor(m);
    return `
      <div class="listItem">
        <div>
          <b>${m.product_name || "(不明)"}</b>
          <div class="muted">${m.tokutei_name || ""}</div>
          <div class="muted">医事コード：${code}</div>
          <div class="muted">${m.total_reimbursement_price_yen ? `${jpy(m.total_reimbursement_price_yen)}円` : ""}</div>
        </div>
      </div>
    `;
  }).join("") || `<div class="muted">材料なし</div>`;

  return `
    <div class="h2">詳細</div>
    <div class="muted">${patient} / ${operator}</div>
    <div class="divider"></div>
    <div class="listItem"><b>手技</b><span class="tag">${proc}</span></div>
    <div class="divider"></div>
    <div class="h2">材料</div>
    <div class="grid">${mats}</div>
    <div class="divider"></div>
    ${btn("閉じる", "close_bill_detail", "ghost")}
  `;
}

function screenBillingMaster(){
  return `
    <div class="grid">
      <div class="card">
        <div class="h1">マスタメンテナンス</div>
        <div class="muted">標準ビルダ設定（ここは雛形）</div>
        <div class="divider"></div>
        <div class="listItem">
          <div>
            <b>標準ビルダ</b>
            <div class="muted">設定UIは次工程で実装</div>
          </div>
          <span class="tag">準備中</span>
        </div>
        <div class="divider"></div>
        ${btn("戻る", "back_billing_home2", "ghost")}
      </div>
    </div>
  `;
}

// ---- Render ----
function render(){
  setRolePill(role);
  const v = view();
  const app = $("#app");

  // scan画面以外ならカメラ停止
  if (!v.startsWith("/field/scan") && scanner?.isRunning?.()) scanner.stop();

  // role未選択
  if (v !== "/role" && !ensureRole()) return;

  // role selection
  if (v === "/role"){
    app.innerHTML = screenRole();
    bindRole();
    return;
  }

  // doctor
  if (role === "doctor"){
    if (v === "/") { app.innerHTML = screenDoctorHome(); bindDoctorHome(); return; }
    if (v === "/doctor/approvals") { app.innerHTML = screenDoctorApprovals(); bindDoctorApprovals(); return; }
    if (v === "/doctor/docs") { app.innerHTML = screenDoctorDocs(); bindDoctorDocs(); return; }
    // default
    app.innerHTML = screenDoctorHome();
    bindDoctorHome();
    return;
  }

  // field
  if (role === "field"){
    if (v === "/") { app.innerHTML = screenFieldHome(); bindFieldHome(); return; }
    if (v.startsWith("/field/scan/step")){
      const step = Number(v.split("/").pop());
      app.innerHTML = screenFieldStep(step);
      bindFieldStep(step);
      return;
    }
    if (v === "/field/drafts"){ app.innerHTML = screenDrafts(); bindDrafts(); return; }
    if (v === "/field/done"){ app.innerHTML = screenDone(); bindDone(); return; }
    // default
    app.innerHTML = screenFieldHome(); bindFieldHome(); return;
  }

  // billing
  if (role === "billing"){
    if (v === "/") { app.innerHTML = screenBillingHome(); bindBillingHome(); return; }
    if (v === "/billing/done"){ app.innerHTML = screenBillingList("done"); bindBillingList(); return; }
    if (v === "/billing/pending"){ app.innerHTML = screenBillingList("pending"); bindBillingList(); return; }
    if (v === "/billing/master"){ app.innerHTML = screenBillingMaster(); bindBillingMaster(); return; }
    app.innerHTML = screenBillingHome(); bindBillingHome(); return;
  }
}

// ---- Bindings ----
function bindRole(){
  $("#role_doctor").onclick = ()=> { role="doctor"; save(); setView("/"); render(); };
  $("#role_field").onclick  = ()=> { role="field"; save(); setView("/"); render(); };
  $("#role_billing").onclick= ()=> { role="billing"; save(); setView("/"); render(); };
}

function bindDoctorHome(){
  $("#go_doc_approve").onclick = ()=> { setView("/doctor/approvals"); render(); };
  $("#go_doc_docs").onclick    = ()=> { setView("/doctor/docs"); render(); };
}
function bindDoctorApprovals(){
  $("#back_doc_home").onclick = ()=> { setView("/"); render(); };

  // detail open
  document.querySelectorAll("[data-open]").forEach(b=>{
    b.onclick = ()=>{
      const id = b.getAttribute("data-open");
      const item = state.done.find(x=>x.id===id);
      if (!item) return;
      const box = $("#approveDetail");
      box.innerHTML = renderApprovalDetail(item);
      box.style.display="block";
      $("#close_detail").onclick = ()=> { box.style.display="none"; };
      $("#approve_one").onclick = ()=>{
        const tid = $("#approve_one").getAttribute("data-id");
        const it = state.done.find(x=>x.id===tid);
        if (it){ it.status="approved"; save(); toastShow({title:"承認", sub:"承認しました"}); }
        box.style.display="none";
        render();
      };
    };
  });

  // bulk approve
  $("#bulk_approve").onclick = ()=>{
    const checked = Array.from(document.querySelectorAll("[data-chk]"))
      .filter(x=>x.checked)
      .map(x=>x.getAttribute("data-chk"));
    if (!checked.length){ toastShow({title:"選択なし", sub:"チェックしてください"}); return; }
    for (const id of checked){
      const it = state.done.find(x=>x.id===id);
      if (it) it.status="approved";
    }
    save();
    toastShow({title:"一括承認", sub:`${checked.length}件`});
    render();
  };
}

function bindDoctorDocs(){
  $("#back_doc_home2").onclick = ()=> { setView("/"); render(); };

  const editor = $("#docsEditor");
  function openEditor(kind){
    const patientId = $("#docs_patient").value || "";
    state.docs[patientId] = state.docs[patientId] || { symptom:"", reply:"", other:"" };
    const label = kind==="symptom" ? "症状詳記" : kind==="reply" ? "返書" : "その他";
    const val = state.docs[patientId][kind] || "";
    editor.style.display="block";
    editor.innerHTML = `
      <div class="h2">${label}</div>
      <div class="muted">患者：${PATIENTS.find(p=>p.id===patientId)?.label || patientId}</div>
      <div class="divider"></div>
      <textarea id="docs_text" style="width:100%;height:220px;border-radius:16px;border:1px solid #f2d2dd;padding:12px;font-size:16px;outline:none;"></textarea>
      <div class="divider"></div>
      <div class="row">
        <button class="btn primary" id="docs_save">保存</button>
        <button class="btn ghost" id="docs_close">閉じる</button>
      </div>
    `;
    $("#docs_text").value = val;
    $("#docs_save").onclick = ()=>{
      state.docs[patientId][kind] = $("#docs_text").value;
      save();
      toastShow({title:"保存", sub:label});
      editor.style.display="none";
    };
    $("#docs_close").onclick = ()=> editor.style.display="none";
  }

  $("#docs_symptom").onclick = ()=> openEditor("symptom");
  $("#docs_reply").onclick   = ()=> openEditor("reply");
  $("#docs_other").onclick   = ()=> openEditor("other");
}

function bindFieldHome(){
  $("#go_field_scan").onclick = ()=> {
    scanCtx = null; // 新規フロー
    setView("/field/scan/step/1"); render();
  };
  $("#go_field_drafts").onclick = ()=> { setView("/field/drafts"); render(); };
  $("#go_field_done").onclick   = ()=> { setView("/field/done"); render(); };
}

function upsertDraft(ctx){
  const idx = state.drafts.findIndex(d=>d.id===ctx.draftId);
  const draft = {
    id: ctx.draftId,
    step: ctx.step,
    operatorId: ctx.operatorId,
    patientId: ctx.patientId,
    procedureId: ctx.procedureId,
    place: ctx.place,
    materials: ctx.materials || [],
    createdAt: ctx.createdAt,
    updatedAt: iso()
  };
  if (idx>=0) state.drafts[idx]=draft;
  else state.drafts.unshift(draft);
  save();
}

function bindFieldStep(step){
  // 共通
  const saveDraft = ()=>{
    upsertDraft(scanCtx);
    toastShow({ title:"下書き", sub:"保存しました" });
    setView("/field/drafts"); render();
  };
  const cancel = ()=>{
    if (scanner?.isRunning?.()) scanner.stop();
    scanCtx=null;
    setView("/"); render();
  };
  const anyBtn1 = $("#save_draft_any");
  if (anyBtn1) anyBtn1.onclick = saveDraft;
  const anyBtn2 = $("#save_draft_any2");
  if (anyBtn2) anyBtn2.onclick = saveDraft;
  $("#cancel_flow").onclick = cancel;

  if (step===1){
    $("#to_step2").onclick = ()=>{
      scanCtx.operatorId = $("#op_select").value || "";
      scanCtx.updatedAt = iso();
      setView("/field/scan/step/2"); render();
    };
    return;
  }

  if (step===2){
    $("#to_step3").onclick = ()=>{
      scanCtx.patientId = $("#pt_select").value || "";
      scanCtx.updatedAt = iso();
      setView("/field/scan/step/3"); render();
    };
    return;
  }

  if (step===3){
    document.querySelectorAll("[data-sug]").forEach(b=>{
      b.onclick = ()=> {
        scanCtx.procedureId = b.getAttribute("data-sug");
        $("#proc_select").value = scanCtx.procedureId;
      };
    });
    $("#to_step4").onclick = ()=>{
      scanCtx.procedureId = $("#proc_select").value || scanCtx.procedureId || "";
      scanCtx.updatedAt = iso();
      setView("/field/scan/step/4"); render();
    };
    return;
  }

  if (step===4){
    // 材料→手技サジェストクリックで手技上書き可能
    document.querySelectorAll("[data-mat-sug]").forEach(b=>{
      b.onclick = ()=> {
        scanCtx.procedureId = b.getAttribute("data-mat-sug");
        toastShow({ title:"手技サジェスト", sub:"手技を更新しました" });
      };
    });

    // scanner
    const target = $("#scannerTarget");
    if (!scanner){
      scanner = new Scanner({
        targetEl: target,
        onDetected: async (raw)=> onScan(raw),
        onError: (e)=> toastShow({ title:"Start失敗", sub: e.message })
      });
    } else {
      scanner.targetEl = target;
    }

    $("#scan_start").onclick = async ()=>{
      await scanner.start();
      render(); // ボタン状態
    };
    $("#scan_stop").onclick = ()=>{
      scanner.stop();
      render();
    };

    $("#to_confirm").onclick = ()=>{
      if (scanner?.isRunning?.()) scanner.stop();
      setView("/field/scan/step/5"); render();
    };

    return;
  }

  // confirm
  $("#back_step4").onclick = ()=> { setView("/field/scan/step/4"); render(); };

  $("#confirm_done").onclick = ()=>{
    // doneへ移動（承認待ちにする）
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

    // 下書きに同じdraftがあれば削除
    state.drafts = state.drafts.filter(d=>d.id!==scanCtx.draftId);
    save();

    toastShow({ title:"確定", sub:"承認待ちに送信しました" });
    scanCtx=null;
    setView("/field/done"); render();
  };
}

async function onScan(raw){
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
      toastShow({ title:"読み取りOK", price:m.total_reimbursement_price_yen, sub:m.product_name });
    } else if (r.status==="no_match"){
      toastShow({ title:"読み取りOK", sub:"辞書0件（回収対象）" });
    } else {
      toastShow({ title:"読み取りOK", sub:"辞書取得失敗" });
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
        toastShow({ title:"読み取りOK", price:m.total_reimbursement_price_yen, sub:m.product_name });
      } else if (r.status==="no_match"){
        toastShow({ title:"読み取りOK", sub:"辞書0件（回収対象）" });
      } else {
        toastShow({ title:"読み取りOK", sub:"辞書取得失敗" });
      }
    } else {
      item.dict_status = "no_match";
      toastShow({ title:"読み取りOK", sub:"索引0件（回収対象）" });
    }
  } else {
    toastShow({ title:"読み取りOK", sub:"形式不明（raw保存）" });
  }

  scanCtx.materials.unshift(item);
  scanCtx.updatedAt = iso();
  save();
  render();
}

function bindDrafts(){
  $("#back_field_home").onclick = ()=> { setView("/"); render(); };
  document.querySelectorAll("[data-resume]").forEach(b=>{
    b.onclick = ()=>{
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
}

function bindDone(){
  $("#back_field_home2").onclick = ()=> { setView("/"); render(); };

  const fSel = $("#done_filter");
  const box = $("#done_filter_value");
  const list = $("#done_list");

  function buildFilterValueUI(kind){
    if (kind==="today"){
      box.innerHTML = `<div class="tag">今日</div>`;
      return { type:"today" };
    }
    if (kind==="patient"){
      box.innerHTML = `
        <select class="select" id="f_patient">
          <option value="">選択</option>
          ${PATIENTS.map(p=>`<option value="${p.id}">${p.label}</option>`).join("")}
        </select>`;
      return { type:"patient" };
    }
    if (kind==="operator"){
      box.innerHTML = `
        <select class="select" id="f_operator">
          <option value="">選択</option>
          ${OPERATORS.map(o=>`<option value="${o.id}">${o.label}</option>`).join("")}
        </select>`;
      return { type:"operator" };
    }
    // place
    box.innerHTML = `
      <select class="select" id="f_place">
        <option value="">選択</option>
        ${["カテ室","手術室","内視鏡","外来処置室","病棟","未設定"].map(x=>`<option value="${x}">${x}</option>`).join("")}
      </select>`;
    return { type:"place" };
  }

  function renderList(){
    const today = new Date().toISOString().slice(0,10);
    const kind = fSel.value;
    let items = state.done.filter(x=>x.date===today); // 原則当日分のみ

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
      return `
        <div class="listItem">
          <div>
            <b>${patient}</b>
            <div class="muted">${operator} / ${x.place} / ${st}</div>
          </div>
          <span class="tag">${(x.materials||[]).length}点</span>
        </div>
      `;
    }).join("") : `<div class="muted">当日データなし</div>`;
  }

  buildFilterValueUI("today");
  renderList();

  fSel.onchange = ()=>{
    const kind = fSel.value;
    buildFilterValueUI(kind);
    // value change handlers
    $("#f_patient") && ($("#f_patient").onchange = renderList);
    $("#f_operator")&& ($("#f_operator").onchange = renderList);
    $("#f_place")   && ($("#f_place").onchange = renderList);
    renderList();
  };
  // also attach if created
  $("#f_patient") && ($("#f_patient").onchange = renderList);
  $("#f_operator")&& ($("#f_operator").onchange = renderList);
  $("#f_place")   && ($("#f_place").onchange = renderList);
}

function bindBillingHome(){
  $("#go_bill_done").onclick    = ()=> { setView("/billing/done"); render(); };
  $("#go_bill_pending").onclick = ()=> { setView("/billing/pending"); render(); };
  $("#go_bill_master").onclick  = ()=> { setView("/billing/master"); render(); };
}

function bindBillingList(){
  $("#back_billing_home").onclick = ()=> { setView("/"); render(); };

  document.querySelectorAll("[data-openbill]").forEach(el=>{
    el.onclick = ()=>{
      const id = el.getAttribute("data-openbill");
      const item = state.done.find(x=>x.id===id);
      if (!item) return;
      const box = $("#billDetail");
      box.innerHTML = renderBillingDetail(item);
      box.style.display="block";
      $("#close_bill_detail").onclick = ()=> box.style.display="none";
    };
  });
}

function bindBillingMaster(){
  $("#back_billing_home2").onclick = ()=> { setView("/"); render(); };
}

// top role change
$("#btnRole").onclick = ()=>{
  role = "";
  save();
  setView("/role");
  render();
};

window.addEventListener("hashchange", render);

// ---- boot ----
(async function(){
  await bootData();
  if (!location.hash) setView("/");
  setRolePill(role);
  render();
})();
