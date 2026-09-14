'use strict';
const {DEFAULT_PERMISSIONS,normalizePortalPermissions}=require('./portal-config.cjs');
const KEYS=Object.keys(DEFAULT_PERMISSIONS);
// Upstream ToolsConfig defaults every omitted switch to true. These are not
// Desktop's conservative defaults for a newly generated configuration.
const UPSTREAM_DEFAULTS=Object.freeze(Object.fromEntries(KEYS.map(key=>[key,true])));
const invalid=()=>new Error('Portal 权限配置格式无法安全识别，请检查 [tools] 中的布尔开关。');
function keyParts(value) {
  const parts=[];let rest=value.trim();
  while(rest) {
    const match=/^(?:([A-Za-z0-9_-]+)|"([^"\\]*)"|'([^']*)')/.exec(rest);
    if(!match)throw invalid();
    parts.push(match[1]??match[2]??match[3]);rest=rest.slice(match[0].length).trim();
    if(!rest)break;
    if(rest[0]!=='.')throw invalid();rest=rest.slice(1).trim();if(!rest)throw invalid();
  }
  if(!parts.length)throw invalid();return parts;
}
function parseToolPermissions(text) {
  const fields={},permissions={...UPSTREAM_DEFAULTS};
  let offset=0,quote='',triple=false,depth=0,table=[],toolsStart=null,toolsEnd=text.length;
  for(const line of text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)||[]) {
    if(!line)continue;
    const body=line.replace(/[\r\n]+$/,''),content=offset===0?body.replace(/^\uFEFF/,''):body,bom=body.length-content.length;
    if(!quote&&depth===0) {
      if(/^\s*\[/.test(content)) {
        const header=/^\s*(?:\[\[(.*?)\]\]|\[(.*?)\])[ \t]*(?:#.*)?$/.exec(content);
        if(!header)throw invalid();
        if(table.length===1&&table[0]==='tools')toolsEnd=offset;
        table=keyParts(header[1]??header[2]);
        if(table[0]==='tools'&&(header[1]!==undefined||KEYS.includes(table[1])))throw invalid();
        if(table.length===1&&table[0]==='tools') {
          if(toolsStart!==null)throw invalid();toolsStart=offset+line.length;
        }
        offset+=line.length;continue;
      }
      // The assignment prefix accepts quoted keys but never mistakes '=' or '#'
      // inside a key for syntax. Escaped keys are deliberately refused.
      const assignment=/^[ \t]*((?:(?:[A-Za-z0-9_-]+|"[^"\\]*"|'[^']*')[ \t]*\.[ \t]*)*(?:[A-Za-z0-9_-]+|"[^"\\]*"|'[^']*'))[ \t]*=[ \t]*/.exec(content);
      if(!assignment&&!/^[ \t]*(?:#.*)?$/.test(content))throw invalid();
      if(assignment) {
        const keys=keyParts(assignment[1]);
        if(!table.length&&keys[0]==='tools')throw invalid(); // Inline/dotted root tools need a different editor.
        if(table.length===1&&table[0]==='tools'&&KEYS.includes(keys[0])) {
          if(keys.length!==1||Object.hasOwn(fields,keys[0]))throw invalid();
          const value=/^(true|false)[ \t]*(?:#.*)?$/.exec(content.slice(assignment[0].length));
          if(!value)throw invalid();
          fields[keys[0]]={start:offset+bom+assignment[0].length,length:value[1].length};permissions[keys[0]]=value[1]==='true';
        }
      }
    }
    // Table-looking content in strings, arrays and inline objects is data.
    for(let i=0;i<content.length;i++) {
      const char=content[i];
      if(quote) {
        if(quote==='"'&&char==='\\'){i++;continue;}
        if(char===quote) {
          if(triple&&content.slice(i,i+3)===quote.repeat(3)) {
            let count=3;while(count<5&&content[i+count]===quote)count++;i+=count-1;quote='';triple=false;
          }else if(!triple)quote='';
        }
      }else if(char==='#')break;
      else if(char==='"'||char==="'"){quote=char;triple=content.slice(i,i+3)===char.repeat(3);if(triple)i+=2;}
      else if(char==='['||char==='{')depth++;
      else if(char===']'||char==='}')depth--;
    }
    if((quote&&!triple)||depth<0)throw invalid();offset+=line.length;
  }
  if(quote||depth!==0)throw invalid();
  return {fields,permissions,toolsStart,toolsEnd};
}
function editToolPermissions(text,permissions) {
  const flags=normalizePortalPermissions(permissions),parsed=parseToolPermissions(text),changes=[],additions=[];
  for(const key of KEYS) {
    if(flags[key]===parsed.permissions[key])continue;
    const field=parsed.fields[key];
    if(field)changes.push({...field,value:String(flags[key])});else additions.push(`${key} = ${flags[key]}`);
  }
  if(additions.length) {
    const newline=text.includes('\r\n')?'\r\n':'\n',position=parsed.toolsStart===null?text.length:parsed.toolsEnd;
    const prefix=position>0&&!/[\r\n]/.test(text[position-1])?newline:'';
    changes.push({start:position,length:0,value:prefix+(parsed.toolsStart===null?`[tools]${newline}`:'')+additions.join(newline)+newline});
  }
  let updated=text;
  for(const change of changes.sort((a,b)=>b.start-a.start))updated=updated.slice(0,change.start)+change.value+updated.slice(change.start+change.length);
  return updated;
}
module.exports={parseToolPermissions,editToolPermissions,UPSTREAM_DEFAULTS};
