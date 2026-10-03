// Shared image media detection - extensions are never trusted.

export function detectImageMedia(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.every((b, i) => bytes[i] === b)) return "image/png";
  if (bytes.length >= 12
    && bytes.subarray(0, 4).toString("latin1") === "RIFF"
    && bytes.subarray(8, 12).toString("latin1") === "WEBP") {
    return "image/webp";
  }
  return null;
}

// Header-only checks run before browser decoding. Kept self-contained so the
// identical validator can be serialized into the upload client.
export function inspectImage(bytes) {
  const fail=()=>{throw new Error('Invalid or truncated image dimensions');};
  const text=(offset,length)=>Array.from(bytes.subarray(offset,offset+length),b=>String.fromCharCode(b)).join('');
  const u16=offset=>bytes[offset]*256+bytes[offset+1];
  const u24=offset=>bytes[offset]+bytes[offset+1]*256+bytes[offset+2]*65536;
  const u32=offset=>bytes[offset]*16777216+bytes[offset+1]*65536+bytes[offset+2]*256+bytes[offset+3];
  let width,height,media;
  if([137,80,78,71,13,10,26,10].every((b,i)=>bytes[i]===b)){
    if(bytes.length<33||u32(8)!==13||text(12,4)!=='IHDR')fail();
    width=u32(16);height=u32(20);media='image/png';
  }else if(bytes[0]===255&&bytes[1]===216){
    let offset=2;
    while(offset<bytes.length){
      if(bytes[offset++]!==255)fail();
      while(bytes[offset]===255)offset++;
      const marker=bytes[offset++];
      if(marker===217||marker===218||marker===undefined)break;
      if(marker===1||(marker>=208&&marker<=215))continue;
      if(offset+2>bytes.length)fail();
      const length=u16(offset);if(length<2||offset+length>bytes.length)fail();
      if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)){
        if(length<11||length!==8+3*bytes[offset+7])fail();
        height=u16(offset+3);width=u16(offset+5);media='image/jpeg';break;
      }
      offset+=length;
    }
  }else if(text(0,4)==='RIFF'&&text(8,4)==='WEBP'){
    const little32=offset=>bytes[offset]+bytes[offset+1]*256+bytes[offset+2]*65536+bytes[offset+3]*16777216;
    if(bytes.length<20||little32(4)+8!==bytes.length)fail();
    const kind=text(12,4),size=little32(16);if(20+size>bytes.length)fail();
    if(kind==='VP8X'){
      if(size!==10)fail();
      if(bytes[20]&2)throw new Error('Animated WebP is not supported; choose a static background');
      width=1+u24(24);height=1+u24(27);
    }else if(kind==='VP8 '){
      if(size<10||bytes[23]!==157||bytes[24]!==1||bytes[25]!==42)fail();
      width=(bytes[26]+bytes[27]*256)&16383;height=(bytes[28]+bytes[29]*256)&16383;
    }else if(kind==='VP8L'){
      if(size<5||bytes[20]!==47)fail();
      width=1+bytes[21]+((bytes[22]&63)<<8);
      height=1+(bytes[22]>>6)+(bytes[23]<<2)+((bytes[24]&15)<<10);
    }else fail();
    media='image/webp';
  }
  if(!media||!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1)fail();
  if(width>16384||height>16384||width*height>40000000)throw new Error('Image exceeds 16,384 pixels per side or 40 million pixels; resize the original image');
  return {width,height,media};
}
