import pkg from '../../package.json' with {type:'json'};
export const currentVersion=pkg.version;
const endpoint='https://api.github.com/repos/Oriacgz/codexskin/releases/latest';
export function compareVersions(a,b){
  const parse=v=>{
    if(typeof v!=='string'||v.length>256)throw new Error('Invalid release version');
    const m=/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(v);
    if(!m||m[4]?.split('.').some(part=>/^0\d+$/.test(part)))throw new Error('Invalid release version');return m;
  };
  const x=parse(a),y=parse(b);
  for(let i=1;i<=3;i++){const d=BigInt(x[i])-BigInt(y[i]);if(d)return d>0n?1:-1;}
  if(!x[4]||!y[4])return x[4]===y[4]?0:x[4]?-1:1;
  const p=x[4].split('.'),q=y[4].split('.');
  for(let i=0;i<Math.max(p.length,q.length);i++){
    if(p[i]===q[i])continue;if(p[i]===undefined)return -1;if(q[i]===undefined)return 1;
    const n=/^\d+$/.test(p[i]),m=/^\d+$/.test(q[i]);
    if(n&&m){const d=BigInt(p[i])-BigInt(q[i]);if(d)return d>0n?1:-1;continue;}
    if(n!==m)return n?-1:1;return p[i]>q[i]?1:-1;
  }return 0;
}
export function verifiedReleaseUrl(value,tag){
  const url=new URL(value);
  if(url.origin!=='https://github.com'||url.username||url.password||url.search||url.hash||url.pathname!=='/Oriacgz/codexskin/releases/tag/'+encodeURIComponent(tag))throw new Error('Invalid release page');
  return url.href;
}
export async function checkUpdates(fetcher=fetch){
  try{
    const response=await fetcher(endpoint,{headers:{accept:'application/vnd.github+json','user-agent':'codexskin','X-GitHub-Api-Version':'2026-03-10'},redirect:'error',signal:AbortSignal.timeout(8000)});
    if(!response.ok)throw new Error('Release unavailable');
    const chunks=[];let size=0;
    for await(const chunk of response.body){size+=chunk.length;if(size>256*1024)throw new Error('Release too large');chunks.push(Buffer.from(chunk));}
    const release=JSON.parse(Buffer.concat(chunks));
    if(release.draft||release.prerelease)throw new Error('Stable release unavailable');
    const newer=compareVersions(release.tag_name,currentVersion)>0,url=verifiedReleaseUrl(release.html_url,release.tag_name);
    return {ok:true,currentVersion,version:release.tag_name,newer,url,notes:typeof release.body==='string'?release.body.slice(0,32000):''};
  }catch{return {ok:true,currentVersion,unavailable:true};}
}
