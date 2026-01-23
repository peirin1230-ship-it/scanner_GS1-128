'use strict';

(function () {
  function $(id){ return document.getElementById(id); }

  function setBuild(s){
    var b = $('build');
    if (b) b.textContent = s;
  }

  function fatal(title, err){
    var el = $('fatal');
    if (!el) { alert(title); return; }
    el.style.display = 'block';
    var msg = (err && err.stack) ? err.stack : String(err || '');
    el.innerHTML =
      '<div class="fatalTitle">' + title + '</div>' +
      '<div class="fatalMsg">' + msg + '</div>';
  }

  function bindTap(el, fn){
    if (!el) return;
    var lock = false;

    function run(e){
      if (lock) return;
      lock = true;
      try { fn(e); } catch (ex) { fatal('UIイベントでエラー', ex); }
      setTimeout(function(){ lock = false; }, 250);
    }

    el.addEventListener('click', run, false);
    el.addEventListener('touchend', function(e){
      e.preventDefault();
      run(e);
    }, false);
  }

  window.addEventListener('error', function(e){
    try { fatal('起動エラー', e.error || e.message || e); } catch (ex) {}
  });

  var state = { role:'field' };

  function setRole(role){
    state.role = role;

    var b1=$('roleField'), b2=$('roleDoctor'), b3=$('roleBilling');
    if (b1) b1.classList.remove('is-active');
    if (b2) b2.classList.remove('is-active');
    if (b3) b3.classList.remove('is-active');

    if (role==='field' && b1) b1.classList.add('is-active');
    if (role==='doctor' && b2) b2.classList.add('is-active');
    if (role==='billing' && b3) b3.classList.add('is-active');

    render();
  }

  function render(){
    var view = $('view');
    if (!view) return;
    if (state.role==='field') {
      view.innerHTML = '<div class="card"><b>実施入力</b><div class="small">JS稼働中 / role切替OK</div></div>';
    } else if (state.role==='doctor') {
      view.innerHTML = '<div class="card"><b>医師</b><div class="small">JS稼働中 / role切替OK</div></div>';
    } else {
      view.innerHTML = '<div class="card"><b>医事</b><div class="small">JS稼働中 / role切替OK</div></div>';
    }
  }

  function init(){
    // ここが動けば「反応しない」は終わり
    setBuild('BUILD: v26c_010 (JS OK)');

    bindTap($('roleField'), function(){ setRole('field'); });
    bindTap($('roleDoctor'), function(){ setRole('doctor'); });
    bindTap($('roleBilling'), function(){ setRole('billing'); });

    setRole('field');
  }

  init();
})();