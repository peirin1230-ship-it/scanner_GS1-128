(function(){
  "use strict";

  // ---------- helpers ----------
  function $(id){ return document.getElementById(id); }
  function esc(s){
    s = (s==null) ? "" : String(s);
    return s.replace(/[&<>"']/g, function(c){
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]);
    });
  }
  function bindTap(el, fn){
    if(!el) return;
    var lock=false;
    function run(e){
      if(lock) return;
      lock=true;
      try{ fn(e); }catch(ex){ showFatal("UIエラー", ex); }
      setTimeout(function(){ lock=false; }, 200);
    }
    el.addEventListener("click", run, false);
    el.addEventListener("touchend", function(e){ e.preventDefault(); run(e); }, false);
  }
  function now(){ return Date.now(); }
  function fmt(ts){
    var d=new Date(ts);
    function p(n){ return (n<10?"0":"")+n; }
    return d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate())+" "+p(d.getHours())+":"+p(d.getMinutes());
  }
  function safeJsonParse(s, fb){ try{ return JSON.parse(s); }catch(e){ return fb; } }

  // ---------- toast ----------
  var toastEl, toastTitle, toastPrice, toastSub;
  function initToast(){
    toastEl = $("toast");
    toastTitle = $("toastTitle");
    toastPrice = $("toastPrice");
    toastSub = $("toastSub");
  }
  function showToast(title, price, sub, ms){
    if(!toastEl) return;
    toastTitle.textContent = title || "";
    toastPrice.textContent = price || "";
    toastSub.textContent = sub || "";
    toastEl.classList.add("show");
    setTimeout(function(){ toastEl.classList.remove("show"); }, ms || 1400);
  }

  // ---------- fatal ----------
  function showFatal(title, err){
    var app = $("app");
    var msg = (err && err.stack) ? err.stack : String(err||"");
    app.innerHTML =
      '<div class="card">'+
        '<div class="h1" style="color:var(--red)">'+esc(title)+'</div>'+
        '<div class="muted" style="font-size:12px">'+esc(msg)+'</div>'+
        '<div class="divider"></div>'+
        '<div class="muted" style="font-size:12px">Safariキャッシュ対策：URLに <b>?v=数字</b> を付けて開き直してください。</div>'+
      '</div>';
  }
  window.addEventListener("error", function(e){
    try{ showFatal("起動エラー", e.error || e.message || e); }catch(ex){}
  });

  // ---------- storage ----------
  var KEY = {
    role: "linq_role",
    fieldDrafts: "linq_field_drafts",
    approvals: "linq_approvals"
    ,procUsage: "linq_proc_usage"
  };

  // ---------- masters ----------
  var M = {
    doctors: [],
    operators: [],
    patients: [],
    procedures: [],
    billing_map: null,
    standard_builder: null
  };

  function fetchJson(path){
    return fetch(path, {cache:"no-store"}).then(function(r){
      if(!r.ok) throw new Error("fetch failed: "+path+" ("+r.status+")");
      return r.json();
    });
  }

  function loadMasters(){
    return Promise.all([
      fetchJson("./data/doctors.json"),
      fetchJson("./data/operators.json"),
      fetchJson("./data/patients.json"),
      fetchJson("./data/procedures.json"),
      fetchJson("./data/billing_map.json"),
      fetchJson("./data/standard_builder.json")
    ]).then(function(all){
      M.doctors = (all[0]||[]).filter(function(x){ return x && x.active!==false; });
      M.operators = (all[1]||[]).filter(function(x){ return x && x.active!==false; });
      M.patients = (all[2]||[]).filter(function(x){ return x && x.active!==false; });
      M.procedures = (all[3]||[]).filter(function(x){ return x && x.active!==false; });
      M.billing_map = all[4] || {};
      M.standard_builder = all[5] || {};
    });
  }

  function findById(arr, id){
    for(var i=0;i<arr.length;i++){ if(String(arr[i].id)===String(id)) return arr[i]; }
    return null;
  }

  // ---------- state ----------
  var state = {
    role: null, // field|doctor|billing
    view: null, // within role
    modal: null, // {type, ...}

    field: {
      step: 0,
      operatorId: "",
      patientId: "",
      procId: "",
      assistIds: [],
      items: [],
      approverId: ""
    },

    doctor: {
      doctorId: ""
    },

    billing: {
      filter: "approved" // approved|pending
    }
  };

  // approvals: {id, createdAt, status, operatorId, patientId, procId, assistIds, approverId, items[], approvedAt, comment}
  function loadApprovals(){
    var a = safeJsonParse(localStorage.getItem(KEY.approvals), []);
    if(!Array.isArray(a)) a = [];
    return a;
  }
  function saveApprovals(list){
    localStorage.setItem(KEY.approvals, JSON.stringify(list));
  }

  function loadDrafts(){
    var d = safeJsonParse(localStorage.getItem(KEY.fieldDrafts), []);
    if(!Array.isArray(d)) d = [];
    return d;
  }
  function saveDrafts(list){
    localStorage.setItem(KEY.fieldDrafts, JSON.stringify(list));
  
  function loadProcUsage(){
    var u = safeJsonParse(localStorage.getItem(KEY.procUsage), {});
    if(!u || typeof u!=="object") u = {};
    return u;
  }
  function saveProcUsage(u){
    localStorage.setItem(KEY.procUsage, JSON.stringify(u||{}));
  }
  function bumpProcUsage(ids){
    // ids: array of procedure ids
    if(!ids || !ids.length) return;
    var u = loadProcUsage();
    for(var i=0;i<ids.length;i++){
      var k = String(ids[i]);
      u[k] = (u[k]||0)+1;
    }
    saveProcUsage(u);
  }
  function usageScore(id){
    var u = loadProcUsage();
    return u[String(id)] || 0;
  }
  function sortByUsageDesc(list){
    // list: [{id,label}] or ids
    var u = loadProcUsage();
    return list.slice(0).sort(function(a,b){
      var ai = (typeof a==="object") ? String(a.id) : String(a);
      var bi = (typeof b==="object") ? String(b.id) : String(b);
      var av = u[ai]||0;
      var bv = u[bi]||0;
      if(bv!==av) return bv-av;
      return ai<bi ? -1 : (ai>bi ? 1 : 0);
    });
  }

}

  // ---------- role ----------
  function setRole(role){
    state.role = role;
    localStorage.setItem(KEY.role, role);
    updateRolePill();
    // default views
    if(role==="field") state.view = "scan";
    if(role==="doctor") state.view = "approvals";
    if(role==="billing") state.view = "approved";
    render();
  }

  function updateRolePill(){
    var pill = $("rolePill");
    if(!pill) return;
    var label = "未選択";
    if(state.role==="field") label="実施入力";
    if(state.role==="doctor") label="医師";
    if(state.role==="billing") label="医事";
    pill.textContent = "職種："+label;
  }

  // ---------- summary (Field) ----------
  function renderSummary(){
    var op = findById(M.operators, state.field.operatorId);
    var pt = findById(M.patients, state.field.patientId);
    var pr = findById(M.procedures, state.field.procId);

    var qty = 0;
    for(var i=0;i<state.field.items.length;i++){ qty += (state.field.items[i].qty||1); }

    var chips = '';
    chips += '<span class="chip'+(!op?' warn':'')+'">'+esc(op?("入力者:"+op.label):"入力者未選択")+'</span>';
    chips += '<span class="chip'+(!pt?' warn':'')+'">'+esc(pt?("患者:"+pt.label):"患者未選択")+'</span>';
    chips += '<span class="chip'+(!pr?' warn':'')+'">'+esc(pr?("手技:"+pr.label):"手技未選択")+'</span>';
    chips += '<span class="chip">合計:'+qty+'</span>';

    return (
      '<div class="summarySticky">'+
        '<div class="summaryCard"><div class="chipRow">'+chips+'</div></div>'+
      '</div>'
    );
  }

  // ---------- suggest (materials -> procedures) ----------
  function buildSuggest(){
    var sb = M.standard_builder || {};
    var rules = sb.rules || [];
    // build search text from items: name/tokutei_name/raw
    var text = "";
    for(var i=0;i<state.field.items.length;i++){
      var it = state.field.items[i];
      text += " " + (it.name||"") + " " + (it.tokutei_name||"") + " " + (it.raw||"");
    }
    text = text.toLowerCase();

    var suggested = []; // procedure ids
    // rules: matchAny -> suggest[]
    for(var r=0;r<rules.length;r++){
      var rule = rules[r] || {};
      var any = rule.matchAny || [];
      var hit = false;
      for(var k=0;k<any.length;k++){
        var kw = String(any[k]||"").toLowerCase();
        if(kw && text.indexOf(kw)>=0){ hit = true; break; }
      }
      if(hit){
        var sug = rule.suggest || [];
        for(var s=0;s<sug.length;s++){
          var pid = sug[s];
          if(suggested.indexOf(pid)<0) suggested.push(pid);
        }
      }
      if(suggested.length>=6) break;
    }

    // fallback candidates
    if(!suggested.length){
      var def = sb.defaultProcedureCandidates || [];
      for(var d=0;d<def.length && suggested.length<4;d++){
        if(suggested.indexOf(def[d])<0) suggested.push(def[d]);
      }
    }

    // map to labels
    var out = [];
    for(var i2=0;i2<suggested.length;i2++){
      var p = findById(M.procedures, suggested[i2]);
      if(p) out.push(p);
    }
    return out.slice(0,4);
  }

  function renderSuggestBox(){
    if(!state.field.items.length){
      return (
        '<div class="sugBox">'+
          '<div class="h2">⭐ おすすめ手技</div>'+
          '<div class="muted">材料を読み取ると、おすすめが表示されます。</div>'+
        '</div>'
      );
    }
    var sug = buildSuggest();
    var chips = '<div class="sugRow">';
    sug = sortByUsageDesc(sug).slice(0,5);
    for(var i=0;i<sug.length;i++){
      chips += '<button type="button" class="chip warn" data-sug="'+esc(sug[i].id)+'">'+esc(sug[i].label)+'</button>';
    }
    chips += '</div>';
    return (
      '<div class="sugBox">'+
        '<div class="h2">⭐ おすすめ手技</div>'+
        chips+
        '<div class="sugNote">※ タップで主手技に反映</div>'+
      '</div>'
    );
  }

  // ---------- billing map (billing screen only) ----------
  function billingCodeFor(item){
    var bm = M.billing_map || {};
    var byTok = bm.byTokuteiName || {};
    var byProd = bm.byProductName || {};
    var t = (item.tokutei_name||"").toLowerCase();
    var n = (item.name||"").toLowerCase();
    // contains match
    for(var k in byTok){
      if(Object.prototype.hasOwnProperty.call(byTok,k)){
        var kk = String(k).toLowerCase();
        if(kk && t.indexOf(kk)>=0) return byTok[k];
      }
    }
    for(var k2 in byProd){
      if(Object.prototype.hasOwnProperty.call(byProd,k2)){
        var kk2 = String(k2).toLowerCase();
        if(kk2 && n.indexOf(kk2)>=0) return byProd[k2];
      }
    }
    return "";
  }

  // ---------- scan ----------
  var scanner = null;

  function openScan(){
    document.body.classList.add("scan-mode"); // ✅ 固定サマリーのみ消える
    state.field.step = 4;
    render();
    startScanner();
  }
  function closeScan(){
    stopScanner();
    document.body.classList.remove("scan-mode");
    // confirm step
    state.field.step = 5;
    render();
  }

  function startScanner(){
    stopScanner();
    var target = $("scannerTarget");
    if(!target || !window.LinQScanner) return;

    scanner = new window.LinQScanner.Scanner({
      targetEl: target,
      onDetected: function(res){
        // Minimal item: keep raw/jan/gtin; dict lookup can be added later
        var it = {
          id: "it_"+now()+"_"+Math.floor(Math.random()*10000),
          ts: now(),
          raw: res.raw || "",
          jan13: res.jan13 || "",
          gtin14: res.gtin14 || "",
          name: "",          // dict later
          tokutei_name: "",  // dict later
          price: "",         // dict later
          qty: 1
        };

        // simple merge: same code within 1.2s => qty++
        var last = state.field.items.length ? state.field.items[state.field.items.length-1] : null;
        if(last && last.jan13 && it.jan13 && last.jan13===it.jan13 && (it.ts-last.ts)<1200){
          last.qty = (last.qty||1)+1;
        }else{
          state.field.items.push(it);
        }

        // ✅ popup is required
        var title = it.jan13 ? ("JAN "+it.jan13) : (it.gtin14 ? ("GTIN "+it.gtin14) : "CODE");
        showToast("読み取りOK", "", title, 1100);

        // update on-screen count without scrolling
        render(); // scan画面を更新して件数反映
      },
      onError: function(err){
        showToast("スキャンエラー", "", String(err && err.message ? err.message : err), 1400);
      }
    });

    try{ scanner.start(); }catch(e){ showToast("起動失敗", "", String(e), 1500); }
  }

  function stopScanner(){
    try{ if(scanner) scanner.stop(); }catch(e){}
    scanner = null;
  }

  // ---------- Field flow screens ----------
  function renderField(){
    // Field has 3 menus: scan, drafts, done
    var menu =
      '<div class="row">'+
        '<button class="btn small '+(state.view==="scan"?"primary":"")+'" id="mScan">スキャン</button>'+
        '<button class="btn small '+(state.view==="drafts"?"primary":"")+'" id="mDrafts">下書き</button>'+
        '<button class="btn small '+(state.view==="done"?"primary":"")+'" id="mDone">実施済み</button>'+
      '</div>';

    var body = "";
    if(state.view==="scan") body = renderFieldScanFlow();
    else if(state.view==="drafts") body = renderFieldDrafts();
    else body = renderFieldDone();

    return (
      '<div class="card">'+
        '<div class="row space">'+
          '<div><div class="h1">実施入力</div><div class="muted">スクロール不要：一覧のみ内部スクロール</div></div>'+
          '<button class="btn small ghost" id="saveDraft">保存</button>'+
        '</div>'+
        menu+
        '<div class="divider"></div>'+
        (state.view==="scan" ? renderSummary() : "")+
        '<div class="divider"></div>'+
        '<div class="grow">'+body+'</div>'+
      '</div>'
    );
  }

  function renderFieldScanFlow(){
    var step = state.field.step || 1;

    if(step===4){
      // scan screen
      var count = state.field.items.length;
      return (
        '<div style="height:100%; display:flex; flex-direction:column; gap:10px;">'+
          '<div class="row space">'+
            '<div><div class="h2">材料スキャン</div><div class="muted">件数: '+count+'</div></div>'+
            '<button class="btn small ghost" id="scanClose">確定</button>'+
          '</div>'+
          '<div class="videoBox"><div id="scannerTarget"></div></div>'+
          '<div class="row">'+
            '<button class="btn" id="scanStart">開始</button><button class="btn" id="scanStop">停止</button>'+
            '<button class="btn primary" id="scanClose2">確定</button>'+
          '</div>'+
        '</div>'
      );
    }

    if(step===1){
      // operator
      return (
        '<div style="height:100%; display:flex; flex-direction:column; gap:10px;">'+
          '<div class="h2">① 入力者</div>'+
          '<select class="select" id="opSel">'+renderOptions(M.operators, state.field.operatorId, function(x){ return x.label; })+'</select>'+
          '<div style="margin-top:auto" class="row">'+
            '<button class="btn primary" id="next1">次へ</button>'+
          '</div>'+
        '</div>'
      );
    }
    if(step===2){
      // patient
      return (
        '<div style="height:100%; display:flex; flex-direction:column; gap:10px;">'+
          '<div class="h2">② 患者</div>'+
          '<select class="select" id="ptSel">'+renderOptions(M.patients, state.field.patientId, function(x){ return x.label; })+'</select>'+
          '<div style="margin-top:auto" class="row">'+
            '<button class="btn" id="back2">戻る</button>'+
            '<button class="btn primary" id="next2">次へ</button>'+
          '</div>'+
        '</div>'
      );
    }
    if(step===3){
          // suggest chips
          var sugBtns = document.querySelectorAll("[data-sug]");
          for(var si=0; si<sugBtns.length; si++){
            (function(el){
              bindTap(el, function(){
                var pid = el.getAttribute("data-sug");
                if(pid){
                  state.field.procId = pid;
                  if(prSel){ prSel.value = pid; }
                  showToast("主手技に設定", "", el.textContent||"", 900);
                }
              });
            })(sugBtns[si]);
          }

      // procedure + assist(<=3)
      var assistLabels = [];
      for(var i=0;i<state.field.assistIds.length;i++){
        var p = findById(M.procedures, state.field.assistIds[i]);
        if(p) assistLabels.push(p.label);
      }
      var assistChips = assistLabels.length
        ? assistLabels.map(function(t){ return '<span class="chip warn">'+esc(t)+'</span>'; }).join("")
        : '<span class="muted">未選択（最大3つ）</span>';

      return (
        '<div style="height:100%; display:flex; flex-direction:column; gap:10px;">'+
          '<div class="h2">③ 手技</div>'+
          '<select class="select" id="prSel">'+renderOptions(M.procedures, state.field.procId, function(x){ return x.label; })+'</select>'+
          '<div class="divider"></div>'+
          '<div class="h2">補助手技（最大3）</div>'+
          '<div class="listItem" style="align-items:center;">'+
            '<div style="min-width:0"><b>補助手技</b><div class="muted" style="font-size:12px;">タップして選択</div></div>'+
            '<button class="btn small" id="pickAssist">選ぶ</button>'+
          '</div>'+
          '<div class="chipRow">'+assistChips+'</div>'+
          '<div class="divider"></div>'+
          renderSuggestBox()+
          '<div style="margin-top:auto" class="row">'+
            '<button class="btn" id="back3">戻る</button>'+
            '<button class="btn primary" id="toScan">材料スキャンへ</button>'+
          '</div>'+
        '</div>'
      );
    }
    if(step===5){
      // confirm
      return (
        '<div style="height:100%; display:flex; flex-direction:column; gap:10px;">'+
          '<div class="h2">④ 確定前チェック</div>'+
          '<div class="muted" style="font-size:12px;">承認済みになるまでは修正できます</div>'+
          '<div class="divider"></div>'+
          '<div class="scroll" style="flex:1; border:1px solid #f2d2dd; padding:10px;">'+
            renderItemsEditable()+
          '</div>'+
          '<div class="divider"></div>'+
          renderSuggestBox()+
          '<div class="row">'+
            '<button class="btn" id="addScan">追加スキャン</button>'+
            '<button class="btn primary" id="toApprover">承認依頼へ</button>'+
          '</div>'+
        '</div>'
      );
    }
    if(step===6){
      // approver
      return (
        '<div style="height:100%; display:flex; flex-direction:column; gap:10px;">'+
          '<div class="h2">⑤ 承認依頼</div>'+
          '<select class="select" id="drSel">'+renderOptions(M.doctors, state.field.approverId, function(x){ return x.dept+" / "+x.name; })+'</select>'+
          '<div style="margin-top:auto" class="row">'+
            '<button class="btn" id="back6">戻る</button>'+
            '<button class="btn primary" id="sendReq">送信</button>'+
          '</div>'+
        '</div>'
      );
    }

    // fallback
    state.field.step = 1;
    return renderFieldScanFlow();
  }

  function renderOptions(arr, selected, labelFn){
    var h = '<option value="">選択してください</option>';
    for(var i=0;i<arr.length;i++){
      var it = arr[i];
      var v = String(it.id);
      h += '<option value="'+esc(v)+'" '+(String(selected)===v?'selected':'')+'>'+esc(labelFn(it))+'</option>';
    }
    return h;
  }

  function renderItemsEditable(){
    if(!state.field.items.length){
      return '<div class="muted">材料がありません。追加スキャンしてください。</div>';
    }
    var h = '<div class="grid">';
    for(var i=0;i<state.field.items.length;i++){
      var it = state.field.items[i];
      var name = it.name || it.tokutei_name || "(辞書なし)";
      h +=
        '<div class="listItem">'+
          '<div style="min-width:0">'+
            '<b>'+esc(name)+'</b>'+
            '<div class="muted" style="font-size:12px">JAN:'+esc(it.jan13||"-")+' / GTIN:'+esc(it.gtin14||"-")+'</div>'+
            '<div class="muted" style="font-size:12px">'+esc(it.raw||"")+'</div>'+
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
        if(q<1) q=1;
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
    state.field.items = out;
    render();
  }

  function sendApproval(){
    if(!state.field.operatorId || !state.field.patientId || !state.field.procId){
      showToast("入力が不足", "", "入力者/患者/手技を確認", 1400);
      return;
    }
    if(!state.field.approverId){
      showToast("承認医師未選択", "", "", 1400);
      return;
    }
    if(!state.field.items.length){
      showToast("材料がありません", "", "", 1400);
      return;
    }

    var list = loadApprovals();
    list.unshift({
      id: "AR"+now(),
      createdAt: now(),
      status: "pending",
      operatorId: state.field.operatorId,
      patientId: state.field.patientId,
      procId: state.field.procId,
      assistIds: state.field.assistIds.slice(0),
      approverId: state.field.approverId,
      items: state.field.items.slice(0),
      approvedAt: null,
      comment: ""
    });
    saveApprovals(list);

    
    // usage tracking (for top5 suggestions)
    bumpProcUsage([state.field.procId].concat(state.field.assistIds||[]));
// reset for next
    state.field.step = 1;
    state.field.operatorId = "";
    state.field.patientId = "";
    state.field.procId = "";
    state.field.assistIds = [];
    state.field.approverId = "";
    state.field.items = [];

    showToast("承認依頼を送信", "", "", 1200);
    render();
  }

  function saveDraft(){
    var drafts = loadDrafts();
    drafts.unshift({
      id: "DR"+now(),
      savedAt: now(),
      field: JSON.parse(JSON.stringify(state.field))
    });
    drafts = drafts.slice(0,20);
    saveDrafts(drafts);
    showToast("下書きを保存", "", "", 1100);
  }

  function loadDraft(id){
    var drafts = loadDrafts();
    for(var i=0;i<drafts.length;i++){
      if(drafts[i].id===id){
        state.field = drafts[i].field;
        state.view = "scan";
        showToast("下書きを復元", "", "", 1100);
        return;
      }
    }
    showToast("見つかりません", "", "", 1100);
  }

  function deleteDraft(id){
    var drafts = loadDrafts();
    var out=[];
    for(var i=0;i<drafts.length;i++){
      if(drafts[i].id!==id) out.push(drafts[i]);
    }
    saveDrafts(out);
    render();
  }

  function renderFieldDrafts(){
    var drafts = loadDrafts();
    var h = '<div style="height:100%; display:flex; flex-direction:column; gap:10px;">'+
      '<div class="h2">下書き</div>'+
      '<div class="scroll" style="flex:1; border:1px solid #f2d2dd; padding:10px;">';

    if(!drafts.length){
      h += '<div class="muted">下書きはありません</div>';
    }else{
      for(var i=0;i<drafts.length;i++){
        var d = drafts[i];
        h +=
          '<div class="listItem">'+
            '<div style="min-width:0">'+
              '<b>'+esc(d.id)+'</b>'+
              '<div class="muted" style="font-size:12px">'+esc(fmt(d.savedAt))+'</div>'+
            '</div>'+
            '<div class="row" style="gap:8px; justify-content:flex-end">'+
              '<button class="btn small primary" data-load="'+esc(d.id)+'">開く</button>'+
              '<button class="btn small ghost" data-delDraft="'+esc(d.id)+'">削除</button>'+
            '</div>'+
          '</div>';
      }
    }
    h += '</div></div>';
    return h;
  }

  function renderFieldDone(){
    var list = loadApprovals();
    // "当日分のみ" を基本にする（UIイメージ踏襲）
    var today = new Date();
    today.setHours(0,0,0,0);
    var t0 = today.getTime();

    var out = [];
    for(var i=0;i<list.length;i++){
      if(list[i].createdAt >= t0) out.push(list[i]);
    }

    var h = '<div style="height:100%; display:flex; flex-direction:column; gap:10px;">'+
      '<div class="h2">実施済み（当日）</div>'+
      '<div class="scroll" style="flex:1; border:1px solid #f2d2dd; padding:10px;">';

    if(!out.length){
      h += '<div class="muted">当日のデータはありません</div>';
    }else{
      for(var j=0;j<out.length;j++){
        var a = out[j];
        var pt = findById(M.patients, a.patientId);
        var pr = findById(M.procedures, a.procId);
        h +=
          '<div class="listItem">'+
            '<div style="min-width:0">'+
              '<b>'+esc(pt?pt.label:"")+'</b> <span class="tag">'+esc(a.status)+'</span>'+
              '<div class="muted" style="font-size:12px">'+esc(pr?pr.label:"")+' / '+esc(fmt(a.createdAt))+'</div>'+
            '</div>'+
            '<span class="tag">'+(a.items?a.items.length:0)+'点</span>'+
          '</div>';
      }
    }
    h += '</div></div>';
    return h;
  }

  // ---------- Doctor ----------
  function renderDoctor(){
    var menu =
      '<div class="row">'+
        '<button class="btn small '+(state.view==="approvals"?"primary":"")+'" id="dAp">承認依頼</button>'+
        '<button class="btn small '+(state.view==="docs"?"primary":"")+'" id="dDocs">Docs</button>'+
      '</div>';

    var body = (state.view==="docs") ? renderDoctorDocs() : renderDoctorApprovals();

    return (
      '<div class="card">'+
        '<div class="row space">'+
          '<div><div class="h1">医師</div><div class="muted">承認待ち一覧 → 一括承認</div></div>'+
          '<button class="btn small ghost" id="docLogin">医師選択</button>'+
        '</div>'+
        menu+
        '<div class="divider"></div>'+
        '<div class="grow">'+body+'</div>'+
      '</div>'
    );
  }

  function renderDoctorApprovals(){
    var list = loadApprovals();
    // filter by doctor if selected
    var did = state.doctor.doctorId;
    var out = [];
    for(var i=0;i<list.length;i++){
      var a = list[i];
      if(a.status!=="pending") continue;
      if(did && String(a.approverId)!==String(did)) continue;
      out.push(a);
    }

    var h =
      '<div style="height:100%; display:flex; flex-direction:column; gap:10px;">'+
        '<div class="h2">承認待ち</div>'+
        '<div class="row">'+
          '<button class="btn small primary" id="bulkApprove">一括承認</button>'+
          '<span class="muted" style="font-size:12px">チェックしたものを承認</span>'+
        '</div>'+
        '<div class="scroll" style="flex:1; border:1px solid #f2d2dd; padding:10px;">';

    if(!out.length){
      h += '<div class="muted">承認待ちはありません</div>';
    }else{
      for(var j=0;j<out.length;j++){
        var x = out[j];
        var pt = findById(M.patients, x.patientId);
        var pr = findById(M.procedures, x.procId);
        h +=
          '<div class="listItem">'+
            '<div style="min-width:0">'+
              '<b>'+esc(pt?pt.label:"")+'</b>'+
              '<div class="muted" style="font-size:12px">'+esc(pr?pr.label:"")+' / '+esc(fmt(x.createdAt))+'</div>'+
            '</div>'+
            '<div class="row" style="gap:8px; justify-content:flex-end">'+
              '<input type="checkbox" class="check" data-chk="'+esc(x.id)+'" />'+
              '<button class="btn small" data-detail="'+esc(x.id)+'">詳細</button>'+
            '</div>'+
          '</div>';
      }
    }
    h += '</div></div>';
    return h;
  }

  function renderDoctorDocs(){
    // PoC: simple storage per doctor
    var did = state.doctor.doctorId || "none";
    var k = "linq_docs_"+did;
    var v = localStorage.getItem(k) || "";

    return (
      '<div style="height:100%; display:flex; flex-direction:column; gap:10px;">'+
        '<div class="h2">Docs</div>'+
        '<textarea class="input" id="docText" style="flex:1">'+esc(v)+'</textarea>'+
        '<div class="row">'+
          '<button class="btn primary" id="saveDocs">保存</button>'+
        '</div>'+
      '</div>'
    );
  }

  // ---------- Billing ----------
  function renderBilling(){
    var menu =
      '<div class="row">'+
        '<button class="btn small '+(state.view==="approved"?"primary":"")+'" id="bAp">実施入力済み</button>'+
        '<button class="btn small '+(state.view==="pending"?"primary":"")+'" id="bPe">承認待ち</button>'+
        '<button class="btn small '+(state.view==="master"?"primary":"")+'" id="bMs">マスタメンテ</button>'+
      '</div>';

    var body = "";
    if(state.view==="master") body = renderBillingMaster();
    else body = renderBillingList(state.view);

    return (
      '<div class="card">'+
        '<div class="row space">'+
          '<div><div class="h1">医事課</div><div class="muted">医事コードはここだけ表示</div></div>'+
        '</div>'+
        menu+
        '<div class="divider"></div>'+
        '<div class="grow">'+body+'</div>'+
      '</div>'
    );
  }

  function renderBillingList(mode){
    var list = loadApprovals();
    var out = [];
    for(var i=0;i<list.length;i++){
      if(mode==="approved" && list[i].status==="approved") out.push(list[i]);
      if(mode==="pending" && list[i].status==="pending") out.push(list[i]);
    }

    var h =
      '<div style="height:100%; display:flex; flex-direction:column; gap:10px;">'+
        '<div class="h2">'+(mode==="approved"?"実施入力済み（承認済）":"承認待ち")+'</div>'+
        '<div class="scroll" style="flex:1; border:1px solid #f2d2dd; padding:10px;">';

    if(!out.length){
      h += '<div class="muted">データがありません</div>';
    }else{
      for(var j=0;j<out.length;j++){
        var a = out[j];
        var pt = findById(M.patients, a.patientId);
        var pr = findById(M.procedures, a.procId);
        var op = findById(M.operators, a.operatorId);
        var dr = findById(M.doctors, a.approverId);

        h +=
          '<div class="listItem">'+
            '<div style="min-width:0">'+
              '<b>'+esc(pt?pt.label:"")+'</b> <span class="tag">'+esc(a.status)+'</span>'+
              '<div class="muted" style="font-size:12px">手技: '+esc(pr?pr.label:"")+'</div>'+
              '<div class="muted" style="font-size:12px">入力: '+esc(op?op.label:"")+' / 承認: '+esc(dr?dr.name:"")+'</div>'+
              '<div class="muted" style="font-size:12px">'+esc(fmt(a.createdAt))+'</div>'+
            '</div>'+
            '<button class="btn small" data-bdetail="'+esc(a.id)+'">詳細</button>'+
          '</div>';
      }
    }
    h += '</div></div>';
    return h;
  }

  function renderBillingMaster(){
    // PoC: show standard_builder summary only (edit is later)
    var sb = M.standard_builder || {};
    var rules = sb.rules || [];
    return (
      '<div style="height:100%; display:flex; flex-direction:column; gap:10px;">'+
        '<div class="h2">マスタメンテ（PoC）</div>'+
        '<div class="muted" style="font-size:12px">standard_builder のルール数: '+rules.length+'</div>'+
        '<div class="scroll" style="flex:1; border:1px solid #f2d2dd; padding:10px;">'+
          '<div class="muted" style="font-size:12px">'+esc(JSON.stringify({ defaultProcedureCandidates: sb.defaultProcedureCandidates||[], rulesCount: rules.length }, null, 2))+'</div>'+
        '</div>'+
      '</div>'
    );
  }

  // ---------- modals ----------
  function openRoleModal(){
    state.modal = { type:"role" };
    render();
  }

  function openAssistModal(){
    state.modal = { type:"assist" };
    render();
  }

  function openDoctorSelect(){
    state.modal = { type:"doctorSelect" };
    render();
  }

  function openDoctorDetail(id){
    state.modal = { type:"doctorDetail", id:id };
    render();
  }

  function openBillingDetail(id){
    state.modal = { type:"billingDetail", id:id };
    render();
  }

  function closeModal(){
    state.modal = null;
    render();
  }

  function renderModal(){
    if(!state.modal) return "";

    if(state.modal.type==="role"){
      return (
        '<div class="modal"><div class="panel">'+
          '<div class="card">'+
            '<div class="h1">職種を選択</div>'+
            '<div class="grid">'+
              '<button class="btn primary" id="rField">実施入力</button>'+
              '<button class="btn" id="rDoctor">医師</button>'+
              '<button class="btn" id="rBilling">医事課</button>'+
              '<button class="btn ghost" id="rClose">閉じる</button>'+
            '</div>'+
          '</div>'+
        '</div></div>'
      );
    }

    if(state.modal.type==="assist"){
      var selected = state.field.assistIds.slice(0);
      var selected = state.field.assistIds.slice(0);
      var listAll = M.procedures.slice(0);
      // main 제외
      var list = [];
      for(var li=0; li<listAll.length; li++){
        var pp = listAll[li];
        if(String(pp.id)===String(state.field.procId)) continue;
        list.push(pp);
      }
      // default: top5 by usage
      var showAll = !!state.modal.showAll;
      if(!showAll){ list = sortByUsageDesc(list).slice(0,5); }


      var items = "";
      for(var i=0;i<list.length;i++){
        var p = list[i];
        var checked = selected.indexOf(p.id)>=0;
        items +=
          '<label class="listItem" style="align-items:center;">'+
            '<div style="min-width:0"><b>'+esc(p.label)+'</b></div>'+
            '<input type="checkbox" class="check" data-ast="'+esc(p.id)+'" '+(checked?'checked':'')+' />'+
          '</label>';
      }

      return (
        '<div class="modal"><div class="panel">'+
          '<div class="card">'+
            '<div class="row space">'+
              '<div><div class="h1">補助手技</div><div class="muted">最大3つまで</div></div>'+
              '<button class="btn small ghost" id="aClose">閉じる</button>'+
            '</div>'+
            '<div class="scroll" style="flex:1; border:1px solid #f2d2dd; padding:10px;">'+
              '<div class="grid">'+items+'</div>'+
            '</div>'+
            '<div class="row">'+
              '<button class="btn primary" id="aDone">確定</button>'+
            '</div>'+
          '</div>'+
        '</div></div>'
      );
    }

    if(state.modal.type==="doctorSelect"){
      return (
        '<div class="modal"><div class="panel">'+
          '<div class="card">'+
            '<div class="row space">'+
              '<div><div class="h1">医師選択</div><div class="muted">承認一覧のフィルタ</div></div>'+
              '<button class="btn small ghost" id="dsClose">閉じる</button>'+
            '</div>'+
            '<select class="select" id="docSel">'+renderOptions(M.doctors, state.doctor.doctorId, function(x){ return x.dept+" / "+x.name; })+'</select>'+
            '<div class="row">'+
              '<button class="btn primary" id="dsOk">確定</button>'+
            '</div>'+
          '</div>'+
        '</div></div>'
      );
    }

    if(state.modal.type==="doctorDetail"){
      var list = loadApprovals();
      var a = null;
      for(var i2=0;i2<list.length;i2++){ if(list[i2].id===state.modal.id){ a=list[i2]; break; } }
      if(!a) return "";
      var pt = findById(M.patients, a.patientId);
      var pr = findById(M.procedures, a.procId);
      var items2 = "";
      for(var j=0;j<(a.items||[]).length;j++){
        var it = a.items[j];
        var name = it.name || it.tokutei_name || "(辞書なし)";
        items2 +=
          '<div class="listItem">'+
            '<div style="min-width:0">'+
              '<b>'+esc(name)+'</b>'+
              '<div class="muted" style="font-size:12px">JAN:'+esc(it.jan13||"-")+' / GTIN:'+esc(it.gtin14||"-")+'</div>'+
            '</div>'+
            '<span class="tag">×'+(it.qty||1)+'</span>'+
          '</div>';
      }
      return (
        '<div class="modal"><div class="panel">'+
          '<div class="card">'+
            '<div class="row space">'+
              '<div><div class="h1">承認 詳細</div><div class="muted">'+esc(pt?pt.label:"")+' / '+esc(pr?pr.label:"")+'</div></div>'+
              '<button class="btn small ghost" id="ddClose">閉じる</button>'+
            '</div>'+
            '<textarea class="input" id="ddComment" placeholder="コメント（任意）" style="flex:0 0 auto"></textarea>'+
            '<div class="scroll" style="flex:1; border:1px solid #f2d2dd; padding:10px;">'+
              '<div class="grid">'+items2+'</div>'+
            '</div>'+
            '<div class="row">'+
              '<button class="btn primary" id="ddApprove">承認</button>'+
            '</div>'+
          '</div>'+
        '</div></div>'
      );
    }

    if(state.modal.type==="billingDetail"){
      var list3 = loadApprovals();
      var a3 = null;
      for(var i3=0;i3<list3.length;i3++){ if(list3[i3].id===state.modal.id){ a3=list3[i3]; break; } }
      if(!a3) return "";
      var pt3 = findById(M.patients, a3.patientId);
      var pr3 = findById(M.procedures, a3.procId);

      var items3 = "";
      for(var j3=0;j3<(a3.items||[]).length;j3++){
        var it3 = a3.items[j3];
        var name3 = it3.name || it3.tokutei_name || "(辞書なし)";
        var code = billingCodeFor(it3);
        items3 +=
          '<div class="listItem">'+
            '<div style="min-width:0">'+
              '<b>'+esc(name3)+'</b>'+
              '<div class="muted" style="font-size:12px">償還:'+esc(it3.tokutei_name||"-")+'</div>'+
              '<div class="muted" style="font-size:12px">価格:'+esc(it3.price||"-")+'</div>'+
            '</div>'+
            '<span class="tag">'+esc(code||"-")+'</span>'+
          '</div>';
      }

      return (
        '<div class="modal"><div class="panel">'+
          '<div class="card">'+
            '<div class="row space">'+
              '<div><div class="h1">医事 詳細</div><div class="muted">'+esc(pt3?pt3.label:"")+' / '+esc(pr3?pr3.label:"")+'</div></div>'+
              '<button class="btn small ghost" id="bdClose">閉じる</button>'+
            '</div>'+
            '<div class="scroll" style="flex:1; border:1px solid #f2d2dd; padding:10px;">'+
              '<div class="grid">'+items3+'</div>'+
            '</div>'+
          '</div>'+
        '</div></div>'
      );
    }

    return "";
  }

  // ---------- render root ----------
  function render(){
    var app = $("app");
    if(!app) return;

    // base view
    var html = "";
    if(!state.role){
      html = '<div class="card"><div class="h1">起動</div><div class="muted">職種を選択してください</div><div class="divider"></div><button class="btn primary" id="goRole">職種選択</button></div>';
    }


    if(state.role==="field") html = renderField();
    else if(state.role==="doctor") html = renderDoctor();
    else if(state.role==="billing") html = renderBilling();
    // else: keep startup view
    

    // attach modal if any
    var modal = renderModal();
    app.innerHTML = html + modal;

    
    if($("goRole")) bindTap($("goRole"), openRoleModal);
// top pill
    updateRolePill();

    // bind global
    bindTap($("rolePill"), openRoleModal);

    // role modal binds
    if(state.modal && state.modal.type==="role"){
      bindTap($("rField"), function(){ closeModal(); setRole("field"); });
      bindTap($("rDoctor"), function(){ closeModal(); setRole("doctor"); });
      bindTap($("rBilling"), function(){ closeModal(); setRole("billing"); });
      bindTap($("rClose"), closeModal);
    }

    // assist modal binds
    if(state.modal && state.modal.type==="assist"){
      bindTap($("aClose"), closeModal);
      bindTap($("aDone"), function(){ closeModal(); render(); });
      var checks = document.querySelectorAll("input[data-ast]");
      for(var i=0;i<checks.length;i++){
        (function(el){
          el.addEventListener("change", function(){
            var id = el.getAttribute("data-ast");
            var cur = state.field.assistIds.slice(0);
            var idx = cur.indexOf(id);
            if(el.checked){
              if(cur.length>=3){
                el.checked = false;
                showToast("補助手技は3つまで", "", "", 1200);
                return;
              }
              if(idx<0) cur.push(id);
            }else{
              if(idx>=0) cur.splice(idx,1);
            }
            state.field.assistIds = cur;
          }, false);
        })(checks[i]);
      }
    }

    // doctor select
    if(state.modal && state.modal.type==="doctorSelect"){
      bindTap($("dsClose"), closeModal);
      bindTap($("dsOk"), function(){
        var s = $("docSel");
        state.doctor.doctorId = s ? s.value : "";
        closeModal();
      });
    }

    // doctor detail
    if(state.modal && state.modal.type==="doctorDetail"){
      bindTap($("ddClose"), closeModal);
      bindTap($("ddApprove"), function(){
        var c = $("ddComment");
        var comment = c ? c.value : "";
        var list = loadApprovals();
        for(var i2=0;i2<list.length;i2++){
          if(list[i2].id===state.modal.id){
            list[i2].status = "approved";
            list[i2].approvedAt = now();
            list[i2].comment = comment;
          }
        }
        saveApprovals(list);
        showToast("承認しました", "", "", 1200);
        closeModal();
      });
    }

    // billing detail
    if(state.modal && state.modal.type==="billingDetail"){
      bindTap($("bdClose"), closeModal);
    }

    // role-specific binds
    if(state.role==="field"){
      bindTap($("mScan"), function(){ state.view="scan"; render(); });
      bindTap($("mDrafts"), function(){ state.view="drafts"; render(); });
      bindTap($("mDone"), function(){ state.view="done"; render(); });
      bindTap($("saveDraft"), saveDraft);

      // step binds
      if(state.view==="scan"){
        var step = state.field.step || 1;

        if(step===1){
          var opSel = $("opSel");
          if(opSel) opSel.value = state.field.operatorId || "";
          bindTap($("next1"), function(){
            var v = opSel ? opSel.value : "";
            if(!v){ showToast("入力者を選択", "", "", 1200); return; }
            state.field.operatorId = v;
            state.field.step = 2;
            render();
          });
        }

        if(step===2){
          var ptSel = $("ptSel");
          if(ptSel) ptSel.value = state.field.patientId || "";
          bindTap($("back2"), function(){ state.field.step=1; render(); });
          bindTap($("next2"), function(){
            var v2 = ptSel ? ptSel.value : "";
            if(!v2){ showToast("患者を選択", "", "", 1200); return; }
            state.field.patientId = v2;
            state.field.step = 3;
            render();
          });
        }

        if(step===3){
          // suggest chips
          var sugBtns = document.querySelectorAll("[data-sug]");
          for(var si=0; si<sugBtns.length; si++){
            (function(el){
              bindTap(el, function(){
                var pid = el.getAttribute("data-sug");
                if(pid){
                  state.field.procId = pid;
                  if(prSel){ prSel.value = pid; }
                  showToast("主手技に設定", "", el.textContent||"", 900);
                }
              });
            })(sugBtns[si]);
          }

          var prSel = $("prSel");
          if(prSel) prSel.value = state.field.procId || "";
          bindTap($("back3"), function(){ state.field.step=2; render(); });
          bindTap($("pickAssist"), function(){
            var v3 = prSel ? prSel.value : "";
            if(!v3){ showToast("先に主手技を選択", "", "", 1200); return; }
            state.field.procId = v3;
            openAssistModal();
          });
          bindTap($("toScan"), function(){
            var v4 = prSel ? prSel.value : "";
            if(!v4){ showToast("手技を選択", "", "", 1200); return; }
            state.field.procId = v4;
            openScan();
          });
        }

        if(step===4){
          bindTap($("scanStart"), function(){ startScanner(); showToast("開始", "", "", 700); });
          bindTap($("scanStop"), function(){ stopScanner(); showToast("停止", "", "", 900); });
          bindTap($("scanClose"), closeScan);
          bindTap($("scanClose2"), closeScan);
        }

        if(step===5){
          bindTap($("addScan"), openScan);
          bindTap($("toApprover"), function(){
            if(!state.field.items.length){ showToast("材料がありません", "", "", 1200); return; }
            state.field.step = 6;
            render();
          });

          // item buttons
          var minus = document.querySelectorAll("[data-minus]");
          var plus = document.querySelectorAll("[data-plus]");
          var del = document.querySelectorAll("[data-del]");
          for(var i5=0;i5<minus.length;i5++){
            (function(el){ bindTap(el, function(){ changeQty(el.getAttribute("data-minus"), -1); }); })(minus[i5]);
          }
          for(var j5=0;j5<plus.length;j5++){
            (function(el){ bindTap(el, function(){ changeQty(el.getAttribute("data-plus"), +1); }); })(plus[j5]);
          }
          for(var k5=0;k5<del.length;k5++){
            (function(el){ bindTap(el, function(){ deleteItem(el.getAttribute("data-del")); }); })(del[k5]);
          }
        }

        if(step===6){
          var drSel = $("drSel");
          if(drSel) drSel.value = state.field.approverId || "";
          bindTap($("back6"), function(){ state.field.step=5; render(); });
          bindTap($("sendReq"), function(){
            var v6 = drSel ? drSel.value : "";
            if(!v6){ showToast("承認医師を選択", "", "", 1200); return; }
            state.field.approverId = v6;
            sendApproval();
          });
        }
      }

      if(state.view==="drafts"){
        var loads = document.querySelectorAll("[data-load]");
        var dels = document.querySelectorAll("[data-delDraft]");
        for(var d=0; d<loads.length; d++){
          (function(el){ bindTap(el, function(){ loadDraft(el.getAttribute("data-load")); render(); }); })(loads[d]);
        }
        for(var dd=0; dd<dels.length; dd++){
          (function(el){ bindTap(el, function(){ deleteDraft(el.getAttribute("data-delDraft")); }); })(dels[dd]);
        }
      }
    }

    if(state.role==="doctor"){
      bindTap($("dAp"), function(){ state.view="approvals"; render(); });
      bindTap($("dDocs"), function(){ state.view="docs"; render(); });
      bindTap($("docLogin"), openDoctorSelect);

      if(state.view==="approvals"){
        bindTap($("bulkApprove"), function(){
          var chks = document.querySelectorAll("input[data-chk]");
          var ids = [];
          for(var i=0;i<chks.length;i++){
            if(chks[i].checked) ids.push(chks[i].getAttribute("data-chk"));
          }
          if(!ids.length){ showToast("選択なし", "", "", 1000); return; }
          var list = loadApprovals();
          for(var j=0;j<list.length;j++){
            if(ids.indexOf(list[j].id)>=0){
              list[j].status="approved";
              list[j].approvedAt=now();
            }
          }
          saveApprovals(list);
          showToast("一括承認", "", "", 1100);
          render();
        });

        var details = document.querySelectorAll("[data-detail]");
        for(var k=0;k<details.length;k++){
          (function(el){
            bindTap(el, function(){ openDoctorDetail(el.getAttribute("data-detail")); });
          })(details[k]);
        }
      }

      if(state.view==="docs"){
        bindTap($("saveDocs"), function(){
          var did = state.doctor.doctorId || "none";
          var k = "linq_docs_"+did;
          var t = $("docText");
          localStorage.setItem(k, t ? t.value : "");
          showToast("保存しました", "", "", 1000);
        });
      }
    }

    if(state.role==="billing"){
      bindTap($("bAp"), function(){ state.view="approved"; render(); });
      bindTap($("bPe"), function(){ state.view="pending"; render(); });
      bindTap($("bMs"), function(){ state.view="master"; render(); });

      var bd = document.querySelectorAll("[data-bdetail]");
      for(var z=0;z<bd.length;z++){
        (function(el){
          bindTap(el, function(){ openBillingDetail(el.getAttribute("data-bdetail")); });
        })(bd[z]);
      }
    }
  }

  // ---------- init ----------
  function init(){
    initToast();
    $("build").textContent = "BUILD: v236f-app (buttons)";

    
    // header button (optional)
    if($("roleChangeBtn")) bindTap($("roleChangeBtn"), openRoleModal);
    if($("btnRole")) bindTap($("btnRole"), openRoleModal);
// restore role
    var r = localStorage.getItem(KEY.role);
    if(r==="field" || r==="doctor" || r==="billing"){
      state.role = r;
      if(r==="field") state.view="scan";
      if(r==="doctor") state.view="approvals";
      if(r==="billing") state.view="approved";
    }

    updateRolePill();

    loadMasters().then(function(){
      // start field at step1
      if(state.role==="field"){
        state.field.step = state.field.step || 1;
      }
      render();
      // first-time role select if none
      if(!state.role) openRoleModal();
    }).catch(function(e){
      showFatal("マスタ読み込み失敗", e);
    });
  }

  init();
}


  function setBottomBar(buttons){
    // buttons: [{label, id, primary, onClick}]
    var bar = $("bottomBar");
    var row = $("bottomBarRow");
    if(!bar || !row){ return; }
    row.innerHTML = "";
    if(!buttons || !buttons.length){
      bar.classList.remove("show");
      return;
    }
    buttons.forEach(function(b){
      var btn = document.createElement("button");
      btn.className = "btn" + (b.primary ? " primary" : "");
      btn.textContent = b.label;
      btn.id = b.id;
      row.appendChild(btn);
      bindTap(btn, b.onClick);
    });
    bar.classList.add("show");
  }

)();