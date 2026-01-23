
/*
 LinQ VAL PoC app.js (UI/UX patch)
 - Popup (toast) won't block scan: scan overlay hides toast
 - Scan view fits screen: full-screen overlay + videoBox height clamp
 - Suggest is prominent (sugBox + warn chip)
 - After main procedure selection, can pick up to 3 assistant procedures
 - Designed to avoid scrolling (single-screen overlay per step)
*/
import { Scanner, parseGS1ForGTIN14, normalizeJan13 } from "./scan.js";

(function(){
  'use strict';

  // ---------- helpers ----------
  function $(id){ return document.getElementById(id); }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]);});}
  function bindTap(el, fn){
    if(!el) return;
    var lock = false;
    function run(e){
      if(lock) return;
      lock = true;
      try { fn(e); } catch(ex){ showFatal("UIイベントでエラー", ex); }
      setTimeout(function(){ lock=false; }, 250);
    }
    el.addEventListener('click', run, false);
    el.addEventListener('touchend', function(e){ e.preventDefault(); run(e); }, false);
  }
  function now(){ return Date.now(); }
  function fmtYmdhm(ts){
    var d=new Date(ts);
    function p(n){ return (n<10?'0':'')+n; }
    return d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate())+" "+p(d.getHours())+":"+p(d.getMinutes());
  }
  function dlText(filename, text){
    var blob = new Blob([text], {type:"text/plain;charset=utf-8"});
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function(){
      try{ document.body.removeChild(a); }catch(e){}
      try{ URL.revokeObjectURL(url); }catch(e){}
    }, 0);
  }

  // ---------- toast & fatal ----------
  var toastEl, toastTitleEl, toastPriceEl, toastSubEl;
  function initToast(){
    toastEl = $("toast");
    toastTitleEl = $("toastTitle");
    toastPriceEl = $("toastPrice");
    toastSubEl = $("toastSub");
  }
  function showToast(title, price, sub, ms){
    if(state.ui.scanOpen) return; // ✅ scan中は邪魔するので出さない
    if(!toastEl) return;
    toastTitleEl.textContent = title || "";
    toastPriceEl.textContent = price || "";
    toastSubEl.textContent = sub || "";
    toastEl.classList.add("show");
    setTimeout(function(){ toastEl.classList.remove("show"); }, ms || 1600);
  }
  function showFatal(title, err){
    var host = $("app");
    var msg = (err && err.stack) ? err.stack : String(err||"");
    host.innerHTML =
      '<div class="card">'+
      '<div class="h1" style="color:var(--red)">'+esc(title)+'</div>'+
      '<div class="muted">'+esc(msg)+'</div>'+
      '<div class="divider"></div>'+
      '<div class="muted" style="font-size:12px;">Safariのキャッシュが強い場合はURLに <b>?v=数字</b> を付けて開き直してください。</div>'+
      '</div>';
  }
  window.addEventListener("error", function(e){
    try{ showFatal("起動エラー", e.error || e.message || e); }catch(ex){}
  });

  // ---------- master (PoC: minimal sample; replace with your json later) ----------
  // If you already have JSON in docs/data, you can swap these to fetch() later.
  var M = {
    operators: [
      {id:"op1", name:"看護師A", dept:"外科"},
      {id:"op2", name:"看護師B", dept:"整形"}
    ],
    patients: [
      {id:"pt1", name:"患者A", ward:"3A"},
      {id:"pt2", name:"患者B", ward:"2B"}
    ],
    procedures: [
      {id:"pr1", name:"手技A", dept:"外科"},
      {id:"pr2", name:"手技B", dept:"外科"},
      {id:"pr3", name:"手技C", dept:"整形"},
      {id:"pr4", name:"補助手技1", dept:"外科"},
      {id:"pr5", name:"補助手技2", dept:"外科"},
      {id:"pr6", name:"補助手技3", dept:"外科"}
    ],
    doctors: [
      {id:"dr1", name:"医師A", dept:"外科"},
      {id:"dr2", name:"医師B", dept:"整形"}
    ]
  };

  // ---------- state ----------
  var state = {
    role: null, // 'field' | 'doctor' | 'billing'
    ui: {
      scanOpen: false,
      roleModal: false
    },
    field: {
      step: 1, // 1 operator, 2 patient, 3 procedure+assist, 4 scan, 5 confirm, 6 approver
      operatorId: "",
      patientId: "",
      procId: "",
      assistProcIds: [], // ✅ up to 3
      items: [],
      approverId: ""
    },
    approvals: [] // {id, createdAt, operator, patient, proc, assist, items, status, approvedAt, comment}
  };

  // ---------- role UI ----------
  function setRole(r){
    state.role = r;
    updateRolePill();
    render();
  }
  function updateRolePill(){
    var pill = $("rolePill");
    if(!pill) return;
    var label = "未選択";
    if(state.role==="field") label="実施入力";
    if(state.role==="doctor") label="医師";
    if(state.role==="billing") label="医事";
    pill.textContent = "職種：" + label;
  }

  function openRoleModal(){
    state.ui.roleModal = true;
    renderRoleModal();
  }
  function closeRoleModal(){
    state.ui.roleModal = false;
    render();
  }

  function renderRoleModal(){
    var host = $("app");
    host.innerHTML =
      '<div class="card">'+
        '<div class="h1">職種を選択</div>'+
        '<div class="grid">'+
          '<button class="btn primary" id="pickField">実施入力</button>'+
          '<button class="btn" id="pickDoctor">医師</button>'+
          '<button class="btn" id="pickBilling">医事</button>'+
          '<button class="btn ghost" id="closeRole">閉じる</button>'+
        '</div>'+
      '</div>';
    bindTap($("pickField"), function(){ state.ui.roleModal=false; setRole("field"); });
    bindTap($("pickDoctor"), function(){ state.ui.roleModal=false; setRole("doctor"); });
    bindTap($("pickBilling"), function(){ state.ui.roleModal=false; setRole("billing"); });
    bindTap($("closeRole"), closeRoleModal);
  }

  // ---------- summary (sticky) ----------
  function renderSummary(){
    var host = $("summaryHost");
    if(!host) return;
    if(state.role!=="field") { host.style.display="none"; return; }

    var op = findById(M.operators, state.field.operatorId);
    var pt = findById(M.patients, state.field.patientId);
    var pr = findById(M.procedures, state.field.procId);
    var totalQty = 0;
    for(var i=0;i<state.field.items.length;i++){ totalQty += (state.field.items[i].qty||1); }

    var chips = '';
    chips += chip(op ? ("入力者: "+op.name) : "入力者未選択", !op);
    chips += chip(pt ? ("患者: "+pt.name) : "患者未選択", !pt);
    chips += chip(pr ? ("手技: "+pr.name) : "手技未選択", !pr);
    chips += chip("数量合計: "+totalQty, false);

    host.innerHTML =
      '<div class="summaryCard">'+
        '<div class="chipRow">'+chips+'</div>'+
      '</div>';
    host.style.display="block";
  }
  function chip(text, warn){
    return '<span class="chip'+(warn?' warn':'')+'">'+esc(text)+'</span>';
  }

  // ---------- rendering ----------
  function render(){
    if(state.ui.roleModal){ renderRoleModal(); return; }
    renderSummary();

    if(!state.role){
      openRoleModal();
      return;
    }

    if(state.role==="field") renderField();
    else if(state.role==="doctor") renderDoctor();
    else renderBilling();
  }

  // ---------- field flow ----------
  function renderField(){
    // ✅ scan overlay has priority
    if(state.ui.scanOpen){ renderScanOverlay(); return; }

    var host = $("app");
    var step = state.field.step;

    // Use single card per step to avoid scroll
    if(step===1) host.innerHTML = fieldStepOperator();
    else if(step===2) host.innerHTML = fieldStepPatient();
    else if(step===3) host.innerHTML = fieldStepProcedureAndAssist();
    else if(step===5) host.innerHTML = fieldStepConfirm();
    else if(step===6) host.innerHTML = fieldStepApprover();
    else { state.field.step = 1; host.innerHTML = fieldStepOperator(); }

    bindFieldStep();
  }

  function fieldStepOperator(){
    return '<div class="card">'+
      '<div class="h1">実施入力</div>'+
      '<div class="h2">① 入力者</div>'+
      '<select class="select" id="opSel">'+optList(M.operators, state.field.operatorId, function(o){return o.dept+" / "+o.name;})+'</select>'+
      '<div class="divider"></div>'+
      '<button class="btn primary" id="next1">次へ</button>'+
    '</div>';
  }
  function fieldStepPatient(){
    return '<div class="card">'+
      '<div class="h1">実施入力</div>'+
      '<div class="h2">② 患者</div>'+
      '<select class="select" id="ptSel">'+optList(M.patients, state.field.patientId, function(p){return (p.ward? p.ward+" / ":"")+p.name;})+'</select>'+
      '<div class="divider"></div>'+
      '<div class="row">'+
        '<button class="btn" id="back2">戻る</button>'+
        '<button class="btn primary" id="next2">次へ</button>'+
      '</div>'+
    '</div>';
  }
  function fieldStepProcedureAndAssist(){
    var pr = findById(M.procedures, state.field.procId);
    var assist = state.field.assistProcIds.slice(0);
    var assistList = renderAssistPicker(assist);

    // ✅ Suggest becomes prominent after materials are present (even before scan)
    var sug = renderSuggest();

    return '<div class="card">'+
      '<div class="h1">実施入力</div>'+
      '<div class="h2">③ 手技</div>'+
      '<select class="select" id="prSel">'+optList(M.procedures, state.field.procId, function(p){return p.dept+" / "+p.name;})+'</select>'+
      '<div class="divider"></div>'+
      '<div class="h2">補助手技（最大3つ）</div>'+
      '<div class="muted">手技選択後に、補助手技を3つまで選べます。</div>'+
      '<div class="divider"></div>'+
      assistList+
      '<div class="divider"></div>'+
      '<div class="sugBox">'+
        '<div class="h2">⭐ 材料選択後のおすすめ</div>'+
        sug+
        '<div class="sugNote">※ PoC: 材料が増えるほどおすすめが目立つように表示します。</div>'+
      '</div>'+
      '<div class="divider"></div>'+
      '<div class="row">'+
        '<button class="btn" id="back3">戻る</button>'+
        '<button class="btn primary" id="toScan">材料スキャンへ</button>'+
      '</div>'+
    '</div>';
  }

  function renderAssistPicker(selectedIds){
    // PoC: show all procedures as candidates; in real you may filter by dept or category
    var out = '<div class="grid">';
    for(var i=0;i<M.procedures.length;i++){
      var p = M.procedures[i];
      var checked = selectedIds.indexOf(p.id)>=0;
      out += '<label class="listItem" style="align-items:center;">'+
        '<div><b>'+esc(p.name)+'</b><div class="muted">'+esc(p.dept)+'</div></div>'+
        '<input class="check" type="checkbox" data-assist="'+esc(p.id)+'" '+(checked?'checked':'')+' />'+
      '</label>';
    }
    out += '</div>';
    return out;
  }

  function renderSuggest(){
    // ✅ Make it prominent: if there are items, show three chips; else show muted
    if(!state.field.items.length){
      return '<div class="muted">材料を読み取ると、ここにおすすめが表示されます。</div>';
    }
    // Very simple PoC: show top 3 different procedures
    var sug = [];
    for(var i=0;i<M.procedures.length && sug.length<3;i++){
      if(M.procedures[i].id!==state.field.procId) sug.push(M.procedures[i]);
    }
    var chips = '<div class="sugRow">';
    for(var j=0;j<sug.length;j++){
      chips += '<span class="chip warn">おすすめ: '+esc(sug[j].name)+'</span>';
    }
    chips += '</div>';
    return chips;
  }

  function fieldStepConfirm(){
    var items = renderItemsEditable();
    var sug = renderSuggest();
    return '<div class="card">'+
      '<div class="h1">確定前チェック</div>'+
      '<div class="muted">承認済みになるまでは修正できます（数量/削除/追加スキャン）。</div>'+
      '<div class="divider"></div>'+
      items+
      '<div class="divider"></div>'+
      '<div class="sugBox">'+
        '<div class="h2">⭐ おすすめ手技（目立つ）</div>'+
        sug+
      '</div>'+
      '<div class="divider"></div>'+
      '<div class="row">'+
        '<button class="btn" id="back5">戻る</button>'+
        '<button class="btn primary" id="toApprover">承認依頼へ</button>'+
      '</div>'+
      '<div class="divider"></div>'+
      '<div class="row">'+
        '<button class="btn" id="addScan">追加スキャン</button>'+
        '<button class="btn ghost" id="csvField">CSV出力</button>'+
      '</div>'+
    '</div>';
  }

  function fieldStepApprover(){
    var op = findById(M.operators, state.field.operatorId);
    var dept = op ? op.dept : "";
    var docs = M.doctors.slice(0);
    // dept sort first
    docs.sort(function(a,b){
      var aa = (a.dept===dept)?0:1;
      var bb = (b.dept===dept)?0:1;
      if(aa!==bb) return aa-bb;
      return (a.name<b.name)?-1:(a.name>b.name)?1:0;
    });

    return '<div class="card">'+
      '<div class="h1">承認依頼</div>'+
      '<div class="h2">承認医師（診療科優先）</div>'+
      '<select class="select" id="drSel">'+optList(docs, state.field.approverId, function(d){return d.dept+" / "+d.name;})+'</select>'+
      '<div class="divider"></div>'+
      '<div class="row">'+
        '<button class="btn" id="back6">戻る</button>'+
        '<button class="btn primary" id="sendReq">送信</button>'+
      '</div>'+
    '</div>';
  }

  function bindFieldStep(){
    var step = state.field.step;

    if(step===1){
      var s1 = $("opSel");
      if(s1) s1.value = state.field.operatorId || "";
      bindTap($("next1"), function(){
        var v = s1 ? s1.value : "";
        if(!v){ showToast("入力者を選択", "", "", 1400); return; }
        state.field.operatorId = v;
        state.field.step = 2;
        render();
      });
    }

    if(step===2){
      var s2 = $("ptSel");
      if(s2) s2.value = state.field.patientId || "";
      bindTap($("back2"), function(){ state.field.step=1; render(); });
      bindTap($("next2"), function(){
        var v2 = s2 ? s2.value : "";
        if(!v2){ showToast("患者を選択", "", "", 1400); return; }
        state.field.patientId = v2;
        state.field.step = 3;
        render();
      });
    }

    if(step===3){
      var s3 = $("prSel");
      if(s3) s3.value = state.field.procId || "";
      bindTap($("back3"), function(){ state.field.step=2; render(); });

      // assistant selection max 3
      var checks = document.querySelectorAll("input[data-assist]");
      for(var i=0;i<checks.length;i++){
        (function(el){
          el.addEventListener("change", function(){
            var id = el.getAttribute("data-assist");
            var cur = state.field.assistProcIds.slice(0);
            var idx = cur.indexOf(id);
            if(el.checked){
              if(cur.length>=3){
                // revert
                el.checked = false;
                showToast("補助手技は3つまで", "", "", 1500);
                return;
              }
              if(idx<0) cur.push(id);
            }else{
              if(idx>=0) cur.splice(idx,1);
            }
            state.field.assistProcIds = cur;
          }, false);
        })(checks[i]);
      }

      bindTap($("toScan"), function(){
        var v3 = s3 ? s3.value : "";
        if(!v3){ showToast("手技を選択", "", "", 1400); return; }
        state.field.procId = v3;
        // open scan overlay
        openScan();
      });
    }

    if(step===5){
      bindTap($("back5"), function(){ state.field.step=3; render(); });
      bindTap($("toApprover"), function(){
        if(!state.field.items.length){ showToast("材料がありません", "", "", 1400); return; }
        state.field.step=6; render();
      });
      bindTap($("addScan"), function(){ openScan(); });
      bindTap($("csvField"), function(){ exportFieldCsv(); });

      // item edit buttons
      var minus = document.querySelectorAll("[data-minus]");
      var plus = document.querySelectorAll("[data-plus]");
      var del = document.querySelectorAll("[data-del]");
      for(var i2=0;i2<minus.length;i2++){
        (function(el){
          bindTap(el, function(){
            changeQty(el.getAttribute("data-minus"), -1);
          });
        })(minus[i2]);
      }
      for(var j2=0;j2<plus.length;j2++){
        (function(el){
          bindTap(el, function(){
            changeQty(el.getAttribute("data-plus"), +1);
          });
        })(plus[j2]);
      }
      for(var k2=0;k2<del.length;k2++){
        (function(el){
          bindTap(el, function(){
            deleteItem(el.getAttribute("data-del"));
          });
        })(del[k2]);
      }
    }

    if(step===6){
      var dr = $("drSel");
      if(dr) dr.value = state.field.approverId || "";
      bindTap($("back6"), function(){ state.field.step=5; render(); });
      bindTap($("sendReq"), function(){
        var v = dr ? dr.value : "";
        if(!v){ showToast("承認医師を選択", "", "", 1400); return; }
        state.field.approverId = v;
        createApproval();
      });
    }
  }

  function renderItemsEditable(){
    if(!state.field.items.length) return '<div class="muted">材料がありません。追加スキャンしてください。</div>';
    var h = '<div class="grid">';
    for(var i=0;i<state.field.items.length;i++){
      var it = state.field.items[i];
      h += '<div class="listItem">'+
        '<div style="min-width:0;">'+
          '<b>'+esc(it.name || "(辞書なし)")+'</b>'+
          '<div class="muted" style="font-size:13px;">JAN:'+esc(it.jan13||"-")+' / GTIN:'+esc(it.gtin14||"-")+'</div>'+
          '<div class="muted" style="font-size:12px;">'+esc(it.raw||"")+'</div>'+
        '</div>'+
        '<div class="row" style="justify-content:flex-end; gap:8px;">'+
          '<button class="btn small" data-minus="'+esc(it.id)+'">-</button>'+
          '<span class="tag">×'+(it.qty||1)+'</span>'+
          '<button class="btn small" data-plus="'+esc(it.id)+'">+</button>'+
          '<button class="btn small ghost" data-del="'+esc(it.id)+'">削除</button>'+
        '</div>'+
      '</div>';
    }
    h += '</div>';
    return h;
  }

  function changeQty(id, delta){
    for(var i=0;i<state.field.items.length;i++){
      if(state.field.items[i].id===id){
        var q = state.field.items[i].qty || 1;
        q += delta;
        if(q<1) q = 1;
        state.field.items[i].qty = q;
      }
    }
    render();
  }
  function deleteItem(id){
    var out=[];
    for(var i=0;i<state.field.items.length;i++){
      if(state.field.items[i].id!==id) out.push(state.field.items[i]);
    }
    state.field.items=out;
    render();
  }

  function createApproval(){
    var op = findById(M.operators, state.field.operatorId);
    var pt = findById(M.patients, state.field.patientId);
    var pr = findById(M.procedures, state.field.procId);
    var dr = findById(M.doctors, state.field.approverId);

    var assistNames = [];
    for(var i=0;i<state.field.assistProcIds.length;i++){
      var a = findById(M.procedures, state.field.assistProcIds[i]);
      if(a) assistNames.push(a.name);
    }

    state.approvals.unshift({
      id: "AR"+now(),
      createdAt: now(),
      operator: op,
      patient: pt,
      procedure: pr,
      assist: assistNames,
      items: state.field.items.slice(0),
      approver: dr,
      status: "pending",
      approvedAt: null,
      comment: ""
    });

    // reset for next
    state.field.items = [];
    state.field.step = 1;
    state.field.operatorId = "";
    state.field.patientId = "";
    state.field.procId = "";
    state.field.assistProcIds = [];
    state.field.approverId = "";

    showToast("承認依頼を送信", "", "", 1600);
    render();
  }

  function exportFieldCsv(){
    var op = findById(M.operators, state.field.operatorId);
    var pt = findById(M.patients, state.field.patientId);
    var pr = findById(M.procedures, state.field.procId);
    var assist = state.field.assistProcIds.join("|");
    var lines = ["ts,operator,patient,procedure,assist,raw,jan13,gtin14,name,qty"];
    for(var i=0;i<state.field.items.length;i++){
      var it = state.field.items[i];
      lines.push([
        fmtYmdhm(now()),
        (op?op.name:""),
        (pt?pt.name:""),
        (pr?pr.name:""),
        assist,
        (it.raw||"").replace(/"/g,'""'),
        (it.jan13||""),
        (it.gtin14||""),
        (it.name||"").replace(/"/g,'""'),
        (it.qty||1)
      ].map(function(x){ return '"'+String(x)+'"'; }).join(","));
    }
    dlText("field.csv", lines.join("\n"));
  }

  // ---------- scan overlay (no scroll, no popup blocking) ----------
  var scannerInst = null;
  var scanLastEl = null;

  function openScan(){
    state.ui.scanOpen = true;
    state.field.step = 4;
    render();
  }
  function closeScan(){
    state.ui.scanOpen = false;
    stopScanner();
    // go to confirm
    state.field.step = 5;
    render();
  }

  function renderScanOverlay(){
    var host = $("app");
    // Full-screen overlay style via inline container to avoid scroll
    host.innerHTML =
      '<div class="card">'+
        '<div class="row" style="justify-content:space-between; align-items:center;">'+
          '<div>'+
            '<div class="h1" style="margin:0;">材料スキャン</div>'+
            '<div class="muted" style="font-size:12px;">ポップアップは出しません。読み取り結果は下に表示します。</div>'+
          '</div>'+
          '<button class="btn small ghost" id="scanClose">閉じる</button>'+
        '</div>'+
        '<div class="divider"></div>'+
        '<div class="videoBox" id="videoBox">'+
          '<div id="scannerTarget" style="width:100%; height:100%;"></div>'+
        '</div>'+
        '<div class="divider"></div>'+
        '<div class="sugBox" id="scanLast">'+
          '<div class="h2">読み取り結果</div>'+
          '<div class="muted">まだありません</div>'+
        '</div>'+
        '<div class="divider"></div>'+
        '<div class="row">'+
          '<button class="btn" id="scanStop">停止</button>'+
          '<button class="btn primary" id="scanDone">確定</button>'+
        '</div>'+
      '</div>';

    bindTap($("scanClose"), function(){ closeScan(); });
    bindTap($("scanDone"), function(){ closeScan(); });
    bindTap($("scanStop"), function(){ stopScanner(); showToast("スキャン停止", "", "", 1200); });

    scanLastEl = $("scanLast");

    // ✅ clamp video height: avoid going off-screen
    try{
      var vb = $("videoBox");
      if(vb){
        // Keep within viewport: header(74px) + paddings -> about 200px margin
        vb.style.maxHeight = "64vh";
      }
    }catch(e){}

    startScanner();
  }

  function stopScanner(){
    try{
      if(scannerInst && scannerInst.isRunning && scannerInst.isRunning()){
        scannerInst.stop();
      }
    }catch(e){}
    scannerInst = null;
  }

  function startScanner(){
    var target = $("scannerTarget");
    if(!target) return;

    stopScanner();

    scannerInst = new Scanner({
      targetEl: target,
      onDetected: function(res){
        // res: { raw, jan13, gtin14 }
        addScannedItem(res);
      },
      onError: function(err){
        // fallback: show inside scanLast
        if(scanLastEl){
          scanLastEl.innerHTML = '<div class="h2">読み取りエラー</div><div class="muted">'+esc(err && err.message ? err.message : String(err))+'</div>';
        }
      }
    });

    // Start (scan.js handles Quagga2)
    try{
      scannerInst.start();
    }catch(e){
      if(scanLastEl){
        scanLastEl.innerHTML = '<div class="h2">スキャン起動失敗</div><div class="muted">'+esc(e && e.message ? e.message : String(e))+'</div>';
      }
    }
  }

  function addScannedItem(res){
    var raw = res && res.raw ? String(res.raw) : "";
    var jan13 = res && res.jan13 ? res.jan13 : (normalizeJan13(raw) || null);
    var gtin14 = res && res.gtin14 ? res.gtin14 : (parseGS1ForGTIN14(raw) || null);

    // PoC: name placeholder; later replace with dict lookup
    var name = jan13 ? ("JAN:"+jan13) : (gtin14 ? ("GTIN:"+gtin14) : "CODE");

    var item = {
      id: "IT"+now()+"_"+Math.floor(Math.random()*10000),
      ts: now(),
      raw: raw,
      jan13: jan13,
      gtin14: gtin14,
      name: name,
      qty: 1
    };

    // simple de-dup: if same code in last 1s, increment qty
    var last = state.field.items.length ? state.field.items[state.field.items.length-1] : null;
    if(last && (last.jan13 && item.jan13 && last.jan13===item.jan13) && (item.ts-last.ts)<1100){
      last.qty = (last.qty||1) + 1;
    }else{
      state.field.items.push(item);
    }

    // ✅ show result below video (not as toast)
    if(scanLastEl){
      scanLastEl.innerHTML =
        '<div class="h2">読み取り結果</div>'+
        '<div class="listItem" style="margin-top:8px;">'+
          '<div style="min-width:0;">'+
            '<b>'+esc(name)+'</b>'+
            '<div class="muted" style="font-size:13px;">JAN:'+esc(jan13||"-")+' / GTIN:'+esc(gtin14||"-")+'</div>'+
            '<div class="muted" style="font-size:12px;">'+esc(raw)+'</div>'+
          '</div>'+
          '<span class="tag">×'+(state.field.items[state.field.items.length-1].qty||1)+'</span>'+
        '</div>';
    }

    // also update sticky summary counts without scroll
    renderSummary();
  }

  // ---------- doctor ----------
  function renderDoctor(){
    var host = $("app");
    var list = state.approvals.filter(function(a){ return a.status==="pending"; });
    var html = '<div class="card">'+
      '<div class="h1">医師：承認</div>'+
      '<div class="muted">承認待ち一覧（このPoCでは簡易）</div>'+
      '<div class="divider"></div>';

    if(!list.length){
      html += '<div class="muted">承認待ちはありません</div>';
    }else{
      for(var i=0;i<list.length;i++){
        var a=list[i];
        html += '<div class="listItem">'+
          '<div style="min-width:0;">'+
            '<b>'+esc(a.patient ? a.patient.name : "")+'</b>'+
            '<div class="muted" style="font-size:13px;">'+esc(a.procedure ? a.procedure.name : "")+' / '+esc(a.operator ? a.operator.name : "")+'</div>'+
            '<div class="muted" style="font-size:12px;">'+esc(fmtYmdhm(a.createdAt))+'</div>'+
          '</div>'+
          '<button class="btn small primary" data-approve="'+esc(a.id)+'">承認</button>'+
        '</div>';
      }
    }

    html += '</div>';
    host.innerHTML = html;

    // bind approve
    var btns = document.querySelectorAll("[data-approve]");
    for(var j=0;j<btns.length;j++){
      (function(el){
        bindTap(el, function(){
          approve(el.getAttribute("data-approve"));
        });
      })(btns[j]);
    }
  }

  function approve(id){
    for(var i=0;i<state.approvals.length;i++){
      if(state.approvals[i].id===id){
        state.approvals[i].status="approved";
        state.approvals[i].approvedAt=now();
      }
    }
    showToast("承認しました", "", "", 1200);
    render();
  }

  // ---------- billing ----------
  function renderBilling(){
    var host = $("app");
    var html = '<div class="card">'+
      '<div class="h1">医事：閲覧</div>'+
      '<div class="muted">承認済み／承認待ちの文脈を表示（簡易）</div>'+
      '<div class="divider"></div>';

    if(!state.approvals.length){
      html += '<div class="muted">データがありません</div>';
    }else{
      for(var i=0;i<state.approvals.length;i++){
        var a=state.approvals[i];
        html += '<div class="listItem">'+
          '<div style="min-width:0;">'+
            '<b>'+esc(a.patient ? a.patient.name : "")+'</b> <span class="tag">'+esc(a.status)+'</span>'+
            '<div class="muted" style="font-size:13px;">'+
              '手技: '+esc(a.procedure ? a.procedure.name : "")+
              (a.assist && a.assist.length ? (' / 補助: '+esc(a.assist.join("・"))) : '')+
            '</div>'+
            '<div class="muted" style="font-size:12px;">入力: '+esc(a.operator ? a.operator.name : "")+' / 承認: '+esc(a.approver ? a.approver.name : "")+'</div>'+
          '</div>'+
          '<span class="tag">'+(a.items ? a.items.length : 0)+'点</span>'+
        '</div>';
      }
    }
    html += '</div>';
    host.innerHTML = html;
  }

  // ---------- utils ----------
  function optList(arr, selected, labelFn){
    var o = '<option value="">選択してください</option>';
    for(var i=0;i<arr.length;i++){
      var it = arr[i];
      var v = it.id;
      var t = labelFn(it);
      o += '<option value="'+esc(v)+'" '+(String(v)===String(selected)?'selected':'')+'>'+esc(t)+'</option>';
    }
    return o;
  }
  function findById(arr, id){
    for(var i=0;i<arr.length;i++){ if(arr[i].id===id) return arr[i]; }
    return null;
  }

  // ---------- init ----------
  function init(){
    initToast();
    bindTap($("btnRole"), openRoleModal);
    bindTap($("rolePill"), openRoleModal);

    updateRolePill();
    render();
  }

  init();
})();
