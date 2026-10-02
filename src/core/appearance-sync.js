// Runs in the Codex renderer. Resolve exports from the installed build rather
// than pinning minified names. Fail closed when its settings contract changes.
export async function syncNativeAppearance(settings) {
  if (!settings || typeof location === 'undefined' || !/^app:\/\/[^/]*\/index\.html/.test(location.href)) return {skipped:true};
  try {
    const entry=document.querySelector('script[src*="/assets/index-"]')?.src;
    if(!entry)return {supported:false};
    const entrySource=await (await fetch(entry)).text();
    const shared=entrySource.match(/\.\/app-shared-[\da-f]+\.js/)?.[0];
    if(!shared)return {supported:false};
    const url=new URL(shared,entry).href;
    const source=await (await fetch(url)).text();
    const requestName=source.match(/await ([\w$]+)\(`set-setting`,\{params:\{key:e\.key,value:t\}\}/)?.[1];
    if(!requestName)return {supported:false};
    const exported=source.match(new RegExp('(?:^|,)'+requestName.replace(/\$/g,'\\$')+' as ([\\w$]+)[,}]'))?.[1];
    if(!exported)return {supported:false};
    const module=await import(url);
    const request=module[exported];
    if(typeof request!=='function')return {supported:false};
    const snapshot=await request('get-settings');
    let changed=0;
    for(const key of ['appearanceLightChromeTheme','appearanceDarkChromeTheme']) {
      const original=snapshot?.values?.[key];
      if(!original || typeof original!=='object' || Array.isArray(original))continue;
      const next={...original,accent:settings.accent,accentSource:'custom',...(settings.textColorsEnabled?{ink:settings.primaryTextColor}:{})};
      if(JSON.stringify(next)===JSON.stringify(original))continue;
      await request('set-setting',{params:{key,value:next}});
      changed++;
    }
    const verified=await request('get-settings');
    const matched=['appearanceLightChromeTheme','appearanceDarkChromeTheme'].every(key=>{
      const value=verified?.values?.[key];
      return value?.accent===settings.accent && value?.accentSource==='custom' && (!settings.textColorsEnabled || value?.ink===settings.primaryTextColor);
    });
    return {supported:matched,changed};
  } catch {return {supported:false};}
}

