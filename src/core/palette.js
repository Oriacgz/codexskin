// Local image samples only. Suggestions never change a theme until selected.
export function suggestPalette(samples) {
  if (!Array.isArray(samples) || !samples.length || samples.length > 4096 || samples.some(c=>!Array.isArray(c)||c.length!==3||c.some(v=>!Number.isFinite(v)||v<0||v>255))) throw new Error('Choose a readable background image first');
  const bins=new Map();
  for(const color of samples){const key=color.map(v=>Math.min(255,Math.round(v/32)*32)).join(',');const bin=bins.get(key)??{color:key.split(',').map(Number),count:0};bin.count++;bins.set(key,bin);}
  const candidates=[...bins.values()].sort((a,b)=>b.count-a.count),colors=[];
  for(const candidate of candidates){if(colors.every(c=>Math.hypot(...c.map((v,i)=>v-candidate.color[i]))>=45))colors.push(candidate.color);if(colors.length===5)break;}
  const hex=c=>'#'+c.map(v=>Math.round(v).toString(16).padStart(2,'0')).join('');
  const vivid=[...colors].sort((a,b)=>(Math.max(...b)-Math.min(...b))-(Math.max(...a)-Math.min(...a)))[0];
  const average=samples.reduce((sum,c)=>sum+c[0]*.2126+c[1]*.7152+c[2]*.0722,0)/samples.length;
  const primary=average>155?[24,32,31]:[244,246,248];
  return {colors:colors.map(hex),accent:hex(vivid),primary:hex(primary),secondary:hex(primary.map((v,i)=>v*.7+colors[0][i]*.3))};
}
