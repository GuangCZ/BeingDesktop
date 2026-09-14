'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {parseToolPermissions,editToolPermissions,UPSTREAM_DEFAULTS}=require('../src/portal-tools-config.cjs');
test('existing switches are read while value-only edits preserve comments, credentials, unknown fields and CRLF',()=>{
  const source='\uFEFFname = "fixture"\r\nconnect_link = "private-fixture"\r\n[ "tools" ] # flags\r\n  "exec"  = true # retain this\r\nfile = false\r\nunknown = "leave alone"\r\n[security]\r\nexec_allowlist = ["safe"]\r\n';
  const parsed=parseToolPermissions(source);assert.equal(parsed.permissions.exec,true);assert.equal(parsed.permissions.file,false);assert.equal(parsed.permissions.screenshot,true);
  const flags={...parsed.permissions,exec:false};assert.equal(editToolPermissions(source,flags),source.replace('= true # retain','= false # retain'));
});
test('fake tables and flags inside multiline strings and arrays are never edited',()=>{
  const source='note = """\n[tools]\nexec = false\n"""\nitems = [\n "[tools]",\n "exec = false"\n]\n[tools]\nexec = true\n';
  assert.equal(parseToolPermissions(source).permissions.exec,true);
  assert.equal(editToolPermissions(source,{...UPSTREAM_DEFAULTS,exec:false}),source.replace('[tools]\nexec = true','[tools]\nexec = false'));
});
test('omitted upstream flags remain true and a no-op save preserves every byte',()=>{
  const source='name = "fixture"\n[tools]\nexec = false\n[security]\nmax_file_size = 1000';
  const parsed=parseToolPermissions(source);assert.equal(parsed.permissions.custom_tools_enabled,true);
  assert.equal(editToolPermissions(source,parsed.permissions),source);
  assert.equal(editToolPermissions(source,{...parsed.permissions,search:false}),source.replace('[security]','search = false\n[security]'));
  const missing='name = "fixture"';assert.equal(editToolPermissions(missing,UPSTREAM_DEFAULTS),missing);
  assert.equal(editToolPermissions(missing,{...UPSTREAM_DEFAULTS,file:false}),missing+'\n[tools]\nfile = false\n');
});
test('ambiguous, duplicate, non-boolean and unsupported tools representations fail closed',()=>{
  for(const source of ['[tools]\nexec = false\nexec = true','[tools]\nexec = "true"','[tools]\nexec = 1','[tools]\n[tools]','tools.exec = true','tools = { exec = true }','["to\\u006fls"]\nexec = true','[[tools]]\nexec = true','[tools.exec]\nvalue = true','[tools]\nexec.extra = true','note = """unterminated'])assert.throws(()=>parseToolPermissions(source),/无法安全识别/,source);
});
