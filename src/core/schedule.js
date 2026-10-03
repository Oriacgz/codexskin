// Local wall-clock boundaries are recalculated each tick, including after resume.
export function validateSchedule(value) {
  if(!value || typeof value.enabled!=='boolean')throw new Error('Invalid schedule');
  if(!value.enabled)return {enabled:false};
  const time=/^(?:[01]\d|2[0-3]):[0-5]\d$/,id=/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
  if(!time.test(value.dayTime)||!time.test(value.nightTime)||value.dayTime===value.nightTime)throw new Error('Choose two different local times');
  if(![value.dayThemeId,value.nightThemeId].every(v=>typeof v==='string'&&v.length<=64&&id.test(v)))throw new Error('Choose installed themes');
  return {enabled:true,dayTime:value.dayTime,nightTime:value.nightTime,dayThemeId:value.dayThemeId,nightThemeId:value.nightThemeId};
}
export function scheduleSlot(schedule,now=new Date()) {
  const s=validateSchedule(schedule);if(!s.enabled)return null;
  const boundaries=[];
  for(const offset of [-1,0,1])for(const kind of ['day','night']){
    const [h,m]=s[kind+'Time'].split(':').map(Number);
    const date=new Date(now.getFullYear(),now.getMonth(),now.getDate()+offset,h,m);
    boundaries.push({at:date.getTime(),themeId:s[kind+'ThemeId']});
  }
  boundaries.sort((a,b)=>a.at-b.at);
  return {...boundaries.filter(b=>b.at<=now.getTime()).at(-1),nextAt:boundaries.find(b=>b.at>now.getTime()).at};
}
export function createScheduler({load,apply,now=()=>new Date()}) {
  let running=false,lastKey='';
  return async function tick(){
    if(running)return;running=true;
    try{
      const state=await load(),slot=scheduleSlot(state.schedule??{enabled:false},now());
      if(!slot || state.schedulePausedUntil>now().getTime())return;
      const key=JSON.stringify([state.schedule,slot.at]);
      if(key===lastKey&&state.activeThemeId===slot.themeId)return;
      await apply(slot.themeId);lastKey=key;
    }catch{/* Offline Codex or a removed theme: retry quietly on the next tick. */}
    finally{running=false;}
  };
}
export function manualSchedulePause(state,now=new Date()) {
  try{return scheduleSlot(state.schedule??{enabled:false},now)?.nextAt??0;}catch{return 0;}
}
