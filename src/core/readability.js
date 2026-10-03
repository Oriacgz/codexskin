// Advisory worst-case contrast over sampled image colors; never blocks saving.
export function assessContrast(settings, samples = [[16,19,22]]) {
  const rgb = hex => [1,3,5].map(i=>parseInt(hex.slice(i,i+2),16));
  const luminance = channels => channels.map(v=>{const n=v/255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4;}).reduce((sum,n,i)=>sum+n*[.2126,.7152,.0722][i],0);
  const blend=(a,b,alpha)=>a.map((v,i)=>v*alpha+b[i]*(1-alpha));
  const darkness=settings.sidebarDarkness/100;
  const sidebar=blend([16,19,22],rgb(settings.sidebarColor),darkness);
  const surfaces=[['Sidebar',sidebar,settings.sidebarOpacity],['Composer',rgb(settings.chatColor),settings.chatOpacity],['Pages',[16,19,22],settings.pageOpacity],['Dialogs',[16,19,22],settings.dialogOpacity],['Your messages',[16,19,22],settings.userMessageDarkness],['AI replies',[16,19,22],settings.assistantMessageDarkness],['Activity',[16,19,22],settings.activityDarkness]];
  const texts=[['Primary',rgb(settings.textColorsEnabled?settings.primaryTextColor:'#f4f6f8')],['Secondary',rgb(settings.textColorsEnabled?settings.secondaryTextColor:'#a1a8b0')]];
  return surfaces.flatMap(([surface,color,opacity])=>texts.map(([label,text])=>{
    const ratio=Math.min(...samples.map(sample=>{
      const background=blend(color,sample.map(v=>Math.min(255,v*settings.brightness/100)),opacity/100);
      const a=luminance(text),b=luminance(background);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
    }));
    return {surface,text:label,ratio,low:ratio<4.5};
  }));
}
