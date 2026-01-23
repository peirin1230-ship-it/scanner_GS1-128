/* LinQ VAL PoC app.js (v26c_001) - Safari互換優先 */
/* global Scanner */
'use strict';

(function () {
  // ========= small utils =========
  function $(id) { return document.getElementById(id); }
  function escapeHtml(s) {
    s = (s == null) ? '' : String(s);
    return s.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
  }
  function pad2(n){ n = String(n); return (n.length === 1) ? ('0' + n) : n; }
  function fmtTs(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    return d.getFullYear() + '-' + pad2(d.getMonth()+1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function uid(prefix) {
    return (prefix || 'id') + '_' + (new Date().getTime()) + '_' + Math.floor(Math.random() * 100000);
  }
  function safeJsonParse(s, fallback) {
    try { return JSON.parse(s); } catch (e) { return fallback; }
  }
  function toast(msg, ms) {
    var el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.style.display = 'block';
    var t = setTimeout(function () {
      try { el.style.display = 'none'; } catch (e) {}
      clearTimeout(t);
    }, ms != null ? ms : 1800);
  }
  function fatal(title, err) {
    var el = $('fatal');
    if (!el) return;
    el.style.display = 'block';
    var msg = '';
    if (err) {
      if (err && err.stack) msg = String(err.stack);
      else msg = String(err);
    }
    el.innerHTML =
      '<div class="fatalTitle">' + escapeHtml(title || '起動エラー') + '</div>' +
      '<div class="fatalMsg">' + escapeHtml(msg) + '</div>' +
      '<div class="hr"></div>' +
      '<div class="small">Safariのキャッシュが強いので、URLに <b>?v=数字</b> を付けて再読み込みしてください。</div>';
  }

  // ========= storage =========
  var K = {
    DRAFTS: 'VAL_FIELD_DRAFTS_v1',
    PENDING: 'VAL_APPROVAL_PENDING_v1',
    APPROVED: 'VAL_APPROVAL_APPROVED_v1',
    RECENT_APPROVERS: 'VAL_RECENT_APPROVERS_v1',
    DOCS: 'VAL_DOCTOR_DOCS_v1'
  };

  var Storage = {
    getObj: function (key, fallback) {
      var s = null;
      try { s = localStorage.getItem(key); } catch (e) { return fallback; }
      if (!s) return fallback;
      return safeJsonParse(s, fallback);
    },
    setObj: function (key, obj) {
      try { localStorage.setItem(key, JSON.stringify(obj)); } catch (e) {}
    }
  };

  // ========= masters =========
  var Masters = {
    doctors: [],
    operators: [],
    patients: [],
    procedures: [],
    billingMap: [],
    standardBuilder: [],

    loadAll: function () {
      var base = './data/';
      var ps = [];
      ps.push(fetch(base + 'doctors.json').then(function (r) { return r.json(); }).then(function (j) { Masters.doctors = j || []; }));
      ps.push(fetch(base + 'operators.json').then(function (r) { return r.json(); }).then(function (j) { Masters.operators = j || []; }));
      ps.push(fetch(base + 'patients.json').then(function (r) { return r.json(); }).then(function (j) { Masters.patients = j || []; }));
      ps.push(fetch(base + 'procedures.json').then(function (r) { return r.json(); }).then(function (j) { Masters.procedures = j || []; }));
      ps.push(fetch(base + 'billing_map.json').then(function (r) { return r.json(); }).then(function (j) { Masters.billingMap = j || []; }));
      ps.push(fetch(base + 'standard_builder.json').then(function (r) { return r.json(); }).then(function (j) { Masters.standardBuilder = j || []; }));
      return Promise.all(ps);
    },

    findDoctor: function (doctorId) {
      var i;
      for (i = 0; i < Masters.doctors.length; i++) {
        if (Masters.doctors[i] && Masters.doctors[i].doctorId === doctorId) return Masters.doctors[i];
      }
      return null;
    },
    findOperator: function (operatorId) {
      var i;
      for (i = 0; i < Masters.operators.length; i++) {
        if (Masters.operators[i] && Masters.operators[i].operatorId === operatorId) return Masters.operators[i];
      }
      return null;
    },
    findPatient: function (patientId) {
      var i;
      for (i = 0; i < Masters.patients.length; i++) {
        if (Masters.patients[i] && Masters.patients[i].patientId === patientId) return Masters.patients[i];
      }
      return null;
    },
    findProcedure: function (procId) {
      var i;
      for (i = 0; i < Masters.procedures.length; i++) {
        if (Masters.procedures[i] && Masters.procedures[i].procId === procId) return Masters.procedures[i];
      }
      return null;
    },
    findBillingByProc: function (procId) {
      var i;
      for (i = 0; i < Masters.billingMap.length; i++) {
        if (Masters.billingMap[i] && Masters.billingMap[i].procId === procId) return Masters.billingMap[i];
      }
      return null;
    }
  };

  // ========= Dict lookup (CSV) =========
  function csvSplitLine(line) {
    // 超簡易CSV（ダブルクオート対応の最低限）
    var out = [];
    var cur = '';
    var inQ = false;
    var i;
    for (i = 0; i < line.length; i++) {
      var ch = line.charAt(i);
      if (ch === '"') {
        if (inQ && i + 1 < line.length && line.charAt(i + 1) === '"') {
          cur += '"';
          i += 1;
        } else {
          inQ = !inQ;
        }
      } else if (ch === ',' && !inQ) {
        out.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out;
  }

  function findColIndex(headers, candidates) {
    var i, j;
    for (i = 0; i < headers.length; i++) {
      var h = String(headers[i] || '').trim().toLowerCase();
      for (j = 0; j < candidates.length; j++) {
        var c = String(candidates[j]).trim().toLowerCase();
        if (h === c) return i;
      }
    }
    return -1;
  }

  function buildItemFromRow(payload, headers, row) {
    var idxJan = findColIndex(headers, ['jan', 'jan13', 'jancode', 'jan_code', 'janコード']);
    var idxName = findColIndex(headers, ['name', '商品名', 'product_name']);
    var idxMaker = findColIndex(headers, ['maker', 'メーカー', 'メーカー名', 'manufacturer']);
    var idxProductNo = findColIndex(headers, ['product_no', '製品番号', '品番', 'model']);
    var idxSpec = findColIndex(headers, ['spec', '規格', 'サイズ', '容量']);
    var idxTokutei = findColIndex(headers, ['tokutei_name', 'tokuteiname', '償還名称', '通称', 'reimb_name']);
    var idxReimb = findColIndex(headers, ['total_reimbursement_price_yen', 'reimbursement_price_yen', '償還価格', 'reimb_yen', 'price_yen']);

    var item = {
      lineId: uid('li'),
      raw: payload.raw || '',
      jan13: payload.jan13 || null,
      gtin14: payload.gtin14 || null,
      name: '',
      maker: '',
      productNo: '',
      spec: '',
      tokuteiName: '',
      reimbYen: 0,
      qty: 1,
      dictStatus: 'ok'
    };

    if (idxName >= 0) item.name = row[idxName] || '';
    if (idxMaker >= 0) item.maker = row[idxMaker] || '';
    if (idxProductNo >= 0) item.productNo = row[idxProductNo] || '';
    if (idxSpec >= 0) item.spec = row[idxSpec] || '';
    if (idxTokutei >= 0) item.tokuteiName = row[idxTokutei] || '';
    if (idxReimb >= 0) {
      var v = String(row[idxReimb] || '').replace(/[^0-9]/g, '');
      item.reimbYen = v ? parseInt(v, 10) : 0;
    }

    // jan列があれば正規化して入れる
    if (idxJan >= 0) {
      var j = String(row[idxJan] || '').replace(/[^0-9]/g, '');
      if (j && j.length === 13) item.jan13 = j;
    }

    return item;
  }

  function fetchText(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) {
        var e = new Error('fetch failed: ' + url + ' status=' + r.status);
        e._status = r.status;
        throw e;
      }
      return r.text();
    });
  }

  function lookupJanInDict(jan13) {
    // dict_jan/<jan3>/<jan4>.csv
    var jan = String(jan13 || '').replace(/[^0-9]/g, '');
    if (jan.length !== 13) return Promise.resolve({ status: 'no_match', item: null });

    var jan3 = jan.substring(0, 3);
    var jan4 = jan.substring(0, 4);
    var url = './dict_jan/' + jan3 + '/' + jan4 + '.csv';

    return fetchText(url).then(function (txt) {
      var lines = txt.split(/\r?\n/);
      if (!lines || lines.length < 2) return { status: 'no_match', item: null };

      var headers = csvSplitLine(lines[0]);
      var idxJan = findColIndex(headers, ['jan', 'jan13', 'jancode', 'jan_code', 'janコード']);
      if (idxJan < 0) idxJan = 0; // 最低限：先頭列にJANがある想定

      var i;
      for (i = 1; i < lines.length; i++) {
        var line = lines[i];
        if (!line) continue;
        var row = csvSplitLine(line);
        var j = String(row[idxJan] || '').replace(/[^0-9]/g, '');
        if (j === jan) {
          return { status: 'ok', headers: headers, row: row };
        }
      }
      return { status: 'no_match', item: null, headers: headers };
    });
  }

  function lookupGtinToJan(gtin14) {
    // gtin_index/<gt3>/<gt4>.csv から JAN を引く
    var g = String(gtin14 || '').replace(/[^0-9]/g, '');
    if (g.length !== 14) return Promise.resolve({ status: 'no_match', jan13: null });

    var gt3 = g.substring(0, 3);
    var gt4 = g.substring(0, 4);
    var url = './gtin_index/' + gt3 + '/' + gt4 + '.csv';

    return fetchText(url).then(function (txt) {
      var lines = txt.split(/\r?\n/);
      if (!lines || lines.length < 2) return { status: 'no_match', jan13: null };

      var headers = csvSplitLine(lines[0]);
      var idxG = findColIndex(headers, ['gtin14', 'gtin', 'ai01', '01']);
      var idxJ = findColIndex(headers, ['jan', 'jan13', 'jancode', 'jan_code', 'janコード']);

      if (idxG < 0) idxG = 0;
      if (idxJ < 0) idxJ = 1;

      var i;
      for (i = 1; i < lines.length; i++) {
        var line = lines[i];
        if (!line) continue;
        var row = csvSplitLine(line);
        var gg = String(row[idxG] || '').replace(/[^0-9]/g, '');
        if (gg === g) {
          var jj = String(row[idxJ] || '').replace(/[^0-9]/g, '');
          if (jj && jj.length === 13) return { status: 'ok', jan13: jj };
          // 先頭0落とし fallback
          if (g.charAt(0) === '0') return { status: 'ok', jan13: g.substring(1) };
          return { status: 'no_match', jan13: null };
        }
      }
      return { status: 'no_match', jan13: null };
    });
  }

  function lookupMaterial(payload) {
    // returns Promise<ScannedItem>
    var baseItem = {
      lineId: uid('li'),
      raw: payload && payload.raw ? payload.raw : '',
      jan13: payload && payload.jan13 ? payload.jan13 : null,
      gtin14: payload && payload.gtin14 ? payload.gtin14 : null,
      name: '',
      maker: '',
      productNo: '',
      spec: '',
      tokuteiName: '',
      reimbYen: 0,
      qty: 1,
      dictStatus: 'no_match'
    };

    var jan = baseItem.jan13;
    var gt = baseItem.gtin14;

    // JAN優先
    if (jan) {
      return lookupJanInDict(jan).then(function (res) {
        if (res && res.status === 'ok') {
          var item = buildItemFromRow(payload, res.headers || [], res.row || []);
          item.dictStatus = 'ok';
          return item;
        }
        baseItem.dictStatus = (res && res.status) ? res.status : 'no_match';
        return baseItem;
      }).catch(function (e) {
        baseItem.dictStatus = 'dict_fetch_error';
        return baseItem;
      });
    }

    // GTIN14 -> index -> JAN -> dict
    if (gt) {
      return lookupGtinToJan(gt).then(function (res) {
        if (res && res.status === 'ok' && res.jan13) {
          baseItem.jan13 = res.jan13;
          return lookupJanInDict(res.jan13).then(function (res2) {
            if (res2 && res2.status === 'ok') {
              var item = buildItemFromRow({ raw: baseItem.raw, jan13: baseItem.jan13, gtin14: baseItem.gtin14 }, res2.headers || [], res2.row || []);
              item.dictStatus = 'ok';
              return item;
            }
            baseItem.dictStatus = (res2 && res2.status) ? res2.status : 'no_match';
            return baseItem;
          });
        }
        baseItem.dictStatus = (res && res.status) ? res.status : 'no_match';
        return baseItem;
      }).catch(function (e2) {
        baseItem.dictStatus = 'dict_fetch_error';
        return baseItem;
      });
    }

    return Promise.resolve(baseItem);
  }

  // ========= State =========
  var state = {
    role: 'field',         // field | doctor | billing
    ui: { scanMode: false },

    field: {
      step: 1,
      operatorId: '',
      patientId: '',
      procId: '',
      items: [],
      selectedApproverDoctorId: ''
    },

    doctor: {
      dept: '',
      doctorId: '',
      // for detail
      selectedReqId: ''
    },

    billing: {
      filterStatus: 'pending', // pending | approved
      filterApprover: '',
      filterDate: ''
    }
  };

  // ========= Persistence models =========
  function getDraftsMap() { return Storage.getObj(K.DRAFTS, {}); }
  function setDraftsMap(map) { Storage.setObj(K.DRAFTS, map); }

  function getPending() { return Storage.getObj(K.PENDING, []); }
  function setPending(arr) { Storage.setObj(K.PENDING, arr); }

  function getApproved() { return Storage.getObj(K.APPROVED, []); }
  function setApproved(arr) { Storage.setObj(K.APPROVED, arr); }

  function getRecentApprovers() { return Storage.getObj(K.RECENT_APPROVERS, {}); }
  function setRecentApprovers(obj) { Storage.setObj(K.RECENT_APPROVERS, obj); }

  function getDoctorDocs() { return Storage.getObj(K.DOCS, {}); }
  function setDoctorDocs(obj) { Storage.setObj(K.DOCS, obj); }

  function computeTotalQty(items) {
    var sum = 0;
    var i;
    for (i = 0; i < items.length; i++) {
      var q = items[i] && items[i].qty != null ? items[i].qty : 0;
      sum += q;
    }
    return sum;
  }

  function setScanMode(on) {
    state.ui.scanMode = !!on;
    try {
      if (state.ui.scanMode) document.body.classList.add('scan-mode');
      else document.body.classList.remove('scan-mode');
    } catch (e) {}
  }

  // ========= Summary =========
  function renderSummary() {
    var el = $('summary');
    if (!el) return;

    if (state.role !== 'field') {
      el.style.display = 'none';
      return;
    }

    var op = Masters.findOperator(state.field.operatorId);
    var pt = Masters.findPatient(state.field.patientId);
    var pr = Masters.findProcedure(state.field.procId);

    var total = computeTotalQty(state.field.items);

    var html = '';
    html += '<div class="row">';
    html += '<div><div class="label">入力者</div><div><b>' + escapeHtml(op ? op.name : '-') + '</b> <span class="small">' + escapeHtml(op ? op.dept : '') + '</span></div></div>';
    html += '<div><div class="label">患者</div><div><b>' + escapeHtml(pt ? pt.name : '-') + '</b> <span class="small">' + escapeHtml(pt ? pt.ward : '') + '</span></div></div>';
    html += '</div>';
    html += '<div class="row" style="margin-top:10px;">';
    html += '<div><div class="label">手技</div><div><b>' + escapeHtml(pr ? pr.name : '-') + '</b></div></div>';
    html += '<div><div class="label">トータル数量</div><div><b>' + total + '</b></div></div>';
    html += '</div>';

    el.innerHTML = html;
    el.style.display = 'block';
  }

  // ========= Router / Render =========
  function setRole(role) {
    state.role = role;
    // scan停止
    try { Scanner.stop(); } catch (e) {}
    setScanMode(false);

    // roleボタン
    var b1 = $('roleField'), b2 = $('roleDoctor'), b3 = $('roleBilling');
    if (b1) b1.classList.remove('is-active');
    if (b2) b2.classList.remove('is-active');
    if (b3) b3.classList.remove('is-active');
    if (role === 'field' && b1) b1.classList.add('is-active');
    if (role === 'doctor' && b2) b2.classList.add('is-active');
    if (role === 'billing' && b3) b3.classList.add('is-active');

    render();
  }

  function render() {
    renderSummary();
    if (state.role === 'field') renderField();
    else if (state.role === 'doctor') renderDoctor();
    else renderBilling();
  }

  // ========= Field =========
  function renderField() {
    var view = $('view');
    if (!view) return;

    var step = state.field.step;

    var html = '';
    html += '<div class="card">';
    html += '<div class="row"><div><b>実施入力</b></div><div class="small" style="text-align:right;">Step ' + step + ' / 7</div></div>';
    html += '<div class="hr"></div>';

    // Step UI
    if (step === 1) html += fieldStep1();
    else if (step === 2) html += fieldStep2();
    else if (step === 3) html += fieldStep3();
    else if (step === 4) html += fieldStep4();
    else if (step === 5) html += fieldStep5();
    else if (step === 6) html += fieldStep6();
    else html += fieldStep7();

    html += '</div>';

    view.innerHTML = html;

    bindFieldEvents();
  }

  function fieldStep1() {
    var ops = Masters.operators || [];
    var i;
    var opt = '<option value="">選択してください</option>';
    for (i = 0; i < ops.length; i++) {
      var o = ops[i];
      opt += '<option value="' + escapeHtml(o.operatorId) + '">' + escapeHtml(o.dept + ' / ' + o.name) + '</option>';
    }

    var html = '';
    html += '<div class="label">入力者（operator）</div>';
    html += '<select id="f_operator">' + opt + '</select>';
    html += '<div style="margin-top:10px;"><button class="btn primary" id="f_next1" type="button">次へ</button></div>';
    return html;
  }

  function fieldStep2() {
    var pts = Masters.patients || [];
    var i;
    var opt = '<option value="">選択してください</option>';
    for (i = 0; i < pts.length; i++) {
      var p = pts[i];
      opt += '<option value="' + escapeHtml(p.patientId) + '">' + escapeHtml((p.ward ? p.ward + ' / ' : '') + p.name) + '</option>';
    }

    var html = '';
    html += '<div class="label">患者</div>';
    html += '<select id="f_patient">' + opt + '</select>';
    html += '<div class="row" style="margin-top:10px;">';
    html += '<button class="btn" id="f_back2" type="button">戻る</button>';
    html += '<button class="btn primary" id="f_next2" type="button">次へ</button>';
    html += '</div>';
    return html;
  }

  function fieldStep3() {
    var procs = Masters.procedures || [];
    var i;
    var opt = '<option value="">選択してください（サジェストなし）</option>';
    for (i = 0; i < procs.length; i++) {
      var pr = procs[i];
      opt += '<option value="' + escapeHtml(pr.procId) + '">' + escapeHtml(pr.dept + ' / ' + pr.name) + '</option>';
    }

    var html = '';
    html += '<div class="label">手技</div>';
    html += '<select id="f_proc">' + opt + '</select>';
    html += '<div class="row" style="margin-top:10px;">';
    html += '<button class="btn" id="f_back3" type="button">戻る</button>';
    html += '<button class="btn primary" id="f_next3" type="button">材料スキャンへ</button>';
    html += '</div>';
    return html;
  }

  function fieldStep4() {
    var html = '';
    html += '<div class="scannerWrap">';
    html += '  <div id="scannerTarget"></div>';
    html += '  <div class="scanHint">スキャン中：邪魔UIは非表示。中央帯（ROI）で読みます。JAN優先 / GS1-128はAI(01)でGTIN14抽出。</div>';
    html += '</div>';

    html += '<div class="hr"></div>';
    html += '<div class="row">';
    html += '<button class="btn" id="f_stopScan" type="button">スキャン停止</button>';
    html += '<button class="btn primary" id="f_toConfirm" type="button">確定（Step5）</button>';
    html += '</div>';

    // 直近スキャン一覧（scan-modeでもここは見せる：ただし軽く）
    html += '<div class="hr"></div>';
    html += '<div><b>読み取り済み（編集はStep5で）</b></div>';
    html += '<div class="small">辞書なしも raw を残します（dict_fetch_error / no_match）。</div>';
    html += '<div class="list" style="margin-top:10px;">' + renderItemsMini(state.field.items) + '</div>';

    // サジェスト（材料スキャン後に表示する方針だが、scan-mode中は隠す）
    html += '<div class="hr"></div>';
    html += '<div class="suggestBlock">';
    html += '<div><b>おすすめ手技（材料スキャン後）</b></div>';
    html += '<div class="small">PoC：standard_builder.json を元に簡易表示</div>';
    html += '<div id="suggest" style="margin-top:8px;">' + escapeHtml(buildSuggestText()) + '</div>';
    html += '</div>';

    return html;
  }

  function fieldStep5() {
    var html = '';
    html += '<div><b>確定前チェック（編集可能）</b></div>';
    html += '<div class="small">削除/数量±/追加スキャンは承認済みになるまで可能</div>';

    html += '<div class="hr"></div>';
    html += '<div class="list">' + renderItemsEditable(state.field.items) + '</div>';

    html += '<div class="hr"></div>';
    html += '<div class="row">';
    html += '<button class="btn" id="f_back5" type="button">戻る（スキャン）</button>';
    html += '<button class="btn primary" id="f_next5" type="button">承認依頼へ</button>';
    html += '</div>';

    html += '<div style="margin-top:10px;">';
    html += '<button class="btn" id="f_addScan" type="button">追加スキャン（Step4）</button>';
    html += '</div>';

    html += '<div style="margin-top:10px;">';
    html += '<button class="btn" id="f_csv_field" type="button">CSV出力（実施入力）</button>';
    html += '</div>';

    return html;
  }

  function fieldStep6() {
    var op = Masters.findOperator(state.field.operatorId);
    var dept = op ? op.dept : '';
    var docs = Masters.doctors || [];
    var recent = getRecentApprovers();
    var recentList = (dept && recent && recent[dept]) ? recent[dept] : [];

    // deptで絞り、最近順を先頭に
    var i;
    var filtered = [];
    for (i = 0; i < docs.length; i++) {
      if (docs[i] && (!dept || docs[i].dept === dept)) filtered.push(docs[i]);
    }

    function scoreDoc(d) {
      var j;
      for (j = 0; j < recentList.length; j++) {
        if (recentList[j] === d.doctorId) return j; // 0が最上
      }
      return 999;
    }

    filtered.sort(function (a, b) {
      var sa = scoreDoc(a);
      var sb = scoreDoc(b);
      if (sa !== sb) return sa - sb;
      // 同点は名前
      var an = a.name || '';
      var bn = b.name || '';
      if (an < bn) return -1;
      if (an > bn) return 1;
      return 0;
    });

    var opt = '<option value="">選択してください</option>';
    for (i = 0; i < filtered.length; i++) {
      var d = filtered[i];
      opt += '<option value="' + escapeHtml(d.doctorId) + '">' + escapeHtml(d.dept + ' / ' + d.name) + '</option>';
    }

    var html = '';
    html += '<div><b>承認依頼先</b></div>';
    html += '<div class="small">診療科で絞り＋最近使った順</div>';
    html += '<div class="hr"></div>';
    html += '<div class="label">承認医師</div>';
    html += '<select id="f_approver">' + opt + '</select>';

    html += '<div class="hr"></div>';
    html += '<div class="row">';
    html += '<button class="btn" id="f_back6" type="button">戻る</button>';
    html += '<button class="btn primary" id="f_sendApproval" type="button">承認依頼を送信</button>';
    html += '</div>';
    return html;
  }

  function fieldStep7() {
    var html = '';
    html += '<div><b>承認依頼を送信しました</b></div>';
    html += '<div class="small">医師画面で承認できます。医事画面で閲覧できます。</div>';
    html += '<div class="hr"></div>';
    html += '<button class="btn primary" id="f_new" type="button">新規入力（Step1へ）</button>';
    return html;
  }

  function renderItemsMini(items) {
    var html = '';
    var i;
    for (i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it) continue;
      html += '<div class="itemline">';
      html += '<div class="itemline__top">';
      html += '<div>';
      html += '<div class="itemline__name">' + escapeHtml(it.name || '(辞書なし)') + '</div>';
      html += '<div class="itemline__sub">' + escapeHtml(it.maker || '') + ' / ' + escapeHtml(it.spec || '') + '</div>';
      html += '<div class="itemline__sub">JAN:' + escapeHtml(it.jan13 || '-') + ' GTIN:' + escapeHtml(it.gtin14 || '-') + ' <span class="small">(' + escapeHtml(it.dictStatus || '') + ')</span></div>';
      html += '</div>';
      html += '<div class="qtybox"><div class="qty">×' + (it.qty != null ? it.qty : 1) + '</div></div>';
      html += '</div>';
      html += '</div>';
    }
    if (!html) html = '<div class="small">まだありません</div>';
    return html;
  }

  function renderItemsEditable(items) {
    var html = '';
    var i;
    for (i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it) continue;
      html += '<div class="itemline" data-lineid="' + escapeHtml(it.lineId) + '">';
      html += '<div class="itemline__top">';
      html += '<div>';
      html += '<div class="itemline__name">' + escapeHtml(it.name || '(辞書なし)') + '</div>';
      html += '<div class="itemline__sub">' + escapeHtml(it.productNo || '') + ' / ' + escapeHtml(it.spec || '') + '</div>';
      html += '<div class="itemline__sub">' + escapeHtml(it.tokuteiName || '') + '</div>';
      html += '<div class="itemline__sub">償還価格: ' + (it.reimbYen ? (it.reimbYen + '円') : '-') + ' / dict: ' + escapeHtml(it.dictStatus || '') + '</div>';
      html += '<div class="itemline__sub">raw: ' + escapeHtml(it.raw || '') + '</div>';
      html += '</div>';

      html += '<div style="min-width:120px;">';
      html += '<div class="qtybox" style="justify-content:flex-end;">';
      html += '<button type="button" class="btnQtyMinus" aria-label="minus">-</button>';
      html += '<div class="qty">' + (it.qty != null ? it.qty : 1) + '</div>';
      html += '<button type="button" class="btnQtyPlus" aria-label="plus">+</button>';
      html += '</div>';
      html += '<div style="margin-top:8px;"><button type="button" class="btn btnDel danger">削除</button></div>';
      html += '</div>';

      html += '</div>';
      html += '</div>';
    }
    if (!html) html = '<div class="small">材料がありません。戻ってスキャンしてください。</div>';
    return html;
  }

  function buildSuggestText() {
    // PoC簡易：itemsの jan13 をキーにして standard_builder から procId候補を表示
    // ここでは「存在するなら候補をテキストで出す」だけ
    var sb = Masters.standardBuilder || [];
    if (!sb.length) return '（standard_builder が空）';

    var hits = [];
    var i, j;
    for (i = 0; i < state.field.items.length; i++) {
      var it = state.field.items[i];
      var key = it && it.jan13 ? String(it.jan13) : '';
      if (!key) continue;

      for (j = 0; j < sb.length; j++) {
        var row = sb[j];
        if (!row) continue;
        if (String(row.key || '') === key && row.recommendedProcIds && row.recommendedProcIds.length) {
          hits = row.recommendedProcIds;
          break;
        }
      }
      if (hits.length) break;
    }
    if (!hits.length) return '（おすすめなし）';

    var out = [];
    for (i = 0; i < hits.length; i++) {
      var pr = Masters.findProcedure(hits[i]);
      if (pr) out.push(pr.dept + '/' + pr.name);
    }
    return out.length ? out.join(' / ') : '（procが見つからない）';
  }

  function bindFieldEvents() {
    var step = state.field.step;

    if (step === 1) {
      var sel = $('f_operator');
      if (sel) sel.value = state.field.operatorId || '';
      bindTap($('f_next1'), function () {
        var v = sel ? sel.value : '';
        if (!v) { toast('入力者を選択してください'); return; }
        state.field.operatorId = v;
        state.field.step = 2;
        render();
      });
    }

    if (step === 2) {
      var sel2 = $('f_patient');
      if (sel2) sel2.value = state.field.patientId || '';
      bindTap($('f_back2'), function () { state.field.step = 1; render(); });
      bindTap($('f_next2'), function () {
        var v2 = sel2 ? sel2.value : '';
        if (!v2) { toast('患者を選択してください'); return; }
        state.field.patientId = v2;
        state.field.step = 3;
        render();
      });
    }

    if (step === 3) {
      var sel3 = $('f_proc');
      if (sel3) sel3.value = state.field.procId || '';
      bindTap($('f_back3'), function () { state.field.step = 2; render(); });
      bindTap($('f_next3'), function () {
        var v3 = sel3 ? sel3.value : '';
        if (!v3) { toast('手技を選択してください'); return; }
        state.field.procId = v3;
        state.field.step = 4;
        render();
        startScan();
      });
    }

    if (step === 4) {
      bindTap($('f_stopScan'), function () {
        stopScan();
        toast('スキャン停止');
      });
      bindTap($('f_toConfirm'), function () {
        stopScan();
        state.field.step = 5;
        render();
      });
      // step4 render後に開始
      startScan();
    }

    if (step === 5) {
      bindTap($('f_back5'), function () {
        state.field.step = 4;
        render();
        startScan();
      });
      bindTap($('f_addScan'), function () {
        state.field.step = 4;
        render();
        startScan();
      });
      bindTap($('f_next5'), function () {
        if (!state.field.items.length) { toast('材料がありません'); return; }
        state.field.step = 6;
        render();
      });
      bindTap($('f_csv_field'), function () {
        downloadFieldCsv();
      });

      // qty +/- / delete
      bindEditableItemButtons();
    }

    if (step === 6) {
      var sel6 = $('f_approver');
      if (sel6) sel6.value = state.field.selectedApproverDoctorId || '';
      bindTap($('f_back6'), function () { state.field.step = 5; render(); });
      bindTap($('f_sendApproval'), function () {
        var v6 = sel6 ? sel6.value : '';
        if (!v6) { toast('承認医師を選択してください'); return; }
        state.field.selectedApproverDoctorId = v6;
        createApprovalRequest(v6);
      });
    }

    if (step === 7) {
      bindTap($('f_new'), function () {
        resetFieldFlow();
        render();
      });
    }
  }

  function bindEditableItemButtons() {
    var view = $('view');
    if (!view) return;
    var lines = view.querySelectorAll('.itemline[data-lineid]');
    var i;
    for (i = 0; i < lines.length; i++) {
      (function (lineEl) {
        var id = lineEl.getAttribute('data-lineid');
        var btnMinus = lineEl.querySelector('.btnQtyMinus');
        var btnPlus = lineEl.querySelector('.btnQtyPlus');
        var btnDel = lineEl.querySelector('.btnDel');
        if (btnMinus) bindTap(btnMinus, function () { changeQty(id, -1); });
        if (btnPlus) bindTap(btnPlus, function () { changeQty(id, +1); });
        if (btnDel) bindTap(btnDel, function () { deleteItem(id); });
      })(lines[i]);
    }
  }

  function changeQty(lineId, delta) {
    var i;
    for (i = 0; i < state.field.items.length; i++) {
      var it = state.field.items[i];
      if (it && it.lineId === lineId) {
        var q = it.qty != null ? it.qty : 1;
        q += delta;
        if (q < 1) q = 1;
        it.qty = q;
        break;
      }
    }
    render();
  }

  function deleteItem(lineId) {
    var out = [];
    var i;
    for (i = 0; i < state.field.items.length; i++) {
      var it = state.field.items[i];
      if (it && it.lineId === lineId) continue;
      out.push(it);
    }
    state.field.items = out;
    render();
  }

  function resetFieldFlow() {
    state.field.step = 1;
    state.field.operatorId = '';
    state.field.patientId = '';
    state.field.procId = '';
    state.field.items = [];
    state.field.selectedApproverDoctorId = '';
    renderSummary();
  }

  // ========= Scan integration =========
  var scanBusy = false;

  function startScan() {
    // Step4のみ
    if (state.field.step !== 4) return;
    if (scanBusy) return;

    scanBusy = true;
    setScanMode(true);

    // scannerTarget がある前提
    try {
      Scanner.start(
        {
          roi: { topPct: 30, bottomPct: 30, leftPct: 16, rightPct: 16 },
          checkDigit: true,
          doubleHit: true,
          needHits: 2,
          doubleHitWindowMs: 900
        },
        function (payload) {
          onScanDetected(payload);
        }
      );
      toast('スキャン開始');
    } catch (e) {
      fatal('スキャン起動に失敗', e);
    } finally {
      scanBusy = false;
    }
  }

  function stopScan() {
    try { Scanner.stop(); } catch (e) {}
    setScanMode(false);
  }

  function onScanDetected(payload) {
    // 連打抑制：lookup中は軽くブロック
    if (state._lookupLock) return;
    state._lookupLock = true;

    lookupMaterial(payload).then(function (item) {
      state.field.items.push(item);
      renderSummary();
      // step4表示を更新（一覧に反映）
      render();

      if (item.dictStatus === 'ok') {
        toast('追加: ' + (item.name || 'OK'), 1400);
      } else {
        toast('追加: (辞書なし) ' + item.dictStatus, 1600);
      }
    }).catch(function (e) {
      toast('lookup error', 1600);
    }).finally ? null : null;

    // finally互換（finallyがない環境対策は不要だが一応）
    setTimeout(function () { state._lookupLock = false; }, 350);
  }

  // ========= Create Approval =========
  function createApprovalRequest(doctorId) {
    var op = Masters.findOperator(state.field.operatorId);
    var pt = Masters.findPatient(state.field.patientId);
    var pr = Masters.findProcedure(state.field.procId);
    var doc = Masters.findDoctor(doctorId);

    if (!op || !pt || !pr || !doc) { toast('マスタ不整合'); return; }

    var req = {
      reqId: uid('ar'),
      createdAt: new Date().getTime(),
      operator: { operatorId: op.operatorId, name: op.name, dept: op.dept },
      patient: { patientId: pt.patientId, name: pt.name, ward: pt.ward || '' },
      procedure: { procId: pr.procId, name: pr.name, dept: pr.dept },
      items: state.field.items.slice(0),
      approver: { doctorId: doc.doctorId, name: doc.name, dept: doc.dept },
      status: 'pending',
      approvedAt: null,
      doctorComment: '',
      history: [
        { ts: new Date().getTime(), action: 'created', by: op.operatorId }
      ]
    };

    var pending = getPending();
    pending.unshift(req);
    setPending(pending);

    // 最近使った承認者
    var recent = getRecentApprovers();
    if (!recent[op.dept]) recent[op.dept] = [];
    // 先頭に追加（重複削除）
    var out = [doc.doctorId];
    var i;
    for (i = 0; i < recent[op.dept].length; i++) {
      if (recent[op.dept][i] === doc.doctorId) continue;
      out.push(recent[op.dept][i]);
    }
    recent[op.dept] = out.slice(0, 8);
    setRecentApprovers(recent);

    // 下書き保存（operator単位）
    saveFieldDraftForOperator(op.operatorId);

    // 次へ
    state.field.step = 7;
    render();
    toast('承認依頼を送信しました', 1800);
  }

  function saveFieldDraftForOperator(operatorId) {
    var map = getDraftsMap();
    if (!map[operatorId]) map[operatorId] = [];

    var op = Masters.findOperator(state.field.operatorId);
    var pt = Masters.findPatient(state.field.patientId);
    var pr = Masters.findProcedure(state.field.procId);

    var draft = {
      draftId: uid('fd'),
      createdAt: new Date().getTime(),
      operator: op ? { operatorId: op.operatorId, name: op.name, dept: op.dept } : {},
      patient: pt ? { patientId: pt.patientId, name: pt.name, ward: pt.ward || '' } : {},
      procedure: pr ? { procId: pr.procId, name: pr.name, dept: pr.dept } : {},
      items: state.field.items.slice(0),
      summary: { totalQty: computeTotalQty(state.field.items) }
    };

    map[operatorId].unshift(draft);
    map[
