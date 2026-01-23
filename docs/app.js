'use strict';

(function () {
  function $(id){ return document.getElementById(id); }

  function escapeHtml(s){
    s = (s == null) ? '' : String(s);
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function fatal(title, err){
    var el = $('fatal');
    if (!el) { alert(title + '\n' + (err && err.stack ? err.stack : err)); return; }
    el.style.display = 'block';
    el.innerHTML =
      '<div style="font-weight:900;color:#b00020;margin-bottom:8px;">' + escapeHtml(title) + '</div>' +
      '<div style="white-space:pre-wrap;font-family:ui-monospace,Menlo,monospace;font-size:12px;">' +
      escapeHtml(err && err.stack ? err.stack : String(err)) +
      '</div>';
  }

  // これが無いと「反応しない」になる（click/touch両対応）
  function bindTap(el, fn){
    if (!el) return;
    var locked = false;
    function run(e){
      if (locked) return;
      locked = true;
      try { fn(e); } catch (err) { fatal('UIイベントでエラー', err); }
      setTimeout(function(){ locked = false; }, 250);
    }
    el.addEventListener('click', run, { passive:true });
    el.addEventListener('touchend', function(e){ e.preventDefault(); run(e); }, { passive:false });
  }

  window.addEventListener('error', function(e){
    try { fatal('起動エラー', e.error || e.message || e); } catch (ex) {}
  });

  var state = { role: 'field' };

  function setRole(role){
    state.role = role;

    var b1 = $('roleField'), b2 = $('roleDoctor'), b3 = $('roleBilling');
    if (b1) b1.classList.remove('is-active');
    if (b2) b2.classList.remove('is-active');
    if (b3) b3.classList.remove('is-active');
    if (role === 'field' && b1) b1.classList.add('is-active');
    if (role === 'doctor' && b2) b2.classList.add('is-active');
    if (role === 'billing' && b3) b3.classList.add('is-active');

    render();
  }

  function render(){
    var view = $('view');
    if (!view) return;

    if (state.role === 'field') {
      view.innerHTML = '<div class="card"><b>実施入力</b><div class="small">roleボタン動作確認OK</div></div>';
    } else if (state.role === 'doctor') {
      view.innerHTML = '<div class="card"><b>医師</b><div class="small">roleボタン動作確認OK</div></div>';
    } else {
      view.innerHTML = '<div class="card"><b>医事</b><div class="small">roleボタン動作確認OK</div></div>';
    }
  }

  function init(){
    // ここが通れば「反応しない」は解消される
    bindTap($('roleField'), function(){ setRole('field'); });
    bindTap($('roleDoctor'), function(){ setRole('doctor'); });
    bindTap($('roleBilling'), function(){ setRole('billing'); });

    setRole('field');
  }

  init();
})();