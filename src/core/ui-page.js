// The client is serialized from a function so generated strings retain escaping.
import { sidebarSurface } from './customization.js';

function appClient(token, sidebarSurface) {
  const base = '/t/' + token + '/';
  const $ = id => document.getElementById(id);
  let state, busy = false, refreshing = false, refreshAgain = false, heartbeatToken = -1, toastTimer, galleryKey;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function toast(message, failure = false) {
    clearTimeout(toastTimer);
    $('toast').textContent = message;
    $('toast').className = 'toast show' + (failure ? ' error' : '');
    if ($('editor').open) { $('editorNotice').textContent = message; $('editorNotice').hidden = false; }
    toastTimer = setTimeout(() => { $('toast').className = 'toast'; }, 6500);
  }
  async function api(route, options = {}) {
    const response = await fetch(base + route, {signal: AbortSignal.timeout(60000), ...options});
    if (!response.ok) throw new Error('Request failed (' + response.status + ')');
    const result = await response.json();
    if (result.ok === false) throw new Error(result.error || 'Action failed');
    return result;
  }
  const post = (route, body) => api(route, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body ?? {})});
  function setBusy(value, label = '') {
    busy = value;
    document.body.classList.toggle('busy',value);
    document.querySelectorAll('button, input, select').forEach(el => {el.disabled = value || el.dataset.broken === 'true';});
    $('activity').textContent = label;
    $('activity').hidden = !value;
    $('grid').setAttribute('aria-busy', String(value));
  }
  async function action(label, work) {
    if (busy) return;
    setBusy(true,label);
    try {await work();} catch(error) {toast(error.message,true);}
    finally {setBusy(false);await refresh();}
  }
  async function heartbeat() {
    try {
      const result = await post('window-heartbeat',{since:heartbeatToken});
      heartbeatToken = result.token;
    } catch { /* Window liveness should not interrupt user actions. */ }
  }
  async function refresh() {
    if(busy) return;
    if(refreshing) {refreshAgain=true;return;}
    refreshing=true;
    try {state=await api('state');render();}
    catch(error) {$('codexLabel').textContent='Connection unavailable';$('statusText').textContent='Could not reach codexskin. Reopen the app to reconnect.';$('codexStatus').className='status-dot';}
    finally {refreshing=false;if(refreshAgain&&!busy){refreshAgain=false;void refresh();}}
  }
  function render() {
    const themes=state.themes ?? [], selected=themes.find(t=>t.id===state.activeThemeId);
    $('themeCount').textContent=themes.length + (themes.length===1?' theme':' themes');
    const picker=$('themePicker'), previous=picker.value;
    picker.innerHTML='<option value="">Choose an installed theme</option>'+themes.map(t=>'<option value="'+esc(t.id)+'" '+(t.broken?'disabled':'')+'>'+esc(t.name)+(t.active?' · Current':t.broken?' · Needs repair':'')+'</option>').join('');
    picker.value=themes.some(t=>t.id===previous&&!t.broken)?previous:selected&&!selected.broken?selected.id:'';
    $('switchTheme').disabled=!picker.value;
    $('currentTheme').textContent=selected?'Current theme: '+selected.name:'Current theme: Official look';
    $('empty').hidden=themes.length>0;
    $('codexLabel').textContent=state.codexReachable?'Theme connection ready':state.codexRunning?'Codex open � standard profile':'Codex is closed';
    $('codexStatus').className='status-dot'+(state.codexReachable?' online':state.codexRunning?' warning':'');
    $('statusTitle').textContent=selected?selected.name:'Your next look starts here';
    $('statusText').textContent=selected
      ? (state.codexReachable?'Selected for Codex. Re-apply anytime to refresh every window.':(state.codexRunning?'Codex stays open in its standard profile. Launch skinned Codex to switch profiles.':'Your theme is saved. Launch skinned Codex when ready.'))
      : 'Import a theme, preview your collection, and make Codex feel like yours.';
    $('autostartChk').checked=state.autostartEnabled;
    const query=$('themeSearch').value.trim().toLowerCase();
    const visibleThemes=themes.filter(theme=>theme.name.toLowerCase().includes(query));
    $('noSearchResults').hidden=visibleThemes.length>0||themes.length===0;
    const key=JSON.stringify([themes,query]);
    if(key===galleryKey) return;
    galleryKey=key;
    $('grid').innerHTML=visibleThemes.map(t=>{
      const source=base+'image/'+encodeURIComponent(t.id)+'?v='+encodeURIComponent(t.revision ?? '');
      return '<article class="theme-card'+(t.active?' selected':'')+'">'+
        '<div class="preview"><img src="'+esc(source)+'" alt="'+esc(t.name)+' background" loading="lazy">'+
        '<span class="theme-badge'+(t.active?' active':'')+'">'+(t.broken?'Needs repair':t.active?'Selected':'Ready to apply')+'</span>'+
        '<div class="preview-window" aria-hidden="true"><span></span><span></span><span></span><div></div><div></div></div></div>'+
        '<div class="card-content"><div class="card-heading"><h3>'+esc(t.name)+'</h3><span class="theme-mark" aria-hidden="true">'+(t.active?'✓':'↗')+'</span></div>'+
        '<p>'+esc(t.broken?'Re-import this package to repair it.':t.source==='dreamskin-official'?'DreamSkin package':'Local theme package')+'</p>'+
        '<div class="card-actions"><button class="apply-button '+(t.active?'secondary':'primary')+'" data-id="'+esc(t.id)+'" data-broken="'+String(t.broken)+'" '+(t.broken?'disabled':'')+'>'+(t.active?'Re-apply theme':'Apply theme')+'</button>'+
        '<button class="edit-button secondary" data-id="'+esc(t.id)+'" data-broken="'+String(t.broken)+'" '+(t.broken?'disabled':'')+' aria-label="Customize '+esc(t.name)+'">Edit</button>'+
        '<button class="remove-button" data-id="'+esc(t.id)+'" aria-label="Remove '+esc(t.name)+'" title="Remove theme">×</button></div></div></article>';
    }).join('');
    $('grid').querySelectorAll('.apply-button').forEach(button=>button.onclick=()=>{
      switchTheme(button.dataset.id);
    });
    $('grid').querySelectorAll('.edit-button').forEach(button=>button.onclick=()=>openEditor(button.dataset.id));
    $('grid').querySelectorAll('.remove-button').forEach(button=>button.onclick=()=>{
      if(!confirm('Remove this theme from your collection? You can import its package again later.')) return;
      action('Removing theme…',async()=>{await post('remove/'+encodeURIComponent(button.dataset.id));toast('Theme removed.');});
    });
  }
  function switchTheme(id) {
    if(!id||busy)return;
    const restart=state.codexRunning&&!state.codexReachable;
    if(restart&&!confirm('Restart Codex to apply this theme? Your current Codex window will close and reopen.'))return;
    action('Switching theme…',async()=>{const result=await post('apply/'+encodeURIComponent(id),{restart});toast('Applied to '+result.windows+' Codex window'+(result.windows===1?'':'s')+'.');});
  }
  $('themeSearch').oninput=()=>{if(state)render();};
  $('themePicker').onchange=()=>{$('switchTheme').disabled=!$('themePicker').value;};
  $('switchTheme').onclick=()=>switchTheme($('themePicker').value);
  async function importFile(file) {
    if(!file || busy) return;
    if(!/\.(zip|codextheme)$/i.test(file.name)) {toast('Choose a .zip or .codextheme package.',true);return;}
    if(file.size>32*1024*1024) {toast('Theme packages must be 32 MiB or smaller.',true);return;}
    const restart=!state?.activeThemeId&&state?.codexRunning&&!state?.codexReachable;
    if(restart&&!confirm('Import and apply this theme by restarting Codex? Its current window will close and reopen.')) return;
    await action('Importing '+file.name+'…',async()=>{
      const result=await api('import/'+encodeURIComponent(file.name),{method:'POST',headers:{'content-type':'application/zip','x-codexskin-restart':String(restart)},body:file});
      toast(result.autoApplied?result.theme.name+' imported and applied.':result.applyError?'Imported '+result.theme.name+'. '+result.applyError:result.theme.name+' added to your collection.',Boolean(result.applyError));
    });
  }
  let editingId = null, editorDefaults, imageBase64 = null, imageObjectUrl = null;
  const settingKeys = ['textColorsEnabled','primaryTextColor','secondaryTextColor','brightness','accent','sidebarColor','sidebarOpacity','sidebarDarkness','chatColor','chatOpacity','userMessageDarkness','assistantMessageDarkness','activityDarkness'];
  function readSettings() {
    return Object.fromEntries(settingKeys.map(key=>[key, key==='textColorsEnabled' ? $(key).checked : /brightness|Opacity|Darkness/.test(key) ? Number($(key).value) : $(key).value]));
  }
  function updatePreview() {
    const values=readSettings();
    const rgba=(hex,opacity)=>'rgba('+[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)).join(',')+','+opacity/100+')';
    $('editorImage').style.filter='brightness('+values.brightness/100+')';
    $('previewSidebar').style.background=sidebarSurface(values);
    $('previewSidebar').style.color=values.sidebarDarkness>0?'#f4f6f8':'';
    $('sidebarDarknessValue').textContent=values.sidebarDarkness===0?'0% · Off':values.sidebarDarkness+'%';
    $('previewChat').style.background=rgba(values.chatColor,values.chatOpacity);
    for (const [key,id] of [['userMessageDarkness','previewUserMessage'],['assistantMessageDarkness','previewAssistantMessage'],['activityDarkness','previewActivity']]) {
      $(id).style.background=rgba('#101316',values[key]);
      $(key+'Value').textContent=values[key]===0?'0% · Off':values[key]+'%';
    }
    $('previewAccent').style.background=values.accent;
    $('previewSidebar').style.color=values.textColorsEnabled?values.primaryTextColor:values.sidebarDarkness>0?'#f4f6f8':'';
    for(const id of ['previewUserMessage','previewAssistantMessage'])$(id).style.color=values.textColorsEnabled?values.primaryTextColor:'';
    $('previewActivity').style.color=values.textColorsEnabled?values.secondaryTextColor:'';
    document.querySelector('.mock-main').style.color=values.textColorsEnabled?values.primaryTextColor:'';
    for(const key of ['brightness','sidebarOpacity','chatOpacity']) $(key+'Value').textContent=values[key]+'%'+(key!=='brightness'&&values[key]===100?' · Opaque':'');
  }
  function fillSettings(values) { for(const key of settingKeys) {if(key==='textColorsEnabled')$(key).checked=values[key] ?? false;else $(key).value=values[key] ?? (key==='primaryTextColor'?'#f4f6f8':'#a1a8b0');}updatePreview(); }
  async function openEditor(id) {
    if(busy) return;
    await action('Opening theme editor…',async()=>{
      editingId=id;imageBase64=null;
      editorDefaults=id?(await api('theme/'+encodeURIComponent(id)+'/settings')):null;
      $('editorTitle').textContent=id?'Customize '+editorDefaults.name:'Create your own theme';
      $('editorNotice').hidden=true;
      $('creatorFields').hidden=Boolean(id);$('resetTheme').hidden=!id;
      $('saveTheme').textContent=id?'Save changes':'Create theme';
      if(id)$('editorImage').src=base+'image/'+encodeURIComponent(id);else $('editorImage').removeAttribute('src');
      $('editorImage').hidden=!id;
      $('themeName').value='';$('customImage').value='';
      fillSettings(editorDefaults?.settings ?? {brightness:100,accent:'#b7f0ce',sidebarColor:'#191e22',sidebarOpacity:80,sidebarDarkness:0,chatColor:'#191e22',chatOpacity:80,userMessageDarkness:0,assistantMessageDarkness:0,activityDarkness:0});
      $('editor').showModal();
    });
  }
  $('compatibilityBtn').onclick=()=>action('Checking theme compatibility�',async()=>{
    const result=await api('compatibility');
    const lines=[...result.warnings];
    result.windows.forEach((window,index)=>{
      lines.push('Window '+(index+1)+': '+(window.warnings.length ? window.warnings.join(' ') : 'Theme layer and current-page targets detected.'));
    });
    $('compatibilityResult').textContent=lines.join('\n')+'\nThis checks the current pages only; it does not certify every Codex page or version.';
    $('compatibilityResult').hidden=false;
  });
  $('createBtn').onclick=()=>openEditor(null);
  $('closeEditor').onclick=()=>$('editor').close();
  $('cancelEditor').onclick=()=>$('editor').close();
  $('editor').addEventListener('close',()=>{imageBase64=null;if(imageObjectUrl){URL.revokeObjectURL(imageObjectUrl);imageObjectUrl=null;}$('editorImage').removeAttribute('src');});
  $('editor').addEventListener('cancel',event=>{if(busy)event.preventDefault();});
  for(const key of settingKeys) $(key).addEventListener('input',updatePreview);
  for(const [key,prefix] of [['sidebarOpacity','sidebar'],['chatOpacity','chat']]) {
    $(prefix+'Opaque').onclick=()=>{$(key).value=100;updatePreview();};
    $(prefix+'Glass').onclick=()=>{$(key).value=65;updatePreview();};
  }
  $('resetTextColors').onclick=()=>{
    $('textColorsEnabled').checked=false;
    $('primaryTextColor').value=editorDefaults?.defaults.primaryTextColor ?? '#f4f6f8';
    $('secondaryTextColor').value=editorDefaults?.defaults.secondaryTextColor ?? '#a1a8b0';
    updatePreview();
    toast('Text colors reset. Save changes to apply.');
  };
  for(const key of ['primaryTextColor','secondaryTextColor'])$(key).addEventListener('input',()=>{$('textColorsEnabled').checked=true;updatePreview();});
  $('customImage').onchange=async()=>{
    const file=$('customImage').files[0];if(!file)return;
    imageBase64=null;
    if(file.size>10*1024*1024){toast('Images must be 10 MiB or smaller.',true);return;}
    await action('Reading background…',async()=>{
      const url=URL.createObjectURL(file);
      try {
        const image=new Image();image.src=url;await image.decode();
        const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('Could not read image'));reader.readAsDataURL(file);});
        if(!/^data:image\/(png|jpeg|webp);base64,/.test(data))throw new Error('Choose PNG, JPEG or WebP.');
        imageBase64=data.split(',')[1];
        if(imageObjectUrl)URL.revokeObjectURL(imageObjectUrl);imageObjectUrl=url;
        $('editorImage').src=url;$('editorImage').hidden=false;updatePreview();
      } catch(error){URL.revokeObjectURL(url);throw error;}
    });
  };
  $('saveTheme').onclick=()=>{
    const settings=readSettings(), id=editingId, name=$('themeName').value.trim();
    if(!id&&(!name||!imageBase64)){toast('Add a theme name and a PNG, JPEG or WebP background.',true);return;}
    action(id?'Saving theme settings…':'Creating theme…',async()=>{
      const result=id?await post('theme/'+encodeURIComponent(id)+'/settings',settings):await post('create',{name,image:imageBase64,settings});
      $('editor').close();
      toast(result.applyError?'Settings saved. '+result.applyError:id?(result.applied?'Changes applied to Codex.':'Settings saved. Apply the theme when you are ready.'):'Theme created. Select Apply theme to use it.',Boolean(result.applyError));
    });
  };
  $('resetTheme').onclick=()=>action('Restoring package settings…',async()=>{
    const result=await post('theme/'+encodeURIComponent(editingId)+'/settings',{reset:true});
    $('editor').close();toast(result.applyError?'Package settings restored. '+result.applyError:'Original package appearance restored.',Boolean(result.applyError));
  });
  $('importBtn').onclick=()=>{$('fileInput').value='';$('fileInput').click();};
  $('emptyImport').onclick=()=>$('importBtn').click();
  $('fileInput').onchange=()=>importFile($('fileInput').files[0]);
  document.addEventListener('dragover',event=>{event.preventDefault();document.body.classList.add('dragging');});
  document.addEventListener('dragleave',event=>{if(!event.relatedTarget)document.body.classList.remove('dragging');});
  document.addEventListener('drop',event=>{event.preventDefault();document.body.classList.remove('dragging');if($('editor').open){toast('Use the background picker to choose an image.');return;}importFile(event.dataTransfer.files[0]);});
  $('launchBtn').onclick=()=>{
    if(state?.codexRunning&&!state.codexReachable&&!confirm('Restart Codex with your theme profile? Its current window will close and reopen.')) return;
    action('Connecting Codex…',async()=>{await post('launch-codex');toast('Codex is ready. Your selected theme will be applied automatically.');});
  };
  $('restoreBtn').onclick=()=>action('Restoring official look…',async()=>{const result=await post('restore');toast(result.attempted?'Official look restored.':'Theme cleared. Codex will keep its official look.');});
  $('autostartChk').onchange=()=>action('Saving preference…',async()=>{await post('autostart/'+($('autostartChk').checked?'enable':'disable'));toast('Login preference saved.');});
  $('quitBtn').onclick=()=>action('Quitting codexskin…',async()=>{await post('quit');window.close();});
  document.querySelectorAll('.nav a').forEach(link=>link.addEventListener('click',()=>{
    document.querySelectorAll('.nav a').forEach(item=>item.classList.toggle('active',item===link));
  }));
  heartbeat();refresh();setInterval(heartbeat,4000);setInterval(refresh,8000);
}

