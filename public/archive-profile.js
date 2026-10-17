/* Terraviva archive profile adapter.
 * Converts an in-memory EDA result to the strict report's derived-only schema.
 * No source rows, ownership assignment, networking, storage or unit inference.
 */
(function(root,factory){
  'use strict';
  var api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.TerravivaArchiveProfile=api;
})(typeof window!=='undefined'?window:(typeof globalThis!=='undefined'?globalThis:this),function(){
  'use strict';
  var VERSION='1.0.0';
  var numericKeys=['n','mean','median','p25','p75','sampleSd','min','max','outlierCount'];
  var numericCounts={n:true,outlierCount:true};
  var limitKeys=['maxFileBytes','maxRows','maxColumns','maxCells','maxTables','maxFlattenDepth','maxJSONDepth','maxJSONNodes','maxNumericPairColumns','maxDisplayedFrequencies','previewRows'];
  var methodKeys=['missingRule','quantiles','standardDeviation','correlations'];

  function fail(message){var error=new Error(message);error.name='TerravivaArchiveProfileError';throw error;}
  function object(value,label){if(!value||typeof value!=='object'||Array.isArray(value))fail(label+' must be an object.');return value;}
  function count(value,label){if(!Number.isSafeInteger(value)||value<0)fail(label+' must be a non-negative safe integer.');return value;}
  function text(value,label,nonempty){if(typeof value!=='string'||nonempty&&!value.trim())fail(label+' must be '+(nonempty?'non-empty ':'')+'text.');return value;}
  function array(value,label){if(!Array.isArray(value))fail(label+' must be an array.');return value;}
  function optionalArray(value,label){return value===undefined||value===null?[]:array(value,label);}
  function notes(value,label){return optionalArray(value,label).map(function(value){return text(value,label+' entry');});}
  function distinct(items){return Array.from(new Set(items));}
  function numberOrNull(value,label){if(value===null)return null;if(typeof value!=='number'||!Number.isFinite(value))fail(label+' must be finite or null.');return value;}
  function within(value,total,label){if(value>total)fail(label+' exceeds its profiled population.');return value;}
  function pointer(path){return path.length?'/'+path.map(function(part){return String(part).replace(/~/g,'~0').replace(/\//g,'~1');}).join('/'):'';}

  function issue(value,label){
    object(value,label);
    var message=text(value.message,label+'.message',true),severity=value.severity===undefined?'warning':text(value.severity,label+'.severity');
    return {severity:severity,message:message};
  }
  function issues(values,label){
    var seen=new Set();
    return optionalArray(values,label).map(function(value){return issue(value,label+' entry');}).filter(function(value){var key=value.severity+'\u0000'+value.message;if(seen.has(key))return false;seen.add(key);return true;});
  }
  function exclusionNotes(values,label){
    return optionalArray(values,label).map(function(value){
      object(value,label+' entry');
      var source=text(value.source,label+'.source',true),reason=text(value.reason,label+'.reason',true);
      var rows=value.rows===undefined||value.rows===null?'':'; '+count(value.rows,label+'.rows')+' rows';
      return 'Profiler exclusion: '+source+' — '+reason+rows+'.';
    });
  }
  function methodNotes(profile){
    var result=['EDA engine version: '+text(profile.version,'profile.version',true)+'.','All parsed source rows were profiled; no file-level sampling was performed.'];
    var method=object(profile.method,'profile.method');
    methodKeys.forEach(function(key){if(method[key]!==undefined&&method[key]!==null)result.push('Profiling method — '+key+': '+text(method[key],'profile.method.'+key)+'.');});
    if(profile.limits!==undefined&&profile.limits!==null){
      var limits=object(profile.limits,'profile.limits'),parts=[];
      limitKeys.forEach(function(key){if(limits[key]!==undefined&&limits[key]!==null)parts.push(key+'='+count(limits[key],'profile.limits.'+key));});
      if(parts.length)result.push('Engine limits: '+parts.join('; ')+'.');
    }
    result.push('The supplied member byte count and SHA-256 describe original file bytes. The adapter does not recompute or verify that hash.');
    result.push('SourceData, raw records, flattened rows, previews, raw category values and outlier row values are omitted from this derived export. Profiler notes referring to retained records describe the original in-memory analysis only.');
    return result;
  }

  function normalizeNumeric(value,columnLabel,present){
    if(value===undefined||value===null)return undefined;
    object(value,columnLabel+'.numeric');
    var result={};
    numericKeys.forEach(function(key){
      if(value[key]===undefined)return;
      result[key]=numericCounts[key]?(value[key]===null?null:count(value[key],columnLabel+'.numeric.'+key)):numberOrNull(value[key],columnLabel+'.numeric.'+key);
    });
    count(result.n,columnLabel+'.numeric.n');within(result.n,present,columnLabel+'.numeric.n');
    if(result.outlierCount!==undefined&&result.outlierCount!==null)within(result.outlierCount,result.n,columnLabel+'.numeric.outlierCount');
    if(result.sampleSd!==undefined&&result.sampleSd!==null&&result.sampleSd<0)fail(columnLabel+' has a negative sample standard deviation.');
    if(value.histogram!==undefined&&value.histogram!==null){
      object(value.histogram,columnLabel+'.histogram');
      var total=0,bins=array(value.histogram.bins,columnLabel+'.histogram.bins').map(function(bin){
        object(bin,columnLabel+' histogram bin');
        var low=numberOrNull(bin.low,columnLabel+' bin.low'),high=numberOrNull(bin.high,columnLabel+' bin.high'),n=count(bin.count,columnLabel+' bin.count');
        if(low===null||high===null||high<low)fail(columnLabel+' histogram bounds must be finite and ordered.');
        total+=n;within(total,result.n,columnLabel+' histogram counts');
        return {low:low,high:high,count:n};
      });
      result.histogram={bins:bins};
      if(value.histogram.method!==undefined&&value.histogram.method!==null)result.histogram.method=text(value.histogram.method,columnLabel+'.histogram.method');
    }
    return result;
  }

  function normalizeDates(value,columnLabel,present){
    if(value===undefined||value===null)return undefined;
    object(value,columnLabel+'.dates');
    var result={};
    ['min','max'].forEach(function(key){if(value[key]!==undefined&&value[key]!==null)result[key]=text(value[key],columnLabel+'.dates.'+key);});
    ['distinctDays','calendarDays','daysWithoutRecords'].forEach(function(key){if(value[key]!==undefined&&value[key]!==null)result[key]=count(value[key],columnLabel+'.dates.'+key);});
    [['dayCounts','date'],['monthCounts','month']].forEach(function(entry){
      var key=entry[0],labelKey=entry[1];
      if(value[key]===undefined||value[key]===null)return;
      var total=0,seen=new Set();
      result[key]=array(value[key],columnLabel+'.dates.'+key).map(function(bucket){
        object(bucket,columnLabel+' date bucket');
        var label=text(bucket[labelKey],columnLabel+' date bucket label'),valid;
        if(labelKey==='month')valid=/^\d{4}-(0[1-9]|1[0-2])$/.test(label);
        else valid=/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(label)&&Number.isFinite(Date.parse(label+'T00:00:00Z'))&&new Date(label+'T00:00:00Z').toISOString().slice(0,10)===label;
        if(!valid||seen.has(label))fail(columnLabel+' date buckets must be unique real calendar dates/months.');
        seen.add(label);
        var n=count(bucket.count,columnLabel+' date bucket count');total+=n;within(total,present,columnLabel+' date counts');
        var row={count:n};row[labelKey]=label;return row;
      });
    });
    return result;
  }

  function normalizeColumn(column,index,rowCount,tableNotes){
    object(column,'column '+index);
    var name=text(column.name,'column.name',true),key=text(column.key,'column.key',true),type=text(column.type,'column.type',true);
    var present=count(column.nonMissingCount,name+'.nonMissingCount'),missing=count(column.missingCount,name+'.missingCount');
    if(present+missing!==rowCount)fail(name+' present and missing counts do not reconcile with the table.');
    var result={key:key,name:name,type:type,nonMissingCount:present,missingCount:missing,uniqueCount:within(count(column.uniqueCount,name+'.uniqueCount'),present,name+'.uniqueCount')};
    if(typeof column.inference==='string')result.description='Inferred type only: '+column.inference+' Source definition and unit are not established by the profiler.';
    var numeric=normalizeNumeric(column.numeric,name,present),dates=normalizeDates(column.dates,name,present);
    if(numeric)result.numeric=numeric;
    if(dates)result.dates=dates;
    var omittedStructured=0,total=0;
    var frequencies=optionalArray(column.frequencies,name+'.frequencies').filter(function(item){
      object(item,name+' frequency');
      // Never serialize an array/object cell through its human-readable label.
      if(type==='structured'||item.value!==null&&typeof item.value==='object'){omittedStructured++;return false;}
      return true;
    }).map(function(item){
      var n=count(item.count,name+' frequency count');total+=n;within(total,present,name+' frequency counts');
      return {label:text(item.label,name+' frequency label'),count:n};
    });
    if(frequencies.length)result.frequencies=frequencies;
    if(omittedStructured)tableNotes.push('Structured category labels for '+name+' were omitted from the derived export; missingness and distinct-value counts still use all profiled rows.');
    return result;
  }

  function normalizeProfile(profile,source){
    object(profile,'profile');object(source,'source');
    var fileId=text(source.fileId,'source.fileId',true),path=text(source.path,'source.path',true),hash=text(source.sha256,'source.sha256',true),bytes=count(source.bytes,'source.bytes');
    if(!/^[a-fA-F0-9]{64}$/.test(hash))fail('source.sha256 must be a SHA-256 hexadecimal string for original member bytes.');
    var metadata=object(profile.source,'profile.source'),method=object(profile.method,'profile.method');
    if(metadata.sampled!==false||method.allRowsProfiled!==true)fail('Only unsampled profiles of every parsed source row can be normalized.');
    var inputTables=array(profile.tables,'profile.tables');
    if(count(metadata.tableCount,'profile.source.tableCount')!==inputTables.length)fail('Source table count does not match the supplied profiles.');
    if(metadata.sizeBytes!==undefined&&metadata.sizeBytes!==null)within(count(metadata.sizeBytes,'profile.source.sizeBytes'),bytes,'Decoded text byte count');
    var globalIssues=issues(profile.issues,'profile.issues'),excluded=exclusionNotes(profile.exclusions,'profile.exclusions');
    var fileNotes=methodNotes(profile).concat(notes(profile.notes,'profile.notes').map(function(note){return 'Profiler note: '+note;}));
    fileNotes=fileNotes.concat(excluded,globalIssues.map(function(value){return 'Profiler '+value.severity+': '+value.message;}));
    if(metadata.sizeBytes!==undefined&&metadata.sizeBytes!==null)fileNotes.push('Decoded text size used by the profiler: '+metadata.sizeBytes+' bytes; supplied original member size: '+bytes+' bytes.');
    var totalRows=0;
    var tables=inputTables.map(function(table,index){
      object(table,'table '+index);
      if(table.allRowsProfiled!==true||table.sampled!==false)fail('Table '+index+' must represent an unsampled complete parse.');
      var rows=count(table.rowCount,'table.rowCount'),columnCount=count(table.columnCount,'table.columnCount');
      totalRows+=rows;count(totalRows,'combined profiled rows');
      var inputColumns=array(table.columns,'table.columns');
      if(inputColumns.length!==columnCount)fail('Table column count does not match the supplied field profiles.');
      var tableNotes=notes(table.notes,'table.notes'),tableExclusions=exclusionNotes(table.exclusions,'table.exclusions');
      var tableIssues=issues(optionalArray(table.issues,'table.issues').concat(globalIssues),'table.issues');
      excluded.concat(tableExclusions).forEach(function(note){tableIssues.push({severity:'error',message:note});});
      tableNotes=tableNotes.concat(tableExclusions);
      var result={id:fileId+'::table:'+index,name:text(table.name,'table.name',true),fileId:fileId,sourcePath:path,grain:'One source row; the real-world entity or event grain is not established.',role:'unknown',rowCount:rows,profiledRows:rows,columnCount:columnCount,columns:[],notes:tableNotes,issues:tableIssues};
      if(metadata.format==='json')result.pointer=pointer(optionalArray(table.path,'table.path').map(function(part){return text(part,'table.path component');}));
      result.columns=inputColumns.map(function(column,columnIndex){return normalizeColumn(column,columnIndex,rows,tableNotes);});
      result.duplicateCount=within(count(table.duplicateCount,'table.duplicateCount'),Math.max(0,rows-1),'table.duplicateCount');
      result.missingCellCount=count(table.missingCells,'table.missingCells');
      if(result.missingCellCount!==result.columns.reduce(function(sum,column){return sum+column.missingCount;},0))fail('Table missing-cell counts do not reconcile.');
      result.completeRowCount=within(count(table.completeRowCount,'table.completeRowCount'),rows,'table.completeRowCount');
      result.numericPairs=optionalArray(table.numericPairs,'table.numericPairs').map(function(pair){
        object(pair,'numeric pair');
        var n=within(count(pair.n,'numeric pair n'),rows,'numeric pair n'),r=numberOrNull(pair.r,'numeric pair r');
        if(r!==null&&(r<-1||r>1))fail('Pearson r must lie within [-1, 1].');
        return {xName:text(pair.xName,'numeric pair xName',true),yName:text(pair.yName,'numeric pair yName',true),n:n,r:r,status:text(pair.status,'numeric pair status')};
      });
      if(table.delimiter!==undefined&&table.delimiter!==null)tableNotes.push('CSV delimiter used by the profiler: '+(table.delimiter==='\t'?'tab':text(table.delimiter,'table.delimiter'))+'.');
      var rowErrors=optionalArray(table.rowErrors,'table.rowErrors').length;
      if(rowErrors){
        var message=rowErrors+' parser/row-width issue(s) remain in this diagnostic source profile. Original error payloads are omitted; review the source before import.';
        tableIssues.push({severity:'error',message:message});fileNotes.push('Table '+result.name+': '+message);
      }
      result.notes=distinct(tableNotes);result.issues=issues(tableIssues,'normalized table issues');
      return result;
    });
    if(totalRows!==count(metadata.rowCount,'profile.source.rowCount'))fail('Source row count does not match its table profiles.');
    var file={id:fileId,path:path,format:text(metadata.format,'profile.source.format',true),bytes:bytes,sha256:hash.toLowerCase(),status:'profiled',notes:distinct(fileNotes)};
    return {file:file,tables:tables};
  }

  return Object.freeze({version:VERSION,normalizeProfile:normalizeProfile});
});
