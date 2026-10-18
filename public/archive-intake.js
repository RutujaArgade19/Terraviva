(function(){
  'use strict';
  const $=id=>document.getElementById(id),MiB=1024*1024;
  let source=null,archive=null,inventory=null,selected=null,profileBundle=null,busy=false;
  const number=value=>Number(value).toLocaleString('en-GB');
  const size=value=>value>=1024**3?(value/1024**3).toFixed(2)+' GiB':value>=MiB?(value/MiB).toFixed(2)+' MiB':number(value)+' B';
  const format=name=>(name.split('/').pop().match(/\.([^.]+)$/)?.[1]||'no extension').toLowerCase();
  const yieldUI=()=>new Promise(resolve=>setTimeout(resolve,0));
  function status(id,message,error=false){$(id).textContent=message;$(id).classList.toggle('error',error);}
  function download(content,name,mime){const blob=content instanceof Blob?content:new Blob([content],{type:mime||'application/json'});const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}
  function downloadJSON(value,name){download(JSON.stringify(value,null,2)+'\n',name,'application/json');}
  function setBusy(value){busy=value;for(const id of ['archive-file','source-name','inspect-member','profile-all','member-select','hash-archive'])$(id).disabled=value;}
  function entryView(entry){return {index:entry.index,path:entry.name,format:entry.directory?'directory':format(entry.name),compressedBytes:entry.compressedSize,uncompressedBytes:entry.uncompressedSize,crc32:entry.crc32,compressionMethod:entry.method,encrypted:entry.encrypted,directory:entry.directory,localHeaderOffset:entry.localHeaderOffset};}
  function renderInventory(){
    const counts=[['ORIGINAL ARCHIVE',size(source.size),number(source.size)+' bytes'],['SOURCE FILES',number(archive.fileCount),number(archive.directoryCount)+' directory entries'],['UNCOMPRESSED CONTENT',size(archive.totalUncompressedBytes),'Declared in ZIP directory'],['DIRECTORY FORMAT',archive.zip64?'ZIP64':'ZIP','Member CRCs checked on extraction']];
    $('inventory-kpis').replaceChildren(...counts.map(([label,value,note])=>{const el=document.createElement('article'),small=document.createElement('small'),strong=document.createElement('strong'),caption=document.createElement('small');small.textContent=label;strong.textContent=value;caption.textContent=note;el.append(small,strong,caption);return el;}));
    $('inventory-rows').replaceChildren(...inventory.members.filter(e=>!e.directory).slice(0,2000).map(entry=>{const tr=document.createElement('tr');for(const value of [entry.path,entry.format,number(entry.uncompressedBytes),number(entry.compressedBytes),entry.encrypted?'Encrypted':entry.compressionMethod===0?'Stored':entry.compressionMethod===8?'Deflate':'Method '+entry.compressionMethod]){const td=document.createElement('td');td.textContent=value;tr.append(td);}return tr;}));
    $('inventory-caption').textContent=archive.fileCount>2000?'The first 2,000 file entries are shown. The inventory JSON includes every entry.':'Every file entry is listed. Sizes are directory declarations until extraction verifies them.';
    $('inventory-json').textContent=JSON.stringify(inventory,null,2);
    $('member-select').replaceChildren(...archive.entries.filter(e=>!e.directory).map(entry=>{const option=document.createElement('option');option.value=entry.index;option.textContent=entry.name+' · '+size(entry.uncompressedSize);return option;}));
    for(const id of ['inventory-section','member-section','profile-section'])$(id).hidden=false;
    $('download-inventory').disabled=false;
  }
  $('archive-file').addEventListener('change',async event=>{
    const file=event.target.files?.[0];if(!file||busy)return;
    source=file;archive=null;inventory=null;selected=null;profileBundle=null;
    $('download-inventory').disabled=true;$('download-member').disabled=true;$('download-profiles').disabled=true;
    $('member-preview').textContent='';$('profiles-json').textContent='';status('member-status','');status('profile-status','');status('hash-status','The archive checksum is measured separately from the directory inventory.');
    for(const id of ['inventory-section','member-section','profile-section'])$(id).hidden=true;
    setBusy(true);status('status','Reading the archive directory from '+number(file.size)+' bytes…');
    try{
      archive=await window.TerravivaZipSource.listArchive(file);
      inventory={schemaVersion:1,archive:{filename:$('source-name').value.trim()||file.name,bytes:file.size,sha256:null,memberCount:archive.entryCount,uncompressedBytes:archive.totalUncompressedBytes},generatedAt:new Date().toISOString(),scope:'ZIP central-directory inventory; member content not yet profiled',fileCount:archive.fileCount,directoryCount:archive.directoryCount,zip64:archive.zip64,members:archive.entries.map(entryView),notes:archive.notes||[]};
      renderInventory();status('status','Archive opened: '+number(archive.fileCount)+' files; '+number(file.size)+' original bytes.');
    }catch(error){status('status','Selected file: '+number(file.size)+' bytes. '+error.message,true);}finally{setBusy(false);}
  });
  $('download-inventory').addEventListener('click',()=>{if(inventory)downloadJSON(inventory,'Terraviva_Archive_Inventory.json');});
  $('hash-archive').addEventListener('click',async()=>{
    if(!source||!inventory||busy)return;setBusy(true);status('hash-status','Calculating SHA-256 over the original archive bytes…');
    try{
      const hash=window.sha256.create();let offset=0;
      while(offset<source.size){const end=Math.min(source.size,offset+8*MiB);hash.update(new Uint8Array(await source.slice(offset,end).arrayBuffer()));offset=end;status('hash-status','SHA-256: '+(offset/source.size*100).toFixed(1)+'% · '+number(offset)+' / '+number(source.size)+' bytes');await yieldUI();}
      inventory.archive.sha256=hash.hex();$('inventory-json').textContent=JSON.stringify(inventory,null,2);
      if(profileBundle){profileBundle.archive.sha256=inventory.archive.sha256;profileBundle.coverage.notes=profileBundle.coverage.notes.filter(note=>!note.startsWith('Original archive SHA-256'));$('profiles-json').textContent=JSON.stringify(profileBundle,null,2);}
      status('hash-status','Archive SHA-256 verified over '+number(source.size)+' bytes: '+inventory.archive.sha256);
    }catch(error){status('hash-status',error.message,true);}finally{setBusy(false);}
  });
  $('member-select').addEventListener('change',()=>{selected=null;$('download-member').disabled=true;});
  $('inspect-member').addEventListener('click',async()=>{
    if(!archive||busy)return;const entry=archive.entries.find(e=>e.index===Number($('member-select').value));if(!entry)return;
    setBusy(true);selected=null;$('download-member').disabled=true;$('member-preview').textContent='';status('member-status','Reading '+entry.name+'…');await yieldUI();
    try{
      const bytes=await window.TerravivaZipSource.readEntry(source,entry,{maxUncompressedBytes:256*MiB,maxCompressedBytes:256*MiB});
      const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
      selected={entry,bytes,sha256:hash};$('download-member').disabled=false;
      let preview;try{preview=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,Math.min(bytes.length,64000)),{stream:bytes.length>64000});}catch{preview='Binary content or text that is not valid UTF-8 in this bounded preview.';}
      $('member-preview').textContent=preview.slice(0,16000);
      status('member-status',entry.name+' · '+number(bytes.length)+' verified bytes · CRC-32 verified · SHA-256 '+hash+'. Preview limited to 16,000 characters.');
    }catch(error){status('member-status',error.message,true);}finally{setBusy(false);}
  });
  $('download-member').addEventListener('click',()=>{if(selected)download(selected.bytes,selected.entry.name.split('/').pop()||'source.bin','application/octet-stream');});
  $('download-profiles').addEventListener('click',()=>{if(profileBundle)downloadJSON(profileBundle,'Terraviva_Archive_Profiles.json');});
  $('profile-all').addEventListener('click',async()=>{
    if(!archive||busy)return;setBusy(true);$('download-profiles').disabled=true;
    const files=[],tables=[],exclusions=[],members=archive.entries.filter(e=>!e.directory);
    try{
      for(const [position,entry] of members.entries()){
        status('profile-status','Inspecting '+(position+1)+' / '+members.length+': '+entry.name);await yieldUI();
        const reason=!/\.(csv|tsv|json)$/i.test(entry.name)?'Unsupported tabular format for the current CSV/TSV/JSON profiler.':entry.uncompressedSize>window.TerravivaEDA.limits.maxFileBytes?'Exceeds the 20 MiB complete-table profiler limit.':null;
        if(reason){files.push({id:'source-'+entry.index,path:entry.name,format:format(entry.name),bytes:entry.uncompressedSize,status:'not-profiled',notes:[reason]});exclusions.push({source:entry.name,reason});continue;}
        try{
          const bytes=await window.TerravivaZipSource.readEntry(source,entry,{maxUncompressedBytes:20*MiB,maxCompressedBytes:64*MiB});
          const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
          const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes),profile=window.TerravivaEDA.analyzeText(text,{filename:entry.name,sizeBytes:bytes.length});
          const normalized=window.TerravivaArchiveProfile.normalizeProfile(profile,{fileId:'source-'+entry.index,path:entry.name,sha256:hash,bytes:bytes.length});
          files.push(normalized.file);tables.push(...normalized.tables);
        }catch(error){files.push({id:'source-'+entry.index,path:entry.name,format:format(entry.name),bytes:entry.uncompressedSize,status:'not-profiled',notes:[error.message]});exclusions.push({source:entry.name,reason:error.message});}
      }
      profileBundle={schemaVersion:1,archive:inventory.archive,generatedAt:new Date().toISOString(),status:'partial',coverage:{fileCount:members.length,parsedFileCount:files.filter(f=>f.status==='profiled').length,profiledTableCount:tables.length,profiledRows:tables.reduce((n,t)=>n+t.profiledRows,0),complete:false,notes:[...(!inventory.archive.sha256?['Original archive SHA-256 has not yet been calculated.']:[]),'Total source table count and row count are unknown for excluded members.']},files,tables,exclusions,methods:{version:'Terraviva EDA '+window.TerravivaEDA.version,notes:['Every accepted table is profiled in full within the declared interactive profiler limits.','CSV/TSV/JSON only; UTF-8 decoding is strict.','Source rows are omitted from this derived profile export. Category values remain source-derived information.']}};
      $('profiles-json').textContent=JSON.stringify(profileBundle,null,2);$('download-profiles').disabled=false;
      status('profile-status','Measured '+number(profileBundle.coverage.profiledRows)+' rows across '+tables.length+' table profiles. '+exclusions.length+' members excluded; see reasons.'+(!inventory.archive.sha256?' Archive checksum still required for the permanent report.':''));
    }catch(error){status('profile-status',error.message,true);}finally{setBusy(false);}
  });
})();
