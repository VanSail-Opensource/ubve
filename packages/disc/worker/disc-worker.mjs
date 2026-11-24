import createDisc from './ubve-disc.mjs';
let module, image, files=new Map(), paths=[], reader, buffer=0, disposed=false;
const openFiles=new Map(), directories=new Map();let handle=0;
const MAX_READ=1024*1024, MAX_IMAGE=(2**32-1)*2048;
const clean = path => {
  const p=String(path).replaceAll('\\','/').replace(/^\/+|\/+$/g,'');
  if(p.length>4096 || p.includes('\0') || (p&&p.split('/').some(v=>!v||v==='.'||v==='..'||v.includes(':'))))throw Error('Invalid disc path');
  return p;
};
const key=path=>clean(path).toUpperCase();
const readBlob=(blob,offset,heap,ptr,length)=>{
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(length)||length<0||length>MAX_READ||offset+length>blob.size)return -1;
  const bytes=new Uint8Array(reader.readAsArrayBuffer(blob.slice(offset,offset+length)));
  if(bytes.length!==length)return -1;heap.set(bytes,ptr);return length;
};
const io={
  open(path){const blob=files.get(key(path));if(!blob||openFiles.size>=64)return -1;const id=++handle;openFiles.set(id,blob);return id;},
  size(id){return openFiles.get(id)?.size??-1;},
  read(id,offset,heap,ptr,length){const blob=openFiles.get(id);return blob?readBlob(blob,offset,heap,ptr,length):-1;},
  close(id){openFiles.delete(id);},
  opendir(path){if(directories.size>=64)return -1;const prefix=key(path);const names=new Map();for(const p of paths){if(prefix&&!p.toUpperCase().startsWith(prefix+'/'))continue;const part=p.slice(prefix?prefix.length+1:0).split('/')[0];if(part)names.set(part.toUpperCase(),part);}if(!names.size||names.size>4096)return -1;const id=++handle;directories.set(id,{names:[...names.values()],at:0});return id;},
  readdir(id){const d=directories.get(id);return d?.names[d.at++]??null;},
  closedir(id){directories.delete(id);},
  blocks(lba,heap,ptr,count){if(!image||!Number.isSafeInteger(lba)||lba<0||!Number.isSafeInteger(count)||count<1||count>512)return 0;const got=readBlob(image,lba*2048,heap,ptr,count*2048);return got<0?0:got/2048;},
  blockCount(){return image?Math.floor(image.size/2048):0;},
};
function cString(value,fn){const n=module.lengthBytesUTF8(value)+1,p=module._malloc(n);if(!p)throw Error('Disc path allocation failed');try{module.stringToUTF8(value,p,n);return fn(p);}finally{module._free(p);}}
async function command(data){
  if(disposed)throw Error('Disc owner disposed');
  if(data.type==='open'){
    if(module)throw Error('Disc source already open');
    reader=new FileReaderSync();image=data.image??null;
    if(image && (image.size>MAX_IMAGE||image.size<2048||image.size%2048))throw Error('Image outside admitted 2048-byte UDF block profile');
    for(const item of data.files??[]){const p=clean(item.path),k=key(p);if(files.has(k)||files.size>=16384)throw Error('Ambiguous or oversized folder');if(/(^|\/)(AACS|BDSVM|BDPLUS)(\/|$)/i.test(p))throw Error('Encrypted discs refused');files.set(k,item.blob);paths.push(p);}
    module=await createDisc({ubveIO:io,locateFile:name=>new URL(name,import.meta.url).href});
    buffer=module._malloc(MAX_READ);if(!buffer)throw Error('Disc read-buffer allocation failed');
    if(image&&!module._ubve_udf_open())throw Error('Invalid or unsupported UDF image');
    if(data.udfOnly)return {udf:true,qualification:'UNQUALIFIED'};
    const code=module._ubve_disc_open(image?1:0);if(code===-2)throw Error('Encrypted discs refused');if(code!==1)throw Error('No readable Blu-ray title filesystem');
    const p=module._ubve_disc_titles();if(!p)throw Error('Title inventory exceeded admitted bounds or is malformed');
    return JSON.parse(module.UTF8ToString(p));
  }
  if(!module)throw Error('Disc source not opened');
  if(data.type==='list'){
    if(!image){const prefix=key(data.path),names=new Map();for(const p of paths){if(prefix&&!p.toUpperCase().startsWith(prefix+'/'))continue;const rest=p.slice(prefix?prefix.length+1:0),name=rest.split('/')[0];if(name)names.set(name.toUpperCase(),{name,directory:rest.includes('/')});}if(names.size>4096)throw Error('Directory entry bound exceeded');return [...names.values()];}
    const p=cString(clean(data.path),p=>module._ubve_udf_list(p));if(!p)throw Error('Directory unreadable');return JSON.parse(module.UTF8ToString(p));
  }
  if(data.type==='stat'||data.type==='read'){
    const path=clean(data.path);if(!image){const blob=files.get(key(path));if(!blob)throw Error('File not found');if(data.type==='stat')return {size:blob.size};if(!Number.isSafeInteger(data.length)||data.length<0||data.length>MAX_READ||!Number.isSafeInteger(data.offset)||data.offset<0||data.offset+data.length>blob.size)throw Error('Invalid folder range');const bytes=new Uint8Array(data.length);const n=readBlob(blob,data.offset,bytes,0,data.length);if(n!==data.length)throw Error('Short file read');return bytes;}
    const h=cString(path,p=>module._ubve_udf_file_open(p));if(h<0)throw Error('UDF file not found');
    try{const size=module._ubve_udf_file_size(h);if(!Number.isSafeInteger(size)||size<0)throw Error('Invalid UDF size');if(data.type==='stat')return {size};
      if(!Number.isSafeInteger(data.offset)||data.offset<0||!Number.isSafeInteger(data.length)||data.length<0||data.length>MAX_READ||data.offset+data.length>size)throw Error('Invalid UDF range');
      const n=module._ubve_udf_read(h,data.offset,buffer,data.length);if(n!==data.length)throw Error('Short UDF read');return module.HEAPU8.slice(buffer,buffer+n);
    }finally{module._ubve_udf_file_close(h);}
  }
  if(data.type==='close'){module._ubve_disc_close();module._free(buffer);disposed=true;files.clear();paths=[];image=null;openFiles.clear();directories.clear();return {closed:true,physicalMemoryReclamation:'unobserved'};}
  throw Error('Unknown disc command');
}
let chain=Promise.resolve(),pending=0;
onmessage=event=>{
  const data=event.data;const identity={id:data?.id,stamp:data?.stamp,operationId:data?.operationId};if(!Number.isSafeInteger(data?.id)||pending>=4){postMessage({...identity,error:'Disc RPC admission full'});return;}pending++;
  chain=chain.then(async()=>{try{const result=await command(data);postMessage({...identity,result},result instanceof Uint8Array?[result.buffer]:[]);}catch(error){disposed=true;files.clear();image=null;openFiles.clear();directories.clear();postMessage({...identity,error:String(error?.message??error)});}finally{pending--;}});
};
