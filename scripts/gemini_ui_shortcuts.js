(function initGeminiOps(){
  const S = {
    promptInput: [
      'div.ql-editor[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"][aria-label*="Gemini"]',
      '[contenteditable="true"][data-placeholder*="Gemini"]',
      'div[contenteditable="true"][role="textbox"]'
    ],
    actionBtn: [
      '.send-button-container button.send-button',
      '.send-button-container button'
    ],
    newChatBtn: [
      '[data-test-id="new-chat-button"] a',
      '[data-test-id="new-chat-button"]',
      'a[aria-label="发起新对话"]',
      'a[aria-label*="new chat" i]'
    ],
    modelBtn: [
      'button:has-text("Gemini")',
      '[role="button"][aria-haspopup="menu"]'
    ]
  };

  /* ── Debug 日志系统 ── */
  var _log = [];
  var _MAX_LOG = 200;

  function _d(fn, step, ok, detail){
    var entry = {ts:Date.now(), fn:fn, step:step, ok:ok};
    if(detail!==undefined) entry.detail=detail;
    _log.push(entry);
    if(_log.length>_MAX_LOG) _log.splice(0, _log.length-_MAX_LOG);
  }

  /** 取出并清空日志 */
  function _flush(){
    var out=_log.slice();
    _log=[];
    return out;
  }

  function visible(el){
    if(!el) return false;
    const r=el.getBoundingClientRect();
    const st=getComputedStyle(el);
    return r.width>0 && r.height>0 && st.display!=='none' && st.visibility!=='hidden';
  }

  function q(sel){
    try{
      if(sel.includes(':has-text(')){
        const m=sel.match(/^(.*):has-text\("(.*)"\)$/);
        if(!m) return null;
        const nodes=[...document.querySelectorAll(m[1]||'*')];
        return nodes.find(n=>visible(n)&&n.textContent?.includes(m[2]))||null;
      }
      return [...document.querySelectorAll(sel)].find(visible)||null;
    }catch{return null;}
  }

  function find(key){
    for(const s of (S[key]||[])){
      const el=q(s);
      if(el){
        _d('find','matched',true,{key:key,selector:s});
        return el;
      }
    }
    _d('find','no_match',false,{key:key,tried:S[key]||[]});
    return null;
  }

  function click(key){
    _d('click','start',true,{key:key});
    const el=find(key);
    if(!el){
      _d('click','element_not_found',false,{key:key});
      return {ok:false,key,error:'not_found',debug:_flush()};
    }
    el.click();
    _d('click','clicked',true,{key:key});
    return {ok:true,key,debug:_flush()};
  }

  function fillPrompt(text){
    _d('fillPrompt','start',true,{textLen:text.length});
    const el=find('promptInput');
    if(!el){
      _d('fillPrompt','input_not_found',false);
      return {ok:false,error:'prompt_not_found',debug:_flush()};
    }
    _d('fillPrompt','input_found',true,{tag:el.tagName});
    el.focus();
    if(el.tagName==='TEXTAREA'){
      el.value=text;
      el.dispatchEvent(new Event('input',{bubbles:true}));
      _d('fillPrompt','set_textarea',true);
    }else{
      document.execCommand('selectAll',false,null);
      document.execCommand('insertText',false,text);
      el.dispatchEvent(new Event('input',{bubbles:true}));
      _d('fillPrompt','exec_insertText',true);
    }
    return {ok:true,debug:_flush()};
  }

  function getStatus(){
    const btn=find('actionBtn');
    if(!btn){
      _d('getStatus','btn_not_found',false);
      return {status:'unknown',error:'btn_not_found'};
    }
    const label=(btn.getAttribute('aria-label')||'').trim();
    const disabled=btn.getAttribute('aria-disabled')==='true';
    if(/停止|Stop/i.test(label)){
      _d('getStatus','detected',true,{status:'loading',label:label});
      return {status:'loading',label};
    }
    if(/发送|Send|Submit/i.test(label)){
      _d('getStatus','detected',true,{status:'ready',label:label,disabled:disabled});
      return {status:'ready',label,disabled};
    }
    _d('getStatus','detected',true,{status:'idle',label:label,disabled:disabled});
    return {status:'idle',label,disabled};
  }

  /* ── 保活式轮询 ──
   * 不在页面内做长 Promise 等待（会导致 CDP 连接因长时间无消息被网关判定空闲断开）。
   * 改为：调用端每 8-10s evaluate 一次 GeminiOps.pollStatus()，立即拿到结果。
   * 调用端自行累计耗时并判断超时。
   */
  function pollStatus(){
    var s=getStatus();
    _d('pollStatus','polled',true,{status:s.status});
    return {status:s.status, label:s.label, pageVisible:!document.hidden, ts:Date.now(), debug:_flush()};
  }

  /* ── 最新图片获取与下载 ──
   * Gemini 一次只生成一张图片，流程上只关心最新生成的那张。
   * DOM 中 img.image.loaded 按顺序排列，最后一个即为最新生成。
   *
   * DOM 结构：
   *   <div class="image-container ...">
   *     <button class="image-button ...">
   *       <img class="image loaded" src="https://lh3.googleusercontent.com/..." alt="AI 生成">
   *     </button>
   *     <div class="button-icon-wrapper">
   *       <mat-icon fonticon="download" data-mat-icon-name="download" ...></mat-icon>
   *     </div>
   *   </div>
   */

  function _findContainer(img){
    var el=img;
    while(el&&el!==document.body){
      if(el.classList&&el.classList.contains('image-container')) return el;
      el=el.parentElement;
    }
    return null;
  }

  function _findDownloadBtn(container){
    if(!container) return null;
    return container.querySelector('mat-icon[fonticon="download"]')
        || container.querySelector('mat-icon[data-mat-icon-name="download"]')
        || null;
  }

  /** 获取最新生成的一张图片信息（DOM 中最后一个 img.image.loaded） */
  function getLatestImage(){
    _d('getLatestImage','start',true);
    var imgs=[...document.querySelectorAll('img.image.loaded')];
    _d('getLatestImage','query_imgs',true,{totalFound:imgs.length});
    if(!imgs.length){
      _d('getLatestImage','no_images',false);
      return {ok:false, error:'no_loaded_images', debug:_flush()};
    }
    var img=imgs[imgs.length-1];
    _d('getLatestImage','picked_latest',true,{index:imgs.length-1, src:(img.src||'').slice(0,80)});
    var container=_findContainer(img);
    _d('getLatestImage','find_container',!!container);
    var dlBtn=_findDownloadBtn(container);
    _d('getLatestImage','find_download_btn',!!dlBtn);
    return {
      ok: true,
      src: img.src||'',
      alt: img.alt||'',
      width: img.naturalWidth||0,
      height: img.naturalHeight||0,
      hasDownloadBtn: !!dlBtn,
      debug: _flush()
    };
  }

  /** 点击最新图片的"下载原图"按钮（仅用户要求高清时调用） */
  function downloadLatestImage(){
    _d('downloadLatestImage','start',true);
    var imgs=[...document.querySelectorAll('img.image.loaded')];
    _d('downloadLatestImage','query_imgs',true,{totalFound:imgs.length});
    if(!imgs.length){
      _d('downloadLatestImage','no_images',false);
      return {ok:false, error:'no_loaded_images', debug:_flush()};
    }
    var img=imgs[imgs.length-1];
    var container=_findContainer(img);
    _d('downloadLatestImage','find_container',!!container);
    var dlBtn=_findDownloadBtn(container);
    if(!dlBtn){
      _d('downloadLatestImage','download_btn_not_found',false);
      return {ok:false, error:'download_btn_not_found', debug:_flush()};
    }
    _d('downloadLatestImage','find_download_btn',true);
    var clickable=dlBtn.closest('button,[role="button"],.button-icon-wrapper')||dlBtn;
    clickable.click();
    _d('downloadLatestImage','clicked',true,{clickedTag:clickable.tagName});
    return {ok:true, src:img.src||'', debug:_flush()};
  }

  /* ── 图片 Base64 提取 ──
   * 默认获取图片的方式。直接从已渲染的 DOM 提取，不走网络请求，不触发下载对话框。
   *
   * 策略：
   *   1. Canvas 提取（同步，零网络，最快）
   *   2. 若 Canvas 被 tainted（跨域污染），fallback 到页面内 fetch → blob → Base64
   *
   * 返回 data:image/png;base64,... 格式字符串，调用端直接解码存文件即可。
   * 注意：fetch fallback 是异步的，因此本函数返回 Promise。
   *       调用端需用 CDP Runtime.evaluate + awaitPromise:true 来获取结果。
   */
  function extractImageBase64(){
    _d('extractImageBase64','start',true);
    var imgs=[...document.querySelectorAll('img.image.loaded')];
    _d('extractImageBase64','query_imgs',true,{totalFound:imgs.length});
    if(!imgs.length){
      _d('extractImageBase64','no_images',false);
      var dbg=_flush();
      return Promise.resolve({ok:false, error:'no_loaded_images', debug:dbg});
    }
    var img=imgs[imgs.length-1];
    var w=img.naturalWidth||img.width;
    var h=img.naturalHeight||img.height;
    _d('extractImageBase64','picked_latest',true,{index:imgs.length-1, w:w, h:h, src:(img.src||'').slice(0,80)});

    // 尝试 Canvas 同步提取
    try{
      var canvas=document.createElement('canvas');
      canvas.width=w;
      canvas.height=h;
      var ctx=canvas.getContext('2d');
      ctx.drawImage(img,0,0);
      var dataUrl=canvas.toDataURL('image/png');
      _d('extractImageBase64','canvas_ok',true,{size:dataUrl.length});
      var dbg=_flush();
      return Promise.resolve({ok:true, dataUrl:dataUrl, width:w, height:h, method:'canvas', debug:dbg});
    }catch(e){
      _d('extractImageBase64','canvas_tainted',false,{error:e.message||String(e)});
    }

    // Fallback: 页面内 fetch → blob → Base64
    _d('extractImageBase64','fetch_fallback_start',true,{src:(img.src||'').slice(0,80)});
    var debugSnapshot=_flush();
    return fetch(img.src)
      .then(function(r){
        if(!r.ok) throw new Error('fetch_status_'+r.status);
        return r.blob();
      })
      .then(function(blob){
        return new Promise(function(resolve){
          var reader=new FileReader();
          reader.onloadend=function(){
            _d('extractImageBase64','fetch_ok',true,{size:reader.result.length});
            resolve({ok:true, dataUrl:reader.result, width:w, height:h, method:'fetch', debug:debugSnapshot.concat(_flush())});
          };
          reader.readAsDataURL(blob);
        });
      })
      .catch(function(err){
        _d('extractImageBase64','fetch_failed',false,{error:err.message||String(err)});
        return {ok:false, error:'extract_failed', detail:err.message||String(err), debug:debugSnapshot.concat(_flush())};
      });
  }

  function probe(){
    _d('probe','start',true);
    var s=getStatus();
    var result={
      promptInput: !!find('promptInput'),
      actionBtn: !!find('actionBtn'),
      newChatBtn: !!find('newChatBtn'),
      modelBtn: !!find('modelBtn'),
      status: s.status,
      debug: _flush()
    };
    return result;
  }

  /** 获取完整调试日志（不清空） */
  function getDebugLog(){
    return {log:_log.slice(), count:_log.length};
  }

  window.GeminiOps = {probe, click, fillPrompt, getStatus, pollStatus, getLatestImage, extractImageBase64, downloadLatestImage, getDebugLog, selectors:S, version:'0.9.0'};
})();
