'use strict';

// Build-time rendering only. The source-derived analysis is deliberately separate
// from the browser's replaceable file profiler and contains no raw source rows.
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const list = value => Array.isArray(value) ? value : [];
const finite = value => typeof value === 'number' && Number.isFinite(value);
const knownCount = value => Number.isSafeInteger(value) && value >= 0;
const fmt = (value, digits = 2) => finite(value) ? new Intl.NumberFormat('en-GB', {maximumFractionDigits:digits}).format(value) : '—';
const pct = (value, total) => finite(value) && finite(total) && total > 0 ? fmt(value / total * 100, 1) + '%' : '—';
const bytes = value => !finite(value) ? '—' : value >= 1024 ** 3 ? fmt(value / 1024 ** 3, 2) + ' GiB' : value >= 1024 ** 2 ? fmt(value / 1024 ** 2, 2) + ' MiB' : value >= 1024 ? fmt(value / 1024, 1) + ' KiB' : fmt(value, 0) + ' bytes';
const paragraphs = items => list(items).map(text => '<p>' + esc(text) + '</p>').join('');
const noteList = items => list(items).length ? '<ul class="archive-notes">' + list(items).map(text => '<li>' + esc(text) + '</li>').join('') + '</ul>' : '';
const labels = {numeric:'Numeric measure', date:'Date / time', categorical:'Category', text:'Text', identifier:'Identifier', boolean:'Boolean', structured:'Structured', mixed:'Mixed', empty:'Empty'};
const plainStatus = value => String(value || 'not recorded').replace(/[-_]/g, ' ');
const isCollection = report => report.archive?.kind === 'source-collection';
const retrievedFiles = report => list(report.files).filter(file => !isCollection(report) || file.retrievalStatus === 'retrieved');

// Every embedded field is selected from this schema and recursively copied.
// Unknown keys are rejected, even inside otherwise legitimate nested objects.
// A raw payload can therefore never ride along in the downloadable analysis.
const analysisSchema={
  schemaVersion:'count',status:'text',generatedAt:'text',title:'text',summary:['text'],
  archive:{kind:'text',filename:'text',bytes:'count',sha256:'text',memberCount:'count',uncompressedBytes:'count',originalArchiveFilename:'text',inventoryBasis:'text',inventoryComplete:'boolean'},
  coverage:{fileCount:'count',retrievedFileCount:'count',unretrievedFileCount:'count',retrievedBytes:'count',parsedFileCount:'count',tableCount:'count',profiledTableCount:'count',totalTableRows:'count',profiledRows:'count',complete:'boolean',notes:['text']},
  files:[{id:'text',path:'text',format:'text',bytes:'count',sha256:'text',status:'text',retrievalStatus:'text',notes:['text']}],
  tables:[{
    id:'text',name:'text',fileId:'text',sourcePath:'text',pointer:'text',grain:'text',role:'text',
    rowCount:'count',profiledRows:'count',columnCount:'count',duplicateCount:'count',missingCellCount:'count',completeRowCount:'count',
    columns:[{
      key:'text',name:'text',type:'text',unit:'text',description:'text',nonMissingCount:'count',missingCount:'count',uniqueCount:'count',
      numeric:{n:'count',mean:'number',median:'number',p25:'number',p75:'number',sampleSd:'number',min:'number',max:'number',outlierCount:'count',histogram:{method:'text',bins:[{low:'number',high:'number',count:'count'}]}},
      frequencies:[{label:'text',count:'count'}],
      dates:{min:'text',max:'text',distinctDays:'count',calendarDays:'count',daysWithoutRecords:'count',dayCounts:[{date:'text',count:'count'}],monthCounts:[{month:'text',count:'count'}]}
    }],
    numericPairs:[{xName:'text',yName:'text',n:'count',r:'number',status:'text'}],
    keyCandidates:[{columns:['text'],uniqueCount:'count',missingCount:'count',duplicateCount:'count',note:'text'}],
    notes:['text'],issues:[{severity:'text',message:'text'}]
  }],
  findings:[{title:'text',body:'text',implication:'text',evidence:[{tableId:'text',fileId:'text',column:'text',metric:'text',text:'text'}]}],
  relationships:[{leftTableId:'text',rightTableId:'text',keys:['text'],status:'text',matchedCount:'count',unmatchedLeft:'count',unmatchedRight:'count',note:'text'}],
  exclusions:[{source:'text',reason:'text',rows:'count'}],
  staging:{status:'text',publishedTables:'count',unpublishedTables:'count',notes:['text']},
  methods:{version:'text',notes:['text']}
};