export function renderApp({token}) {
  const client = '('+appClient.toString()+')('+JSON.stringify(token).replace(/</g,'\\u003c')+','+sidebarSurface.toString()+');';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>codexskin — Your theme library</title>
<style>
:root{--bg:#101316;--panel:#191e22;--line:#2c343a;--text:#eef4f1;--muted:#98aaa4;--accent:#b7f0ce;--danger:#ffb0a6;font-family:Inter,"Segoe UI",system-ui,sans-serif;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-size:14px}button,input{font:inherit}button,a,input{touch-action:manipulation}button{cursor:pointer}button:disabled{opacity:.5;cursor:wait}button:focus-visible,a:focus-visible,input:focus-visible{outline:3px solid var(--accent);outline-offset:4px}[hidden]{display:none!important}
.app{display:grid;grid-template-columns:208px minmax(0,1fr);min-height:100vh}.sidebar{padding:30px 22px;border-right:1px solid var(--line);display:flex;flex-direction:column;background:#14191c;position:sticky;top:0;height:100vh}.brand{display:flex;gap:11px;align-items:center;font-size:20px;font-weight:700;letter-spacing:-.8px}.brand-icon{display:grid;place-items:center;width:34px;height:34px;background:var(--accent);color:#133323;border-radius:10px;font-size:24px}.brand-subtitle{font-size:11px;color:var(--muted);margin:10px 0 40px;letter-spacing:.7px}.nav{display:flex;flex-direction:column;gap:8px}.nav a{color:var(--muted);text-decoration:none;padding:12px 13px;border-radius:9px;font-weight:550}.nav a.active{background:#253b31;color:var(--accent)}.nav a:hover{background:#252d30;color:var(--text)}.sidebar-bottom{margin-top:auto;padding-top:25px}.privacy{font-size:12px;line-height:1.7;color:var(--muted);margin:0 0 20px}.privacy strong{display:block;color:#d1e0d8;font-weight:500}.quit{background:transparent;border:1px solid var(--line);border-radius:8px;padding:10px 14px;color:var(--muted);width:100%}.quit:hover{color:var(--danger);border-color:var(--danger)}
.workspace{max-width:1300px;width:100%;padding:28px 40px 45px;margin:auto}.topbar{display:flex;align-items:center;justify-content:space-between;gap:15px;margin-bottom:36px}.breadcrumb{color:var(--muted);font-size:12px}.connection{display:flex;align-items:center;gap:8px;padding:8px 12px;border:1px solid var(--line);border-radius:30px;font-size:12px;color:#c0cfc7}.status-dot{width:7px;height:7px;border-radius:50%;background:#718078}.status-dot.online{background:var(--accent);box-shadow:0 0 12px #b7f0ce44}.status-dot.warning{background:#f2c681}.hero{display:flex;justify-content:space-between;gap:24px;align-items:center;margin-bottom:30px}.eyebrow{color:var(--accent);font-size:10px;letter-spacing:2px;font-weight:650;margin:0 0 12px}.hero h1{font-size:clamp(30px,4vw,44px);font-weight:550;line-height:1.12;letter-spacing:-1.8px;margin:0 0 12px}.hero p{color:var(--muted);line-height:1.6;margin:0}.primary,.secondary{border-radius:9px;padding:11px 17px;white-space:nowrap;font-weight:600;transition:background .15s,transform .15s}.primary{background:var(--accent);color:#133323;border:1px solid var(--accent)}.primary:hover{background:#d0ffdf;transform:translateY(-1px)}.secondary{color:var(--text);background:#242d30;border:1px solid #37443f}.secondary:hover{background:#303c37}.import-button{padding:13px 19px;font-size:13px}.status-card{padding:22px 24px;border:1px solid #35443c;border-radius:14px;background:linear-gradient(110deg,#263b30,#1c2825 60%,#20272e);display:flex;align-items:center;gap:18px;margin-bottom:34px}.status-art{width:50px;height:50px;flex-shrink:0;border:1px solid #b7f0ce33;border-radius:13px;display:grid;place-items:center;color:var(--accent);font-size:25px;background:#b7f0ce0b}.status-copy{flex:1;min-width:0}.status-copy h2{font-size:16px;margin:0 0 7px;font-weight:600;word-break:break-word}.status-copy p{margin:0;color:#a8bcb0;font-size:12px;line-height:1.6}.status-card button{font-size:12px}.section-heading{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px}.section-heading h2{font-size:17px;margin:0;font-weight:550;letter-spacing:-.3px}.count{font-size:11px;color:var(--muted);border:1px solid var(--line);border-radius:20px;padding:5px 10px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(235px,1fr));gap:20px}.theme-card{min-width:0;background:var(--panel);border:1px solid var(--line);border-radius:13px;overflow:hidden;transition:border-color .2s,transform .2s}.theme-card:hover{border-color:#63766b;transform:translateY(-2px)}.theme-card.selected{border-color:#9acdb0;box-shadow:0 0 0 1px #b7f0ce22}.preview{height:180px;position:relative;overflow:hidden;background:linear-gradient(145deg,#344739,#283341)}.preview>img{width:100%;height:100%;object-fit:cover;position:absolute;inset:0}.preview:after{content:"";position:absolute;inset:0;background:linear-gradient(0deg,#10131655,transparent);pointer-events:none}.theme-badge{position:absolute;right:12px;top:12px;border:1px solid #ffffff30;background:#111b22bb;color:#e3eee6;padding:5px 9px;border-radius:20px;font-size:9px;font-weight:650;z-index:2;backdrop-filter:blur(12px)}.theme-badge.active{background:var(--accent);color:#133323;border-color:var(--accent)}.preview-window{position:absolute;left:13%;right:13%;top:30%;height:94px;background:#131c20bb;border:1px solid #ffffff29;border-radius:8px;box-shadow:0 10px 25px #0004;backdrop-filter:blur(8px);padding:9px;z-index:1}.preview-window>span{display:inline-block;width:4px;height:4px;background:#cfdbd866;border-radius:50%;margin-right:3px}.preview-window>div{height:10px;width:65%;background:#e7ffed12;margin:10px 5px;border-radius:4px}.preview-window>div:last-child{width:42%;background:#b7f0ce33}.card-content{padding:19px}.card-heading{display:flex;align-items:center;justify-content:space-between;gap:8px}.card-heading h3{font-size:15px;font-weight:600;letter-spacing:-.2px;margin:0;word-break:break-word}.theme-mark{color:var(--accent);font-size:18px}.card-content>p{color:var(--muted);font-size:11px;margin:8px 0 19px}.card-actions{display:flex;gap:8px}.apply-button{flex:1;font-size:12px;padding:10px 12px}.remove-button{color:var(--muted);background:transparent;border:1px solid var(--line);width:36px;border-radius:8px;font-size:21px}.remove-button:hover{color:var(--danger);border-color:var(--danger)}
.empty{border:1px dashed #53665b;border-radius:15px;text-align:center;padding:48px 24px;background:radial-gradient(ellipse at center,#b7f0ce0a,transparent 70%)}.empty-icon{font-size:35px;color:var(--accent);margin-bottom:15px}.empty h3{font-size:20px;font-weight:550;margin:0 0 10px}.empty p{font-size:13px;line-height:1.7;color:var(--muted);margin:0 0 20px}.empty .small{margin:16px 0 0;font-size:11px}.preferences{margin-top:36px;scroll-margin-top:24px}.settings-panel{border:1px solid var(--line);background:var(--panel);border-radius:13px}.setting{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:18px 21px;cursor:pointer}.setting+.setting{border-top:1px solid var(--line)}.setting strong{display:block;font-size:13px;font-weight:550;margin-bottom:5px}.setting small{font-size:11px;color:var(--muted);line-height:1.6;display:block}.setting input{appearance:none;flex-shrink:0;width:36px;height:21px;background:#39443d;border-radius:20px;position:relative;cursor:pointer;transition:background .15s}.setting input:before{content:"";width:15px;height:15px;position:absolute;left:3px;top:3px;border-radius:50%;background:#bcc9bf;transition:transform .15s}.setting input:checked{background:var(--accent)}.setting input:checked:before{background:#173c29;transform:translateX(15px)}.setting input:disabled{opacity:.5}.restore-row{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:19px}.restore-row p{color:var(--muted);font-size:11px;line-height:1.6;margin:0}.restore-row button{font-size:11px}.toast{position:fixed;bottom:25px;left:50%;transform:translateX(-50%) translateY(15px);opacity:0;pointer-events:none;background:#28392f;color:#d9f9e3;border:1px solid #658a71;border-radius:11px;padding:14px 20px;box-shadow:0 10px 40px #0007;z-index:10;max-width:min(650px,90vw);font-size:13px;line-height:1.5;transition:opacity .2s,transform .2s}.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}.toast.error{background:#3d2827;border-color:#a96962;color:#ffe0db}.activity{padding:12px 18px;margin:0 0 18px;border:1px solid #b7f0ce55;border-radius:10px;font-size:12px;color:var(--accent)}.activity:before{content:"";display:inline-block;width:10px;height:10px;border:2px solid #b7f0ce33;border-top-color:var(--accent);border-radius:50%;margin-right:9px;animation:spin .8s linear infinite}.drop-overlay{display:none;position:fixed;inset:12px;z-index:20;border:2px dashed var(--accent);border-radius:18px;background:#16251df2;place-items:center;font-size:24px;font-weight:550;color:var(--accent);pointer-events:none}.dragging .drop-overlay{display:grid}@keyframes spin{to{transform:rotate(360deg)}}
@media(min-width:1300px){.preview{height:210px}}@media(max-width:900px){.app{grid-template-columns:170px minmax(0,1fr)}.sidebar{padding:25px 16px}.workspace{padding:24px}.status-card{flex-wrap:wrap}.status-card button{margin-left:68px}.hero{align-items:flex-start}.hero h1{font-size:33px}}@media(max-width:620px){.app{display:block}.sidebar{height:auto;position:static;padding:17px 20px;border-right:0;border-bottom:1px solid var(--line);flex-direction:row;align-items:center;justify-content:space-between}.brand{font-size:18px}.brand-subtitle,.sidebar-bottom{display:none}.nav{flex-direction:row;gap:4px}.nav a{font-size:11px;padding:9px}.workspace{padding:23px 20px}.topbar{margin-bottom:26px}.hero{flex-direction:column;gap:20px}.hero h1{font-size:34px}.status-card{padding:18px}.grid{grid-template-columns:1fr}.preview{height:205px}.status-card button{margin-left:0;width:100%}.restore-row{align-items:flex-start;flex-direction:column}.toast{bottom:15px}}@media(prefers-reduced-motion:reduce){*,*:before{animation:none!important;transition:none!important}}
.hero-actions{display:flex;gap:10px;flex-wrap:wrap}.edit-button{font-size:12px;padding:8px}.toast{z-index:100}.editor-heading{display:flex;justify-content:space-between;align-items:center;margin-bottom:22px}.editor-heading h2{margin:0;font-size:24px;letter-spacing:-.5px}.editor-heading .eyebrow{margin-bottom:8px}dialog{color:var(--text);background:#191e22;border:1px solid #46554c;border-radius:18px;padding:26px;width:min(960px,95vw);max-height:90vh;overflow:auto;box-shadow:0 30px 100px #0008}dialog::backdrop{background:#080d11bb;backdrop-filter:blur(6px)}.editor-layout{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(260px,1fr);gap:28px}.editor-preview{position:sticky;top:0;height:360px;background:#1c2930;border:1px solid #ffffff24;border-radius:12px;overflow:hidden;display:flex}.editor-preview>img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}.mock-sidebar{position:relative;width:110px;flex-shrink:0;padding:24px 13px;backdrop-filter:blur(12px);font-size:11px}.mock-sidebar strong{font-size:16px}.mock-sidebar p{margin-top:28px}.mock-main{position:relative;flex:1;padding:34px 22px;min-width:0;color:#fff;text-shadow:0 1px 4px #000}.preview-caption{font-size:9px;letter-spacing:1.5px}.mock-main h3{margin-top:60px;font-size:24px;line-height:1.2}.mock-main>p{font-size:11px;line-height:1.7}.mock-chat{position:absolute;bottom:24px;left:18px;right:18px;padding:18px 40px 18px 12px;border:1px solid #ffffff33;border-radius:12px;font-size:10px;backdrop-filter:blur(12px)}.mock-chat span{position:absolute;right:10px;top:12px;width:23px;height:23px;display:grid;place-items:center;border-radius:6px;color:#10251b;text-shadow:none}.editor-field{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;font-size:12px;margin-bottom:20px}.editor-field>input:not([type=color]){width:100%}.editor-field>input:not([type=range]):not([type=color]){background:#111719;border:1px solid #39473f;border-radius:7px;padding:10px;color:var(--text)}.editor-field small,.editor-note{font-size:11px;color:var(--muted);line-height:1.7}.editor-field output{color:var(--accent);font-size:11px}input[type=range]{accent-color:var(--accent)}input[type=color]{width:42px;height:30px;border:0;background:transparent;cursor:pointer}fieldset{border:1px solid var(--line);border-radius:10px;margin:0 0 20px;padding:15px}legend{color:var(--accent);font-size:12px;padding:0 7px}.surface-buttons{display:flex;gap:8px;margin-bottom:18px}.surface-buttons button{font-size:11px;padding:7px 10px}fieldset .editor-field:last-child{margin-bottom:0}.editor-footer{display:flex;justify-content:space-between;gap:12px;border-top:1px solid var(--line);padding-top:20px;margin-top:22px}.editor-footer>div{display:flex;gap:10px}.editor-footer button{font-size:12px}@media(max-width:700px){.editor-layout{grid-template-columns:1fr}.editor-preview{position:relative;height:280px}.mock-main h3{margin-top:28px}dialog{padding:18px}.editor-footer{flex-wrap:wrap}.editor-footer>div{margin-left:auto}}
.installed-themes{scroll-margin-top:24px}.theme-switcher{padding:20px;background:var(--panel);border:1px solid var(--line);border-radius:12px;margin-bottom:20px;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px}.theme-switcher strong{font-size:13px}.theme-switcher p{color:var(--muted);font-size:12px;line-height:1.6;margin:7px 0 0}.switch-controls{display:flex;gap:10px;flex-wrap:wrap;max-width:100%}.switch-controls select{font:inherit;color:var(--text);background:#101719;border:1px solid #425248;border-radius:9px;padding:11px;max-width:100%;min-width:180px}.switch-controls select:focus-visible{outline:3px solid var(--accent);outline-offset:3px}@media(max-width:620px){.sidebar{flex-wrap:wrap;gap:14px}.nav{flex-wrap:wrap}.switch-controls{width:100%}.switch-controls select{min-width:0;flex:1}}
.mock-message{padding:12px;border-radius:12px;font-size:11px;line-height:1.6;margin-top:18px;border:1px solid #ffffff20;color:#f4f6f8;text-shadow:none}.mock-user{margin-top:28px;margin-left:12px}.editor-controls fieldset small{font-size:11px;line-height:1.6;color:var(--muted)}.theme-directory{color:var(--accent);font-size:12px;align-self:center}.theme-search{display:flex;align-items:center;gap:16px;color:var(--muted);font-size:12px;margin:0 0 20px}.theme-search input{flex:1;max-width:400px;background:#11191c;border:1px solid #42534a;border-radius:10px;padding:12px 14px;color:var(--text)}.theme-card{box-shadow:0 6px 24px #0002}.editor-controls fieldset{background:#141b1e;padding:18px}.editor-controls legend{font-weight:600}.editor-field input[type=checkbox]{width:18px;height:18px;accent-color:var(--accent)}.editor-footer{position:sticky;bottom:-26px;background:#191e22;padding-bottom:16px;z-index:2}.connection{background:#1b2722}.status-card{box-shadow:0 8px 28px #0002}.theme-search input::placeholder{color:var(--muted)}@media(max-width:620px){.theme-search{align-items:stretch;flex-direction:column;gap:8px}.theme-search input{max-width:none}.editor-footer{bottom:-18px}}

/* Hide scroll tracks without disabling scrolling or keyboard navigation. */
html,body,dialog,.editor-controls{scrollbar-width:none}
html::-webkit-scrollbar,body::-webkit-scrollbar,dialog::-webkit-scrollbar,.editor-controls::-webkit-scrollbar{display:none;width:0;height:0}
/* Theme library: restrained surfaces, readable hierarchy, spacious previews. */
:root{--bg:#101416;--panel:#1b2225;--line:#344046;--muted:#b0bbb9}
body{background:radial-gradient(ellipse at 75% 0%,#203a3033,transparent 55%),var(--bg)}
.sidebar{background:#111719;border-right-color:#2b3639}.brand-subtitle{letter-spacing:0;color:#a5b2ae}.nav a{padding:13px 14px}.nav a.active{box-shadow:inset 3px 0 var(--accent)}
.workspace{max-width:1440px;padding:32px 44px 56px}.topbar{margin-bottom:32px}.hero{margin-bottom:28px}.hero h1{font-weight:650;letter-spacing:-1.4px}.hero-actions{max-width:390px;justify-content:flex-end}.theme-directory{width:100%;text-align:right;padding-top:4px}
.status-card{background:linear-gradient(120deg,#24372f,#1b2525);border-color:#496052;border-radius:18px;margin-bottom:16px}.status-copy p{max-width:620px;line-height:1.6}.status-art{border:1px solid #b7f0ce33;border-radius:14px}
.utility-row{display:flex;justify-content:space-between;align-items:center;gap:18px;padding:0 4px;margin-bottom:32px;font-size:12px;color:var(--muted)}.utility-row button{font-size:12px;padding:9px 12px}.section-heading h2{font-size:20px;font-weight:600}.count{border:1px solid var(--line);padding:5px 10px;border-radius:20px}
.theme-switcher{background:#182023;border-radius:14px;padding:18px 20px}.grid{grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:22px}.theme-card{border-radius:16px;overflow:hidden;border:1px solid #344046;transition:border-color .18s,box-shadow .18s}.theme-card:hover{border-color:#60786d;box-shadow:0 12px 32px #0004}.theme-card.selected{border-color:var(--accent);box-shadow:0 0 0 1px #b7f0ce33}.preview{height:220px}.preview>img{width:100%;height:100%;object-fit:cover}.card-content{padding:20px}.card-heading h3{font-size:17px;line-height:1.35}.card-actions{gap:8px}.card-actions .apply-button{flex:1}.edit-button{padding:10px 13px}.remove-button{min-width:32px;min-height:32px}.theme-badge{backdrop-filter:blur(8px);border:1px solid #ffffff30}.theme-search input{max-width:none}.theme-search{margin-top:22px;margin-bottom:22px}.settings-panel{border-radius:16px}.setting{padding:20px 22px}.setting small{line-height:1.6;max-width:600px}.restore-row{border-top:1px solid var(--line);padding-top:22px}
dialog{width:min(1120px,96vw);border-color:#53655b;border-radius:22px}.editor-layout{grid-template-columns:minmax(0,1.2fr) minmax(320px,1fr);gap:32px}.editor-preview{height:440px;border-radius:16px}.mock-main{padding:26px 20px}.mock-message{font-size:12px;line-height:1.55}.mock-chat{bottom:18px}.editor-controls legend{font-size:13px}.editor-field{font-size:13px}.editor-field output{padding:4px 8px;border-radius:6px;background:#24372f;min-width:44px;text-align:center}.editor-heading{border-bottom:1px solid var(--line);padding-bottom:20px}.editor-footer{box-shadow:0 -12px 20px #191e22}
@media(max-width:1000px){.workspace{padding:26px}.hero{align-items:flex-start}.hero-actions{max-width:300px}.editor-layout{grid-template-columns:1fr 1fr;gap:20px}.editor-preview{height:400px}}
@media(max-width:700px){.workspace{padding:22px 18px}.hero-actions{justify-content:flex-start;max-width:none}.theme-directory{text-align:left}.utility-row{align-items:flex-start;flex-direction:column;gap:10px}.grid{grid-template-columns:1fr}.editor-layout{grid-template-columns:1fr}.editor-preview{height:360px;position:relative}.preview{height:240px}.theme-switcher{padding:16px}}
@media(prefers-reduced-motion:reduce){.theme-card{transition:none}}
</style></head><body>
<div class="app"><aside class="sidebar"><div><div class="brand"><span class="brand-icon" aria-hidden="true">✳</span>codexskin</div><p class="brand-subtitle">A LITTLE MORE YOU.</p></div><nav class="nav" aria-label="Main"><a class="active" href="#library">◫ &nbsp; Theme library</a><a href="#installedThemes">Installed themes</a><a href="#preferences">⚙ &nbsp; Preferences</a></nav><div class="sidebar-bottom"><p class="privacy"><strong>Made for your workspace.</strong>Local themes. Your own profile.<br>No app files changed.</p><button class="quit" id="quitBtn">Quit codexskin</button></div></aside>
<main class="workspace" id="library"><div class="topbar"><span class="breadcrumb">Your workspace / Appearance</span><div class="connection" role="status"><span class="status-dot" id="codexStatus"></span><span id="codexLabel">Checking Codex…</span></div></div>
<section class="hero"><div><p class="eyebrow">PERSONALIZE YOUR SPACE</p><h1>A fresh look.<br>A familiar workspace.</h1><p>Bring a little personality to your everyday Codex.</p></div><div class="hero-actions"><button class="secondary import-button" id="createBtn">Create theme</button><button class="primary import-button" id="importBtn">＋ &nbsp; Import theme…</button><a class="theme-directory" href="https://codexthemes.app/themes" target="_blank" rel="noopener noreferrer">Browse Codex Themes ↗</a></div><input type="file" id="fileInput" accept=".zip,.codextheme" hidden></section>
<section class="status-card" aria-label="Selected theme"><div class="status-art" aria-hidden="true">✦</div><div class="status-copy"><h2 id="statusTitle">Your next look starts here</h2><p id="statusText">Checking your theme collection…</p></div><button class="secondary" id="launchBtn">Launch skinned Codex ↗</button></section>
<div id="activity" class="activity" role="status" hidden></div><div class="utility-row"><span>Check styling in your connected Codex windows.</span><button class="secondary" id="compatibilityBtn">Check compatibility</button></div><p id="compatibilityResult" role="status" hidden style="white-space:pre-line"></p><section id="installedThemes" class="installed-themes" aria-labelledby="libraryTitle"><div class="section-heading"><h2 id="libraryTitle">Installed themes</h2><span class="count" id="themeCount">0 themes</span></div><div class="theme-switcher"><div><strong id="currentTheme">Current theme: Official look</strong><p>Switch between your imported and custom themes. Saved settings stay with each theme.</p></div><div class="switch-controls"><select id="themePicker" aria-label="Installed theme"><option value="">Choose an installed theme</option></select><button id="switchTheme" class="primary" disabled>Switch theme</button></div></div><div id="empty" class="empty" hidden><div class="empty-icon" aria-hidden="true">◈</div><h3>Your collection starts with one theme.</h3><p>Drop a .zip or .codextheme package here, or choose one from your files.<br>Your first theme will be applied automatically.</p><button class="secondary" id="emptyImport">Choose a theme package</button><p class="small">PNG, JPEG and WebP backgrounds · Local files only</p></div><label class="theme-search">Find a theme<input type="search" id="themeSearch" placeholder="Search installed themes..." autocomplete="off"></label><p id="noSearchResults" hidden role="status">No themes match your search.</p><div id="grid" class="grid" aria-live="polite"></div></section>
<section class="preferences" id="preferences" aria-labelledby="preferencesTitle"><div class="section-heading"><h2 id="preferencesTitle">App preferences</h2><span class="count">Preferences</span></div><div class="settings-panel"><div class="setting"><span><strong>Your launches stay yours</strong><small>Windows Search launches stay open. Use Launch skinned Codex when you want the theme profile.</small></span></div><label class="setting"><span><strong>Ready when you sign in</strong><small>Start codexskin in the tray when you log in to Windows.</small></span><input type="checkbox" id="autostartChk" aria-label="Launch at login"></label></div><div class="restore-row"><p>Want a clean slate? Restore Codex's original appearance anytime.</p><button class="secondary" id="restoreBtn">Restore official look</button></div></section>
</main></div><div class="drop-overlay" aria-hidden="true">Drop your theme package here</div><dialog id="editor" aria-labelledby="editorTitle"><div class="editor-heading"><div><p class="eyebrow">MAKE IT YOURS</p><h2 id="editorTitle">Theme editor</h2></div><button class="remove-button" id="closeEditor" aria-label="Close theme editor">×</button></div>
<div class="editor-layout"><div class="editor-preview" aria-label="Approximate theme preview"><img id="editorImage" alt="Background preview"><div class="mock-sidebar" id="previewSidebar"><strong>Codex</strong><p>＋ New chat</p><p>Projects</p><p>Recent chats</p></div><div class="mock-main"><span class="preview-caption">LIVE PREVIEW</span><div id="previewActivity" class="mock-message">Working for 14s · Thinking…</div><div id="previewUserMessage" class="mock-message mock-user">You: Explain this change.</div><div id="previewAssistantMessage" class="mock-message">Codex: Here is a clear answer, even over a bright background.</div><div id="previewChat" class="mock-chat">Ask Codex anything…<span id="previewAccent">↑</span></div></div></div>
<div class="editor-controls"><div id="creatorFields"><label class="editor-field">Theme name<input id="themeName" maxlength="80" placeholder="My workspace"></label><label class="editor-field">Background image<input type="file" id="customImage" accept="image/png,image/jpeg,image/webp"><small>PNG, JPEG or WebP · Maximum 10 MiB</small></label></div>
<label class="editor-field">Background brightness <output id="brightnessValue"></output><input type="range" id="brightness" min="20" max="180" value="100"></label><label class="editor-field color-field">Accent color<input type="color" id="accent" value="#b7f0ce"></label>
<fieldset><legend>Text colors</legend><button type="button" class="secondary" id="resetTextColors">Reset text colors</button><label class="editor-field">Use custom text colors<input type="checkbox" id="textColorsEnabled"></label><label class="editor-field color-field">Primary text (normally white)<input type="color" id="primaryTextColor" value="#f4f6f8"></label><label class="editor-field color-field">Secondary text (normally grey)<input type="color" id="secondaryTextColor" value="#a1a8b0"></label><small>Enable to override normal text and muted labels. Accent links and code syntax keep their colors.</small></fieldset><fieldset><legend>Sidebar</legend><label class="editor-field">Sidebar darkness <output id="sidebarDarknessValue"></output><input type="range" id="sidebarDarkness" min="0" max="100" value="0"></label><p class="editor-note">Darken the sidebar without changing its saved color. 0% keeps your surface settings; 100% makes it fully dark.</p><label class="editor-field color-field">Surface color<input type="color" id="sidebarColor" value="#191e22"></label><div class="surface-buttons"><button class="secondary" id="sidebarGlass">Translucent</button><button class="secondary" id="sidebarOpaque">Opaque</button></div><label class="editor-field">Opacity <output id="sidebarOpacityValue"></output><input type="range" id="sidebarOpacity" min="0" max="100" value="80"></label></fieldset>
<fieldset><legend>Composer / input box</legend><label class="editor-field color-field">Surface color<input type="color" id="chatColor" value="#191e22"></label><div class="surface-buttons"><button class="secondary" id="chatGlass">Translucent</button><button class="secondary" id="chatOpaque">Opaque</button></div><label class="editor-field">Opacity <output id="chatOpacityValue"></output><input type="range" id="chatOpacity" min="0" max="100" value="80"></label></fieldset><fieldset><legend>Message readability</legend><label class="editor-field">Your message darkness <output id="userMessageDarknessValue"></output><input type="range" id="userMessageDarkness" min="0" max="100" value="0"></label><label class="editor-field">AI reply darkness <output id="assistantMessageDarknessValue"></output><input type="range" id="assistantMessageDarkness" min="0" max="100" value="0"></label><label class="editor-field">Thinking / activity darkness <output id="activityDarknessValue"></output><input type="range" id="activityDarkness" min="0" max="100" value="0"></label><small>0% keeps the original appearance. Try 60–80% over bright images. Message text becomes light when boxes are enabled.</small></fieldset><p class="editor-note">Preview is approximate. Saved settings follow this theme across launches. Reset restores its original package appearance.</p></div></div>
<p id="editorNotice" class="editor-note" role="status" hidden></p><div class="editor-footer"><button class="secondary" id="resetTheme">Reset to package</button><div><button class="secondary" id="cancelEditor">Cancel</button><button class="primary" id="saveTheme">Save changes</button></div></div></dialog><div id="toast" class="toast" role="status" aria-live="polite"></div><script>${client}</script></body></html>`;
}
