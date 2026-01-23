
/*
 LinQ VAL PoC - Full Function Version (v1)
 Safari compatible (no optional chaining, no catch omission)
 Covers:
 - Role switch (Field / Doctor / Billing)
 - Field flow skeleton
 - Doctor approval list
 - Billing view
 - Scan stub (Scanner optional)
*/
(function(){
  'use strict';
  function $(id){return document.getElementById(id);}
  function bind(el,fn){
    if(!el) return;
    el.addEventListener('click',fn,false);
    el.addEventListener('touchend',function(e){e.preventDefault();fn(e);},false);
  }

  var state={role:'field',items:[],approvals:[]};

  function render(){
    var v=$('view');
    if(!v) return;
    if(state.role==='field'){
      v.innerHTML=
        '<div class="card">'+
        '<div class="h1">実施入力</div>'+
        '<button class="btn primary" id="scanBtn">材料スキャン（ダミー）</button>'+
        '<div class="divider"></div>'+
        renderItems()+
        '<div class="divider"></div>'+
        '<button class="btn" id="sendBtn">承認依頼</button>'+
        '</div>';
      bind($('scanBtn'),addDummyItem);
      bind($('sendBtn'),sendApproval);
    }else if(state.role==='doctor'){
      v.innerHTML=
        '<div class="card">'+
        '<div class="h1">医師 承認</div>'+
        renderApprovals()+
        '</div>';
    }else{
      v.innerHTML=
        '<div class="card">'+
        '<div class="h1">医事 閲覧</div>'+
        renderApprovals(true)+
        '</div>';
    }
  }

  function renderItems(){
    if(!state.items.length) return '<div class="muted">材料なし</div>';
    var h='';
    for(var i=0;i<state.items.length;i++){
      h+='<div class="listItem"><b>'+state.items[i].name+'</b><span class="tag">'+state.items[i].price+'円</span></div>';
    }
    return h;
  }

  function addDummyItem(){
    state.items.push({name:'テスト材料'+(state.items.length+1),price:1200});
    render();
  }

  function sendApproval(){
    if(!state.items.length){alert('材料がありません');return;}
    state.approvals.push({
      id:Date.now(),
      items:state.items.slice(),
      status:'pending'
    });
    state.items=[];
    alert('承認依頼を送信しました');
    render();
  }

  function renderApprovals(readOnly){
    if(!state.approvals.length) return '<div class="muted">承認待ちなし</div>';
    var h='';
    for(var i=0;i<state.approvals.length;i++){
      var a=state.approvals[i];
      h+='<div class="listItem">'+
         '<div><b>ID '+a.id+'</b><div class="muted">'+a.items.length+'点</div></div>';
      if(!readOnly && a.status==='pending'){
        h+='<button class="btn small primary" data-id="'+a.id+'">承認</button>';
      }
      h+='</div>';
    }
    setTimeout(bindApprovalButtons,0);
    return h;
  }

  function bindApprovalButtons(){
    var btns=document.querySelectorAll('[data-id]');
    for(var i=0;i<btns.length;i++){
      (function(el){
        bind(el,function(){
          var id=el.getAttribute('data-id');
          approve(id);
        });
      })(btns[i]);
    }
  }

  function approve(id){
    for(var i=0;i<state.approvals.length;i++){
      if(String(state.approvals[i].id)===String(id)){
        state.approvals[i].status='approved';
      }
    }
    alert('承認しました');
    render();
  }

  function setRole(r){
    state.role=r;
    render();
  }

  window.addEventListener('load',function(){
    bind($('roleField'),function(){setRole('field');});
    bind($('roleDoctor'),function(){setRole('doctor');});
    bind($('roleBilling'),function(){setRole('billing');});
    render();
  });
})();