function normalizeAnalysis(value,schema=analysisSchema,label='report',nullable=false){
  if(value===null||value===undefined){if(nullable&&schema!=='boolean')return value;throw Error(label+' cannot be null or absent; boolean controls require true or false.');}
  if(typeof schema==='string'){
    const valid=schema==='text'?typeof value==='string':schema==='boolean'?typeof value==='boolean':schema==='count'?knownCount(value):finite(value);
    if(!valid)throw Error(label+' must be '+({text:'plain text',boolean:'a boolean',count:'a non-negative safe integer',number:'a finite number'}[schema])+'.');
    return value;
  }
  if(Array.isArray(schema)){
    if(!Array.isArray(value))throw Error(label+' must be an array.');
    return value.map((item,index)=>normalizeAnalysis(item,schema[0],label+'['+index+']'));
  }
  if(typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw Error(label+' must be a plain JSON object.');
  const result={};
  for(const key of Reflect.ownKeys(value)){
    if(typeof key!=='string'||!Object.hasOwn(schema,key))throw Error('Unknown archive analysis field '+label+'.'+String(key)+'; raw rows and unsupported metadata are not permitted.');
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if(!descriptor||!Object.hasOwn(descriptor,'value'))throw Error(label+'.'+key+' must be plain JSON data.');
    const normalized=normalizeAnalysis(descriptor.value,schema[key],label+'.'+key,true);
    if(normalized!==undefined)result[key]=normalized;
  }
  return result;
}

function atMost(value,maximum,label){if(knownCount(value)&&knownCount(maximum)&&value>maximum)throw Error(label+' exceeds its declared population.');}
function atLeast(value,minimum,label){if(knownCount(value)&&knownCount(minimum)&&value<minimum)throw Error(label+' is smaller than the represented scope.');}
function equalCount(value,expected,label){if(knownCount(value)&&knownCount(expected)&&value!==expected)throw Error(label+' does not reconcile with its represented scope.');}
function countSum(values,label){const sum=values.filter(knownCount).reduce((total,value)=>total+value,0);if(!knownCount(sum))throw Error(label+' exceeds the supported integer range.');return sum;}
function calendarDay(value){return typeof value==='string'&&/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;}
function calendarMonth(value){return typeof value==='string'&&/^\d{4}-(0[1-9]|1[0-2])$/.test(value);}

function validateArchive(input) {
  const report=normalizeAnalysis(input),coverage=report.coverage||{},files=list(report.files),tables=list(report.tables);
  if(report.schemaVersion!==1)throw Error('Archive analysis requires schemaVersion: 1.');
  if(!['complete','partial'].includes(report.status))throw Error('Archive analysis status must be complete or partial.');
  if(!report.archive||!report.archive.filename?.trim())throw Error('Archive analysis requires the original archive or source-collection filename.');
  if(report.archive.kind!==undefined&&!['zip','source-collection'].includes(report.archive.kind))throw Error('Unsupported archive provenance kind.');
  const collection=isCollection(report);
  if(collection){
    if(typeof report.archive.inventoryComplete!=='boolean'||!report.archive.inventoryBasis?.trim())throw Error('Source-collection analysis requires an explicit inventory basis and boolean completeness.');
    for(const key of ['bytes','sha256','memberCount','uncompressedBytes'])if(report.archive[key]!==undefined&&report.archive[key]!==null)throw Error('Source-collection analysis must not claim original ZIP '+key+'.');
    for(const key of ['retrievedFileCount','retrievedBytes'])if(!knownCount(coverage[key]))throw Error('Source-collection analysis requires measured '+key+'.');
    if(report.archive.inventoryComplete!==true&&report.status==='complete')throw Error('Complete source-collection analysis requires a complete inventory.');
  }else if(!knownCount(report.archive.bytes)||!/^[a-fA-F0-9]{64}$/.test(report.archive.sha256||''))throw Error('Archive analysis requires the original ZIP byte count and SHA-256.');
  if((report.status==='complete')!==(coverage.complete===true))throw Error('Archive status and boolean coverage.complete must agree.');
  atMost(coverage.parsedFileCount,coverage.fileCount,'coverage.parsedFileCount');
  atMost(coverage.profiledTableCount,coverage.tableCount,'coverage.profiledTableCount');
  atMost(coverage.profiledRows,coverage.totalTableRows,'coverage.profiledRows');
  atMost(coverage.fileCount,report.archive.memberCount,'coverage.fileCount');
  atLeast(coverage.fileCount,files.length,'coverage.fileCount');
  atLeast(coverage.tableCount,tables.length,'coverage.tableCount');
  equalCount(coverage.profiledTableCount,tables.length,'coverage.profiledTableCount');
  const fileIds=new Set(),tableIds=new Set(),profileFileIds=new Set();
  for(const file of files){
    if(!file.id||fileIds.has(file.id))throw Error('Archive file identifiers must be non-empty and unique.');
    fileIds.add(file.id);
    if(file.sha256!==undefined&&file.sha256!==null&&!/^[a-fA-F0-9]{64}$/.test(file.sha256))throw Error('Invalid member SHA-256 for '+file.id+'.');
    if(collection){
      if(!['retrieved','not-retrieved'].includes(file.retrievalStatus))throw Error('Source-collection file '+file.id+' requires an explicit retrieval status.');
      if(file.retrievalStatus==='retrieved'&&(!knownCount(file.bytes)||!/^[a-fA-F0-9]{64}$/.test(file.sha256||'')))throw Error('Retrieved file '+file.id+' requires original byte count and SHA-256.');
      if(file.retrievalStatus==='not-retrieved'&&((file.bytes!==null&&file.bytes!==undefined)||(file.sha256!==null&&file.sha256!==undefined)))throw Error('Unretrieved file '+file.id+' must not claim measured original bytes or SHA-256.');
    }
  }
  if(collection){
    const retrieved=retrievedFiles(report);
    equalCount(coverage.retrievedFileCount,retrieved.length,'coverage.retrievedFileCount');
    equalCount(coverage.retrievedBytes,countSum(retrieved.map(file=>file.bytes),'Retrieved file bytes'),'coverage.retrievedBytes');
    atMost(coverage.parsedFileCount,coverage.retrievedFileCount,'coverage.parsedFileCount');
    atMost(coverage.retrievedFileCount,coverage.fileCount,'coverage.retrievedFileCount');
    atLeast(coverage.unretrievedFileCount,files.length-retrieved.length,'coverage.unretrievedFileCount');
    if(knownCount(coverage.fileCount)&&knownCount(coverage.unretrievedFileCount))equalCount(coverage.retrievedFileCount+coverage.unretrievedFileCount,coverage.fileCount,'Retrieved and unretrieved file counts');
    if(report.archive.inventoryComplete){
      if(!knownCount(coverage.fileCount)||!knownCount(coverage.unretrievedFileCount))throw Error('A complete collection inventory requires measured expected and unretrieved file counts.');
      equalCount(coverage.fileCount,files.length,'Complete collection inventory');
      equalCount(coverage.unretrievedFileCount,files.length-retrieved.length,'Complete collection unretrieved count');
    }
  }
  atMost(countSum(files.map(file=>file.bytes),'Listed member bytes'),report.archive.uncompressedBytes,'Listed member bytes');
  for(const table of tables){
    if(!table.id||tableIds.has(table.id))throw Error('Archive table identifiers must be non-empty and unique.');
    tableIds.add(table.id);
    if(table.fileId&&!fileIds.has(table.fileId))throw Error('Unknown source file for table '+table.id+'.');
    if(collection&&(!table.fileId||files.find(file=>file.id===table.fileId)?.retrievalStatus!=='retrieved'))throw Error('Source-collection table '+table.id+' must cite a retrieved file.');
    if(table.fileId)profileFileIds.add(table.fileId);
    if(table.role!==undefined&&table.role!==null&&!['reference','unknown'].includes(table.role))throw Error('Unsupported table role for '+table.id+'.');
    const columns=list(table.columns),rows=table.profiledRows;
    atMost(rows,table.rowCount,table.id+'.profiledRows');
    atMost(columns.length,table.columnCount,table.id+'.column profiles');
    atMost(table.completeRowCount,rows,table.id+'.completeRowCount');
    atMost(table.duplicateCount,knownCount(rows)?Math.max(0,rows-1):null,table.id+'.duplicateCount');
    const cells=knownCount(rows)&&knownCount(table.columnCount)?rows*table.columnCount:null;
    if(cells!==null&&!knownCount(cells))throw Error(table.id+' cell count exceeds the supported integer range.');
    atMost(table.missingCellCount,cells,table.id+'.missingCellCount');
    if(columns.length===table.columnCount&&columns.every(column=>knownCount(column.missingCount)))equalCount(table.missingCellCount,countSum(columns.map(column=>column.missingCount),table.id+'.missing cells'),table.id+'.missingCellCount');
    for(const column of columns){
      const name=table.id+'.'+(column.name||column.key||'unnamed field'),present=column.nonMissingCount;
      atMost(present,rows,name+'.nonMissingCount');atMost(column.missingCount,rows,name+'.missingCount');
      if(knownCount(rows)&&knownCount(present)&&knownCount(column.missingCount)&&present+column.missingCount!==rows)throw Error('Present and missing counts do not reconcile for '+name+'.');
      atMost(column.uniqueCount,present,name+'.uniqueCount');
      for(const item of list(column.frequencies))if(typeof item.label!=='string'||!knownCount(item.count))throw Error(name+' frequency entries require text labels and measured counts.');
      if(countSum(list(column.frequencies).map(item=>item.count),name+'.frequencies')>(knownCount(present)?present:Infinity))throw Error('Category counts exceed present values for '+name+'.');
      if(column.numeric){
        const numeric=column.numeric;
        atMost(numeric.n,present,name+'.numeric.n');atMost(numeric.n,rows,name+'.numeric.n');
        atMost(numeric.outlierCount,numeric.n,name+'.numeric.outlierCount');atMost(numeric.outlierCount,present,name+'.numeric.outlierCount');atMost(numeric.outlierCount,rows,name+'.numeric.outlierCount');
        if(finite(numeric.sampleSd)&&numeric.sampleSd<0)throw Error(name+'.numeric.sampleSd cannot be negative.');
        const bins=list(numeric.histogram?.bins);
        for(const bin of bins){if(!finite(bin.low)||!finite(bin.high)||bin.high<bin.low||!knownCount(bin.count))throw Error(name+' histogram bins require valid bounds and measured counts.');atMost(bin.count,numeric.n,name+'.histogram count');}
        const binCount=countSum(bins.map(bin=>bin.count),name+'.histogram counts');atMost(binCount,numeric.n,name+'.histogram counts');atMost(binCount,present,name+'.histogram counts');atMost(binCount,rows,name+'.histogram counts');
      }
      if(column.dates){
        const dates=column.dates;
        atMost(dates.distinctDays,dates.calendarDays,name+'.distinctDays');
        atMost(dates.daysWithoutRecords,dates.calendarDays,name+'.daysWithoutRecords');
        for(const [key,labelKey,valid] of [['dayCounts','date',calendarDay],['monthCounts','month',calendarMonth]]){
          const seen=new Set(),buckets=list(dates[key]);
          for(const bucket of buckets){if(!valid(bucket[labelKey])||!knownCount(bucket.count)||seen.has(bucket[labelKey]))throw Error(name+'.'+key+' requires unique, real calendar buckets and measured counts.');seen.add(bucket[labelKey]);atMost(bucket.count,present,name+'.'+key+' count');atMost(bucket.count,rows,name+'.'+key+' count');}
          const total=countSum(buckets.map(bucket=>bucket.count),name+'.'+key+' counts');atMost(total,present,name+'.'+key+' counts');atMost(total,rows,name+'.'+key+' counts');
        }
      }
    }
    for(const pair of list(table.numericPairs)){atMost(pair.n,rows,table.id+'.numericPairs.n');if(finite(pair.r)&&(pair.r<-1||pair.r>1))throw Error(table.id+' Pearson r must be within [-1, 1].');}
    for(const key of list(table.keyCandidates))for(const name of ['uniqueCount','missingCount','duplicateCount'])atMost(key[name],rows,table.id+'.keyCandidates.'+name);
  }
  atLeast(coverage.parsedFileCount,profileFileIds.size,'coverage.parsedFileCount');
  if(tables.length)atLeast(coverage.parsedFileCount,1,'coverage.parsedFileCount');
  const profiledRows=countSum(tables.map(table=>table.profiledRows),'Table profiled rows'),sourceRows=countSum(tables.map(table=>table.rowCount),'Table source rows');
  atLeast(coverage.profiledRows,profiledRows,'coverage.profiledRows');
  if(tables.every(table=>knownCount(table.profiledRows)))equalCount(coverage.profiledRows,profiledRows,'coverage.profiledRows');
  atLeast(coverage.totalTableRows,sourceRows,'coverage.totalTableRows');
  if(coverage.tableCount===tables.length&&tables.every(table=>knownCount(table.rowCount)))equalCount(coverage.totalTableRows,sourceRows,'coverage.totalTableRows');
  if(report.status==='complete'){
    for(const key of ['fileCount','parsedFileCount','tableCount','profiledTableCount','totalTableRows','profiledRows'])if(!knownCount(coverage[key]))throw Error('Complete coverage requires measured '+key+'.');
    if(list(report.exclusions).length)throw Error('Any excluded source requires partial archive status.');
    equalCount(coverage.fileCount,files.length,'Complete file inventory');
    equalCount(coverage.parsedFileCount,coverage.fileCount,'Complete file parsing');
    equalCount(coverage.tableCount,tables.length,'Complete table inventory');
    equalCount(coverage.profiledRows,coverage.totalTableRows,'Complete row coverage');
    for(const table of tables){
      if(!table.fileId||!knownCount(table.rowCount)||!knownCount(table.profiledRows)||!knownCount(table.columnCount)||table.rowCount!==table.profiledRows||list(table.columns).length!==table.columnCount)throw Error('Complete archive coverage requires every source table, row and field to be represented.');
      if(list(table.columns).some(column=>!knownCount(column.nonMissingCount)||!knownCount(column.missingCount)))throw Error('Complete archive coverage requires measured field completeness.');
    }
  }
  for(const finding of list(report.findings))for(const ref of list(finding.evidence)){
    if(ref.tableId&&!tableIds.has(ref.tableId))throw Error('Finding cites unknown table '+ref.tableId+'.');
    if(ref.fileId&&!fileIds.has(ref.fileId))throw Error('Finding cites unknown file '+ref.fileId+'.');
  }
  for(const relation of list(report.relationships))if(!tableIds.has(relation.leftTableId)||!tableIds.has(relation.rightTableId))throw Error('Relationship cites an unknown table.');
  return report;
}

function kpi(label, value, caption, id = '') {
  return '<article><p>' + esc(label) + '</p><strong' + (id ? ' id="' + id + '"' : '') + '>' + esc(value) + '</strong><small' + (id === 'scope-kpi' ? ' id="scope-kpi-caption"' : '') + '>' + esc(caption) + '</small></article>';
}

function svg(body, title, width, height) {
  return '<svg class="chart-svg archive-chart" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="' + esc(title) + '"><title>' + esc(title) + '</title>' + body + '</svg>';
}

function bars(rows, title, {denominator = null, color = '#718b51', suffix = '', maxRows = 12} = {}) {
  const valid = rows.filter(row => finite(row.count) && row.count >= 0).slice(0, maxRows);
  if (!valid.length) return '<p class="caption">No measured values are available for this view.</p>';
  const width = 560, left = 185, right = 82, top = 10, gap = 29, maximum = Math.max(...valid.map(row => row.count), 1);
  const scale = finite(denominator) && denominator > 0 ? denominator : maximum;
  let body = '';
  valid.forEach((row, index) => {
    const y = top + index * gap, label = String(row.label), short = label.length > 29 ? label.slice(0,28) + '…' : label;
    const display = row.display || fmt(row.count, 0) + suffix;
    body += '<text x="0" y="' + (y + 11) + '"><title>' + esc(label) + '</title>' + esc(short) + '</text><rect x="' + left + '" y="' + y + '" width="' + (width-left-right) + '" height="14" rx="3" fill="#ebeedf"/><rect x="' + left + '" y="' + y + '" width="' + Math.max(0,Math.min(width-left-right,(width-left-right)*row.count/scale)) + '" height="14" rx="3" fill="' + color + '"><title>' + esc(label) + ': ' + esc(display) + '</title></rect><text x="' + (width-2) + '" y="' + (y+11) + '" text-anchor="end">' + esc(display) + '</text>';
  });
  return svg(body, title, width, top + valid.length * gap + 7);
}

function histogram(column) {
  const numeric = column.numeric, bins = list(numeric?.histogram?.bins).filter(bin => finite(bin.low) && finite(bin.high) && bin.high >= bin.low && finite(bin.count) && bin.count >= 0);
  if (!bins.length) return '';
  const span=bins[0].high-bins[0].low,tolerance=Math.max(1,Math.abs(span))*1e-9;
  const regular=bins.length===1||span>0&&bins.every((bin,index)=>Math.abs(bin.high-bin.low-span)<=tolerance&&(!index||Math.abs(bin.low-bins[index-1].high)<=tolerance));
  if(!regular)return '<article class="panel"><div class="panel-heading"><h3>'+esc(column.name)+(column.unit?' · '+esc(column.unit):'')+'</h3><span class="micro-label">INTERVAL COUNTS</span></div>'+bars(bins.map(bin=>({label:fmt(bin.low,4)+' → '+fmt(bin.high,4),count:bin.count})),'Counts in supplied intervals for '+column.name)+'<p class="caption">Supplied numeric intervals are unequal or non-contiguous, so these are labeled interval counts rather than a uniform-axis histogram.'+(bins.length>12?' The first 12 intervals are shown; the archive analysis JSON includes every supplied bin.':'')+'</p></article>';
  const width=500,height=235,left=46,right=12,top=25,bottom=40,innerW=width-left-right,innerH=height-top-bottom,maximum=Math.max(...bins.map(bin=>bin.count),1);
  let body='';
  for(let step=0;step<=4;step++) {const y=top+innerH-innerH*step/4;body+='<line class="grid" x1="'+left+'" x2="'+(width-right)+'" y1="'+y+'" y2="'+y+'"/><text x="'+(left-8)+'" y="'+(y+3)+'" text-anchor="end">'+fmt(maximum*step/4,1)+'</text>';}
  bins.forEach((bin,index)=>{const slot=innerW/bins.length,barH=innerH*bin.count/maximum;body+='<rect class="hist-bar" x="'+(left+slot*index+1)+'" y="'+(top+innerH-barH)+'" width="'+Math.max(.2,slot-2)+'" height="'+barH+'" rx="1"><title>'+fmt(bin.low,6)+' to '+fmt(bin.high,6)+': '+fmt(bin.count,0)+'</title></rect>';});
  body+='<text x="'+left+'" y="12">COUNT</text><text x="'+left+'" y="'+(height-15)+'">'+fmt(bins[0].low,4)+'</text><text x="'+(width-right)+'" y="'+(height-15)+'" text-anchor="end">'+fmt(bins.at(-1).high,4)+'</text>';
  const unit=column.unit?' · '+column.unit:'';
  return '<article class="panel"><div class="panel-heading"><h3>'+esc(column.name)+esc(unit)+'</h3><span class="micro-label">DISTRIBUTION</span></div>'+svg(body,'Histogram of '+column.name+unit,width,height)+'<p class="caption">'+fmt(numeric.n,0)+' valid values · median '+fmt(numeric.median,4)+' · '+esc(numeric.histogram.method||'Histogram bins supplied by the batch analysis')+'. Every numeric field is summarized in the table below.</p></article>';
}

function timeChart(column) {
  const dates=column.dates;
  if(!dates)return '';
  const months=list(dates.monthCounts),days=list(dates.dayCounts),monthly=months.length>0 && (dates.calendarDays>120 || !days.length),source=monthly?months:days;
  const points=source.map(row=>{const label=monthly?row.month:row.date;const x=monthly&&/^\d{4}-\d{2}$/.test(label||'')?Number(label.slice(0,4))*12+Number(label.slice(5,7))-1:!monthly?Date.parse(String(label)+'T00:00:00Z')/86400000:NaN;return {label,x,count:row.count};}).filter(row=>finite(row.x)&&finite(row.count)&&row.count>=0).sort((a,b)=>a.x-b.x);
  if(!points.length)return '';
  const width=500,height=215,left=45,right=15,top=24,bottom=40,iw=width-left-right,ih=height-top-bottom,first=points[0],last=points.at(-1),span=Math.max(1,last.x-first.x+1),maximum=Math.max(...points.map(row=>row.count),1);
  let body='';
  for(let step=0;step<=3;step++){const y=top+ih-ih*step/3;body+='<line class="grid" x1="'+left+'" x2="'+(width-right)+'" y1="'+y+'" y2="'+y+'"/><text x="'+(left-7)+'" y="'+(y+3)+'" text-anchor="end">'+fmt(maximum*step/3,1)+'</text>';}
  points.forEach(row=>{const x=left+(row.x-first.x)/span*iw,bh=ih*row.count/maximum;body+='<rect class="time-bar" x="'+x+'" y="'+(top+ih-bh)+'" width="'+Math.max(.2,iw/span-.6)+'" height="'+bh+'"><title>'+esc(row.label)+': '+fmt(row.count,0)+' rows</title></rect>';});
  body+='<text x="'+left+'" y="12">ROWS PER '+(monthly?'MONTH':'DAY')+'</text><text x="'+left+'" y="'+(height-14)+'">'+esc(first.label)+'</text><text x="'+(width-right)+'" y="'+(height-14)+'" text-anchor="end">'+esc(last.label)+'</text>';
  return '<article class="panel"><div class="panel-heading"><h3>'+esc(column.name)+'</h3><span class="micro-label">TIME COVERAGE</span></div>'+svg(body,'Row counts by recorded '+(monthly?'month':'day')+' in '+column.name,width,height)+'<p class="caption">Counts describe rows in this source. A gap does not establish that no activity occurred. Date semantics remain those declared by the source.</p></article>';
}

function sourceReferences(refs, context) {
  const entries=list(refs).map(ref=>{
    const table=ref.tableId?context.tables.get(ref.tableId):null,file=ref.fileId?context.files.get(ref.fileId):table?.fileId?context.files.get(table.fileId):null;
    const title=table?.name||file?.path||'Source evidence',anchor=table?context.tableAnchors.get(table.id):file?context.fileAnchors.get(file.id):'archive-atlas';
    return '<a href="#'+anchor+'">'+esc(title)+'</a>'+[ref.column,ref.metric,ref.text].filter(value=>value!==undefined&&value!==null&&value!=='').map(value=>' · '+esc(value)).join('');
  });
  return entries.length?'<p class="archive-evidence">Source: '+entries.join('; ')+'.</p>':'';
}

function renderOverview(report) {
  const coverage=report.coverage||{},complete=report.status==='complete'&&coverage.complete===true,collection=isCollection(report);
  const title=collection?(complete?'The retrieved source collection has been analysed.':'Retrieved source files have been analysed; collection coverage is partial.'):(complete?'The supplied archive has been analysed.':'The archive is available; analysis coverage is partial.');
  const summary=list(report.summary).length?report.summary:['The source tables are profiled at their own grain. The report preserves their structure, documented units and provenance; no source row is automatically assigned to a farmer.'];
  const scope=collection?fmt(coverage.retrievedFileCount,0)+' retrieved files · '+fmt(coverage.retrievedBytes,0)+' original file bytes':fmt(report.archive.bytes,0)+' original bytes';
  const fileKpi=collection?kpi('RETRIEVED SOURCE FILES',fmt(coverage.retrievedFileCount,0),knownCount(coverage.fileCount)?fmt(coverage.fileCount,0)+' files in the established inventory':'Full-release file count not established'):kpi('SOURCE FILES',fmt(coverage.fileCount,0),fmt(coverage.parsedFileCount,0)+' parsed; see inventory and exclusions');
  const tableKpi=collection?kpi('TABLE PROFILES',fmt(coverage.profiledTableCount,0),knownCount(coverage.tableCount)?fmt(coverage.tableCount,0)+' tables in the established inventory':'Full-release table coverage not established'):kpi('SOURCE TABLES',fmt(coverage.tableCount,0),fmt(coverage.profiledTableCount,0)+' table profiles in this analysis');
  return '<div class="evidence-banner archive-evidence-banner'+(complete?'':' is-partial')+'"><div class="status-icon">'+(complete?'✓':'↗')+'</div><div><strong id="availability-title">'+title+'</strong><p id="availability-text">'+esc(report.archive.filename)+' · '+scope+' · '+(complete?'Complete coverage of inventoried sources, with no exclusions.':'Read the coverage and exclusions before using the findings.')+(collection?' Original ZIP bytes and checksum were not obtained.':'')+' The '+(collection?'source':'archive')+' findings remain fixed while you explore another file.</p></div><a href="#archive-evidence" class="text-link">Evidence ↗</a></div>'+
    '<div class="kpi-grid archive-overview-kpis">'+fileKpi+tableKpi+kpi('ROWS PROFILED',fmt(coverage.profiledRows,0),'Across source tables; not distinct farms','scope-kpi')+(collection?kpi('RETRIEVED FILE BYTES',bytes(coverage.retrievedBytes),'Original source files · original ZIP checksum unavailable'):kpi('ORIGINAL ARCHIVE',bytes(report.archive.bytes),'Original ZIP · checksum recorded below'))+'</div>'+
    '<div class="editorial-grid archive-lead"><div><p class="eyebrow">WHAT THE '+(collection?'SOURCE COLLECTION':'ARCHIVE')+' CAN TELL US</p><h2>'+esc(report.title||'Evidence with its context intact.')+'</h2></div><div class="editorial-body">'+paragraphs(summary)+'<a class="text-link" href="#archive-profiles">Read the source profiles ↓</a></div></div>';
}

function renderAtlas(report,context) {
  const coverage=report.coverage||{},complete=report.status==='complete'&&coverage.complete===true,collection=isCollection(report),files=list(report.files),tables=list(report.tables),ranked=tables.filter(t=>knownCount(t.rowCount)).sort((a,b)=>b.rowCount-a.rowCount);
  const fileTable=files.length?'<div class="table-scroll archive-file-table" role="region" aria-label="Source file inventory" tabindex="0"><table><thead><tr><th>Original source</th><th>Format</th><th>Size</th><th>State</th></tr></thead><tbody>'+files.map(file=>'<tr id="'+context.fileAnchors.get(file.id)+'"><td><code>'+esc(file.path||file.id)+'</code>'+noteList(file.notes)+'</td><td>'+esc(file.format||'Not recorded')+'</td><td class="numeric" title="'+fmt(file.bytes,0)+' bytes">'+bytes(file.bytes)+(collection&&file.retrievalStatus==='not-retrieved'?'<small>Listing size only; bytes not retrieved</small>':'')+'</td><td>'+esc(plainStatus(file.status))+(collection&&file.retrievalStatus==='retrieved'?'<small>Original file retrieved and checksummed</small>':'')+'</td></tr>').join('')+'</tbody></table></div>':'<p class="caption">A member-level inventory has not been recorded in this analysis artifact.</p>';
  let html='<section id="archive-atlas" class="report-section section-anchor"><div class="section-heading"><div><p class="eyebrow">02 / SOURCE ATLAS</p><h2>Many tables. Distinct meanings.</h2></div><span class="pill '+(complete?'green':'amber')+'">'+(complete?'Inventoried sources fully covered':'Partial coverage')+'</span></div><p class="section-intro">Each table keeps its original unit of observation. Row totals describe the supplied files; they do not count unique farmers, independent measurements, or a joined agricultural population.</p>'+
    '<div class="chart-grid"><article class="panel"><div class="panel-heading"><h3>Files in the analysis</h3><span class="micro-label">SOURCE INVENTORY</span></div>'+fileTable+'</article><article class="panel"><div class="panel-heading"><h3>Table size at a glance</h3><span class="micro-label">ROWS · LINEAR SCALE</span></div>'+bars(ranked.map(table=>({label:table.name||table.id,count:table.rowCount})),'Source table row counts')+'<p class="caption">'+(ranked.length>12?'The 12 largest tables are shown. ':'')+'All supplied table profiles appear below. These are counts at different grains and should not be summed into a farm count.</p></article></div>'+
    '<div class="archive-coverage"><span class="micro-label">PROFILING COVERAGE</span><p><strong>'+fmt(coverage.profiledRows,0)+'</strong> profiled rows across source tables; <strong>'+fmt(coverage.totalTableRows,0)+'</strong> total table rows recorded in the inventory. Unknown quantities are shown as —.</p>'+(collection?'<p><strong>'+fmt(coverage.retrievedFileCount,0)+'</strong> source files retrieved; <strong>'+fmt(coverage.parsedFileCount,0)+'</strong> parsed; <strong>'+fmt(coverage.unretrievedFileCount,0)+'</strong> expected files not retrieved. '+(report.archive.inventoryComplete?'The expected file inventory is established as complete.':'The expected file inventory is not established as complete; additional files may exist.')+'</p><p>Inventory basis: '+esc(report.archive.inventoryBasis)+'</p>':'')+noteList(coverage.notes)+'</div>';
  if(list(report.exclusions).length)html+='<article class="panel space"><div class="panel-heading"><h3>Exclusions and unresolved inputs</h3><span class="pill amber">Scope matters</span></div><div class="table-scroll"><table><thead><tr><th>Source</th><th>Reason / boundary</th><th>Rows, if known</th></tr></thead><tbody>'+report.exclusions.map(item=>'<tr><td><code>'+esc(item.source)+'</code></td><td>'+esc(item.reason)+'</td><td class="numeric">'+fmt(item.rows,0)+'</td></tr>').join('')+'</tbody></table></div></article>';
  if(list(report.relationships).length)html+='<article class="panel space"><h3>Relationships between tables</h3><p class="caption">A candidate relationship is not a validated join. Match counts apply only to the keys and scope stated here.</p><div class="table-scroll"><table><thead><tr><th>Tables / keys</th><th>Evidence state</th><th>Matched</th><th>Unmatched left / right</th><th>Interpretation</th></tr></thead><tbody>'+report.relationships.map(relation=>'<tr><td><a href="#'+context.tableAnchors.get(relation.leftTableId)+'">'+esc(context.tables.get(relation.leftTableId)?.name||relation.leftTableId)+'</a> → <a href="#'+context.tableAnchors.get(relation.rightTableId)+'">'+esc(context.tables.get(relation.rightTableId)?.name||relation.rightTableId)+'</a><small>'+esc(list(relation.keys).join(' + '))+'</small></td><td>'+esc(plainStatus(relation.status))+'</td><td class="numeric">'+fmt(relation.matchedCount,0)+'</td><td class="numeric">'+fmt(relation.unmatchedLeft,0)+' / '+fmt(relation.unmatchedRight,0)+'</td><td>'+esc(relation.note)+'</td></tr>').join('')+'</tbody></table></div></article>';
  return html+'</section>';
}

function renderFindings(report,context) {
  const findings=list(report.findings);
  return '<section id="archive-findings" class="report-section section-anchor"><div class="section-heading"><div><p class="eyebrow">03 / THE FINDINGS</p><h2>What deserves your attention.</h2></div><span class="pill">'+(isCollection(report)?'Retrieved source collection':'Supplied archive')+'</span></div>'+(findings.length?'<div class="finding-list archive-findings">'+findings.map((finding,index)=>'<article><span>'+String(index+1).padStart(2,'0')+'</span><div><h3>'+esc(finding.title)+'</h3><p>'+esc(finding.body)+'</p>'+(finding.implication?'<p class="finding-implication"><strong>For Terraviva:</strong> '+esc(finding.implication)+'</p>':'')+sourceReferences(finding.evidence,context)+'</div></article>').join('')+'</div>':'<p class="section-intro">No narrative findings were recorded in the analysis artifact. The measured field profiles below remain the source of evidence.</p>')+'</section>';
}

function columnDictionary(table) {
  const columns=list(table.columns);
  if(!columns.length)return '<p class="caption">No column profiles have been supplied for this table.</p>';
  return '<div class="table-scroll archive-column-table"><table><thead><tr><th>Field</th><th>Meaning / unit</th><th>Type</th><th>Present</th><th>Missing</th><th>Distinct</th></tr></thead><tbody>'+columns.map(column=>'<tr><td><code>'+esc(column.name||column.key)+'</code>'+(column.key&&column.key!==column.name?'<small>'+esc(column.key)+'</small>':'')+'</td><td>'+esc(column.description||'No source definition recorded')+(column.unit?'<small>Unit: '+esc(column.unit)+'</small>':'')+'</td><td>'+esc(labels[column.type]||column.type||'Not inferred')+'</td><td class="numeric">'+fmt(column.nonMissingCount,0)+'</td><td class="numeric">'+fmt(column.missingCount,0)+'<small>'+pct(column.missingCount,table.profiledRows)+'</small></td><td class="numeric">'+fmt(column.uniqueCount,0)+'</td></tr>').join('')+'</tbody></table></div>';
}

function numericSummary(table) {
  const columns=list(table.columns).filter(column=>column.numeric);
  if(!columns.length)return '';
  const metrics=[['n','N'],['mean','Mean'],['sampleSd','Sample SD'],['min','Min'],['p25','Q1'],['median','Median'],['p75','Q3'],['max','Max'],['outlierCount','IQR flags']];
  return '<h4 class="archive-subheading">Numeric summaries</h4><p class="caption">Valid values at this table’s grain. Each field retains its own unit. IQR flags identify review candidates; no source rows are removed.</p><div class="table-scroll archive-numeric-table"><table><thead><tr><th>Measure / unit</th>'+metrics.map(([,label])=>'<th>'+label+'</th>').join('')+'</tr></thead><tbody>'+columns.map(column=>'<tr><td><code>'+esc(column.name)+'</code><small>'+esc(column.unit||'Unit not documented')+'</small></td>'+metrics.map(([key])=>'<td class="numeric">'+fmt(column.numeric[key],['n','outlierCount'].includes(key)?0:4)+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';
}

function datesSummary(table) {
  const columns=list(table.columns).filter(column=>column.dates);
  return columns.length?'<h4 class="archive-subheading">Date support</h4><div class="table-scroll"><table><thead><tr><th>Field</th><th>First value</th><th>Last value</th><th>Observed days</th><th>Days without rows</th></tr></thead><tbody>'+columns.map(column=>'<tr><td><code>'+esc(column.name)+'</code></td><td>'+esc(column.dates.min||'Not recorded')+'</td><td>'+esc(column.dates.max||'Not recorded')+'</td><td class="numeric">'+fmt(column.dates.distinctDays,0)+'</td><td class="numeric">'+fmt(column.dates.daysWithoutRecords,0)+'</td></tr>').join('')+'</tbody></table></div>':'';
}

function renderTable(table,index,context) {
  const columns=list(table.columns),allColumnsKnown=knownCount(table.columnCount)&&columns.length===table.columnCount;
  const missing=knownCount(table.missingCellCount)?table.missingCellCount:allColumnsKnown&&columns.every(column=>knownCount(column.missingCount))?columns.reduce((sum,column)=>sum+column.missingCount,0):null;
  const cells=knownCount(table.profiledRows)&&knownCount(table.columnCount)?table.profiledRows*table.columnCount:null;
  const complete=knownCount(table.rowCount)&&knownCount(table.profiledRows)&&table.rowCount===table.profiledRows;
  const file=context.files.get(table.fileId),source=table.sourcePath||file?.path||'Source path not recorded';
  let html='<article class="archive-profile section-anchor" id="'+context.tableAnchors.get(table.id)+'"><header class="archive-profile-header"><div><span class="micro-label">TABLE '+String(index+1).padStart(2,'0')+'</span><h3>'+esc(table.name||table.id)+'</h3><p><code>'+esc(source)+'</code>'+(table.pointer?' · <code>'+esc(table.pointer)+'</code>':'')+'</p></div><span class="pill '+(table.role==='reference'?'amber':'')+'">'+(table.role==='reference'?'Reference · unassigned':'Source table')+'</span></header>'+
    '<p class="archive-grain"><strong>One row represents:</strong> '+esc(table.grain||'The source grain has not yet been established.')+'</p><div class="kpi-grid archive-table-kpis">'+kpi('SOURCE ROWS',fmt(table.rowCount,0),fmt(table.profiledRows,0)+' rows profiled'+(complete?' · all source rows':''))+kpi('FIELDS',fmt(table.columnCount,0),fmt(columns.length,0)+' field profiles supplied')+kpi('MISSING CELLS',fmt(missing,0),pct(missing,cells)+' of cells in the profiled table')+kpi('EXACT REPEATS',fmt(table.duplicateCount,0),'Occurrences beyond the first')+'</div>'+
    (!complete?'<p class="notice warning">The profiled scope is partial or not fully quantified. Read counts and distributions against the stated '+fmt(table.profiledRows,0)+' profiled rows.</p>':'')+
    (knownCount(table.completeRowCount)?'<p class="caption">'+fmt(table.completeRowCount,0)+' rows contain a value in every profiled field. Completeness measures availability, not accuracy.</p>':'')+noteList(table.notes);
  const views=[];
  if(knownCount(table.profiledRows)&&table.profiledRows>0){const fields=columns.filter(column=>knownCount(column.nonMissingCount)&&knownCount(column.missingCount)).sort((a,b)=>b.missingCount-a.missingCount);if(fields.length)views.push('<article class="panel"><div class="panel-heading"><h3>Field completeness</h3><span class="micro-label">PROFILED ROWS</span></div>'+bars(fields.map(column=>({label:column.name,count:column.nonMissingCount,display:pct(column.nonMissingCount,table.profiledRows)})),'Present values by field in '+table.name,{denominator:table.profiledRows,maxRows:15})+'<p class="caption">'+(fields.length>15?'The 15 fields with the most missing values are shown. ':'')+'Every supplied column profile appears below. Literal missing-value codes depend on the stated profiling conventions.</p></article>');}
  const numeric=columns.find(column=>list(column.numeric?.histogram?.bins).length);if(numeric)views.push(histogram(numeric));
  const category=columns.find(column=>!column.numeric&&!column.dates&&column.type!=='identifier'&&list(column.frequencies).length);
  if(category){const top=category.frequencies.slice(0,10).map(row=>({label:row.label,count:row.count})),sum=top.reduce((total,row)=>total+(finite(row.count)?row.count:0),0);if(finite(category.nonMissingCount)&&category.nonMissingCount>sum)top.push({label:'Other values (combined)',count:category.nonMissingCount-sum});views.push('<article class="panel"><div class="panel-heading"><h3>'+esc(category.name)+'</h3><span class="micro-label">CATEGORY COUNTS</span></div>'+bars(top,'Category counts for '+category.name,{denominator:category.nonMissingCount,color:'#a8bc69'})+'<p class="caption">'+fmt(category.nonMissingCount,0)+' present values · '+fmt(category.uniqueCount,0)+' distinct. Up to 10 supplied leading categories and any remaining values are shown.</p></article>');}
  const date=columns.find(column=>list(column.dates?.dayCounts).length||list(column.dates?.monthCounts).length);if(date)views.push(timeChart(date));
  if(views.filter(Boolean).length)html+='<div class="chart-grid archive-profile-charts">'+views.filter(Boolean).join('')+'</div>';
  html+='<h4 class="archive-subheading">Field dictionary and coverage</h4>'+columnDictionary(table)+numericSummary(table)+datesSummary(table);
  if(list(table.keyCandidates).length)html+='<h4 class="archive-subheading">Candidate keys</h4><div class="table-scroll"><table><thead><tr><th>Fields</th><th>Distinct keys</th><th>Missing</th><th>Repeats</th><th>Evidence</th></tr></thead><tbody>'+table.keyCandidates.map(key=>'<tr><td><code>'+esc(list(key.columns).join(' + '))+'</code></td><td class="numeric">'+fmt(key.uniqueCount,0)+'</td><td class="numeric">'+fmt(key.missingCount,0)+'</td><td class="numeric">'+fmt(key.duplicateCount,0)+'</td><td>'+esc(key.note)+'</td></tr>').join('')+'</tbody></table></div>';
  if(list(table.numericPairs).length)html+='<h4 class="archive-subheading">Numeric relationships</h4><p class="caption">Pearson correlation on pairwise complete values; each pair shows its own n. These are descriptive associations at the source table’s grain.</p><div class="table-scroll"><table><thead><tr><th>Measures</th><th>r</th><th>Pairwise n</th><th>Evidence state</th></tr></thead><tbody>'+table.numericPairs.map(pair=>'<tr><td>'+esc(pair.xName)+' × '+esc(pair.yName)+'</td><td class="numeric">'+fmt(pair.r,3)+'</td><td class="numeric">'+fmt(pair.n,0)+'</td><td>'+esc(pair.status||'Not recorded')+'</td></tr>').join('')+'</tbody></table></div>';
  if(list(table.issues).length)html+='<div class="archive-review"><h4>Review signals</h4>'+noteList(table.issues.map(issue=>typeof issue==='string'?issue:issue.message))+'</div>';
  return html+'</article>';
}

function renderProfiles(report,context) {
  const tables=list(report.tables);
  return '<section id="archive-profiles" class="report-section section-anchor"><div class="section-heading"><div><p class="eyebrow">04 / CLASSICAL DATA PROFILES</p><h2>Every source, in its own terms.</h2></div><span class="pill">'+fmt(tables.length,0)+' table profiles</span></div><p class="section-intro">Shape, field coverage, distributions, dates and review signals are calculated within each table’s declared profiling scope. Units and definitions are included only when documented; unknown quantities remain —.</p>'+
    (tables.length?'<div class="archive-table-index">'+tables.map((table,index)=>'<a href="#'+context.tableAnchors.get(table.id)+'"><span>'+String(index+1).padStart(2,'0')+'</span>'+esc(table.name||table.id)+'</a>').join('')+'</div>'+tables.map((table,index)=>renderTable(table,index,context)).join(''):'<p class="caption">No table profiles were supplied. Consult the coverage and exclusions above.</p>')+'</section>';
}

function renderActivation(report) {
  const staging=report.staging||{},collection=isCollection(report);
  return '<section id="import" class="report-section section-anchor"><div class="section-heading"><div><p class="eyebrow">10 / IMPORT &amp; ACTIVATION</p><h2>From source '+(collection?'collection':'archive')+' to useful data.</h2></div><span class="pill" id="archive-status">'+esc(plainStatus(staging.status||'staging status not recorded'))+'</span></div><p class="section-intro">The analysis uses <code>'+esc(report.archive.filename)+'</code>. Source tables retain their provenance and original grain. The '+(collection?'source':'archive')+' profile is separate from the current farmer’s ledger and from any permission to share records.</p>'+
    '<div class="chart-grid"><article class="panel"><span class="micro-label">SOURCE SNAPSHOT</span><h3>A versioned base for analysis.</h3><p>Source-file checksums and table identities tie the statistics to '+(collection?'the retrieved original files. Original ZIP provenance is unavailable.':'a specific archive.')+' The staged SQLite snapshot and source catalog, when available, preserve table boundaries and original parsed values.</p><p>Joining or normalizing tables requires documented keys, units and transformations. A plausible column name alone does not establish a relationship.</p></article><article class="panel"><span class="micro-label">APP CATALOG</span><h3>Explore before assigning.</h3><p><strong>'+fmt(staging.publishedTables,0)+'</strong> published table views; <strong>'+fmt(staging.unpublishedTables,0)+'</strong> views withheld from browser delivery, if recorded by staging.</p><p>Open the <a href="https://terraviva-ruddy.vercel.app/reference-data.html">reference data explorer</a> to browse the complete retrieved tables, filter every source row and inspect all fields in a record. Each source retains its original identity and remains unassigned to a farmer.</p>'+noteList(staging.notes)+'</article></div>'+
    '<div class="callout"><span class="callout-mark">↳</span><div><h3>Reference data is not a farmer declaration.</h3><p>Import a genuine harvest table only after choosing the destination farmer, mapping product, mass, unit, field and event date, and reviewing the validated batch. The app preserves farm boundaries and existing permission settings. Profiling a reference source grants no commercial-use permission.</p></div></div></section>';
}

function renderEvidence(report,context) {
  const collection=isCollection(report),members=retrievedFiles(report).filter(file=>file.sha256);
  const provenance=collection?
    '<div><dt>Source collection</dt><dd><code>'+esc(report.archive.filename)+'</code></dd></div><div><dt>Provenance mode</dt><dd>Original files retrieved separately from an extracted collection.</dd></div><div><dt>Retrieved original file bytes</dt><dd>'+fmt(report.coverage?.retrievedBytes,0)+'</dd></div><div><dt>Original ZIP</dt><dd>'+esc(report.archive.originalArchiveFilename||'Not recorded')+'</dd></div><div><dt>Original ZIP bytes / SHA-256</dt><dd>Not obtained. Original ZIP provenance is not claimed.</dd></div><div><dt>Inventory basis</dt><dd>'+esc(report.archive.inventoryBasis)+'</dd></div><div><dt>Expected file inventory</dt><dd>'+(report.archive.inventoryComplete?'Established as complete.':'Not established as complete; more files may exist.')+'</dd></div>':
    '<div><dt>Original archive</dt><dd><code>'+esc(report.archive.filename)+'</code></dd></div><div><dt>Original bytes</dt><dd>'+fmt(report.archive.bytes,0)+'</dd></div><div><dt>SHA-256</dt><dd><code class="checksum">'+esc(report.archive.sha256)+'</code><small>Hash of original ZIP bytes; not decoded text or generated report JSON.</small></dd></div>';
  return '<article class="panel archive-evidence-ledger section-anchor" id="archive-evidence"><div class="panel-heading"><h3>'+(collection?'Source-collection':'Archive')+' evidence and reproducibility</h3><button class="button secondary compact" id="download-archive-profile" type="button">Download '+(collection?'source':'archive')+' analysis JSON</button></div><dl class="schema-list">'+provenance+'<div><dt>Generated</dt><dd>'+esc(report.generatedAt||'Not recorded')+'</dd></div><div><dt>Analysis version</dt><dd>'+esc(report.methods?.version||'Not recorded')+'</dd></div><div><dt>Scope status</dt><dd>'+esc(plainStatus(report.status))+'</dd></div></dl>'+noteList(report.methods?.notes)+
    (members.length?'<details class="method-details archive-member-hashes"><summary>Original '+(collection?'source-file':'member')+' checksums ('+fmt(members.length,0)+')</summary><div class="details-body"><div class="table-scroll"><table><thead><tr><th>Source '+(collection?'file':'member')+'</th><th>SHA-256 of original '+(collection?'file':'member')+' bytes</th></tr></thead><tbody>'+members.map(file=>'<tr><td><a href="#'+context.fileAnchors.get(file.id)+'">'+esc(file.path||file.id)+'</a></td><td><code class="checksum">'+esc(file.sha256)+'</code></td></tr>').join('')+'</tbody></table></div></div></details>':'')+
    '<p class="caption">The downloadable analysis contains derived statistics, field values such as category labels, and provenance; it contains no raw source rows. Values may still be sensitive. The application audit below describes its explicitly pinned original commit.</p></article>';
}

function replaceBlock(html,name,replacement) {
  const start='<!-- archive:'+name+':start -->',end='<!-- archive:'+name+':end -->';
  const left=html.indexOf(start),right=html.indexOf(end);
  if(left<0||right<left)throw Error('Report template is missing archive block '+name+'.');
  return html.slice(0,left+start.length)+'\n'+replacement+'\n'+html.slice(right);
}

function applyArchive(template,rawReport) {
  if(!rawReport)return {html:template.replace('__ARCHIVE_SECTIONS__','').replace('__ARCHIVE_EVIDENCE__',''),archiveJSON:'null'};
  const report=validateArchive(rawReport),collection=isCollection(report),tables=list(report.tables),files=list(report.files);
  const context={tables:new Map(tables.map(table=>[table.id,table])),files:new Map(files.map(file=>[file.id,file])),tableAnchors:new Map(tables.map((table,index)=>[table.id,'archive-table-'+index])),fileAnchors:new Map(files.map((file,index)=>[file.id,'archive-file-'+index]))};
  let html=replaceBlock(template,'overview',renderOverview(report));
  html=replaceBlock(html,'activation',renderActivation(report));
  const nav=[['overview','Overview'],['archive-atlas','Source atlas'],['archive-findings','The findings'],['archive-profiles','Data profiles'],['analysis','Explore another file'],['anatomy','Original app architecture'],['dictionary','Original SMS dictionary'],['quality','Original parser review'],['permissions','Permission boundaries'],['import','Import & activation'],['methods','Methods & evidence']];
  html=replaceBlock(html,'navigation',nav.map(([id,label],index)=>'<a href="#'+id+'"><span>'+String(index+1).padStart(2,'0')+'</span>'+esc(label)+'</a>').join('\n'));
  html=html.replace('__ARCHIVE_SECTIONS__',()=>renderAtlas(report,context)+renderFindings(report,context)+renderProfiles(report,context)).replace('__ARCHIVE_EVIDENCE__',()=>renderEvidence(report,context));
  html=html.replace('<span class="pill">Source audit + interactive EDA</span>','<span class="pill">'+(collection?'Source collection':'Archive')+' findings + interactive EDA</span>');
  html=html.replace(/<p class="hero-deck">[^]*?<\/p>/,'<p class="hero-deck">Understand the records, their relationships, and the limits of what they can tell us.</p>');
  html=html.replace(/<p class="hero-description">[^]*?<\/p>/,()=>'<p class="hero-description">A documented analysis of '+esc(report.archive.filename)+': its structure, field coverage, distributions and analytical limits. Every finding stays attached to its source table.</p>');
  html=html.replace('href="#analysis">Explore a dataset','href="#archive-findings">Read the findings').replace('href="#dictionary">Read the data dictionary','href="#archive-profiles">Read the source profiles');
  for(const [from,to] of [['02 / CLASSIC EXPLORATORY DATA ANALYSIS','05 / INTERACTIVE EXPLORATION'],['03 / DATA ARCHITECTURE','06 / ORIGINAL APPLICATION ARCHITECTURE'],['04 / FIELD DICTIONARY','07 / ORIGINAL SMS DICTIONARY'],['05 / DATA QUALITY &amp; INTERPRETATION','08 / ORIGINAL PARSER REVIEW'],['06 / PERMISSION BOUNDARIES','09 / PERMISSION BOUNDARIES'],['08 / METHODS &amp; EVIDENCE','11 / METHODS &amp; EVIDENCE']])html=html.replace(from,to);
  html=html.replace('Ready for a source file. No observations loaded.',(collection?'Source':'Archive')+' findings are ready. Choose a file for additional exploration.');
  html=html.replace('<h3>Unmeasured is an honest starting point.</h3><p>Missingness, averages, outliers and correlations are not shown until observations exist. An empty depot is not evidence that every field is complete or that the agricultural population has zero output.</p>','<h3>Take a closer look at a source.</h3><p>The permanent archive profiles appear above. Load a CSV, TSV or JSON file here to explore its fields; this separate analysis does not replace the archive findings or assign rows to a farmer.</p>');
  html=html.replace(/<dd id="evidence-dataset">[\s\S]*?<\/dd>/,()=>'<dd id="evidence-dataset">'+esc(report.archive.filename)+(collection?' · '+fmt(report.coverage.retrievedFileCount,0)+' retrieved original files with per-file SHA-256; original ZIP checksum unavailable.':' · original archive SHA-256 <code class="checksum">'+esc(report.archive.sha256)+'</code>')+'</dd>');
  html=html.replace('Import features are an extension prepared for the requested dataset load.','The source catalog and import workflow are a later extension; their state is reported separately above.');
  return {html,archiveJSON:JSON.stringify(report).replace(/</g,'\\u003c')};
}

module.exports={applyArchive,validateArchive};
