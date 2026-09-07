'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const {spawn} = require('node:child_process');
const {getGroveDetail,assessKit} = require('./grove.cjs');

const ORIGIN = 'https://beings.town';
const RECEIPT = '.being-desktop-install.json';
const MAX_JSON = 1024 * 1024;
const MAX_TAR = 2 * 1024 * 1024;
const REVIEWED_RECIPES = Object.freeze({
  OteJGwtOzLqL7jmyZ2PfM:Object.freeze({id:'OteJGwtOzLqL7jmyZ2PfM',name:'codex-async',version:'1.1.2',hash:'b82ec8aa888bfb86108a499e86804ca29ab487171dd07bf4948e452090b94d1d',size:12229,nodeMajor:18,command:['node','server.mjs'],files:['CHANGELOG.md','config.mjs','manifest.json','codex-async.env.example','callback.mjs','README.md','server.mjs','worker.mjs','package.json'],tools:['run','resume','status','list','cancel']}),
  TAYvq0_YCoEKQqV4PjzGp:Object.freeze({id:'TAYvq0_YCoEKQqV4PjzGp',name:'codex-win',version:'1.0.0',recipeVersion:2,hash:'b50d28148605e69e57d86e865132c2d9e5a21a646a097fdc1bb76dbd779d7435',size:803,nodeMajor:16,command:['codex','mcp-server'],files:['manifest.json'],tools:['codex','codex-reply'],exposedTools:['codex','codex_reply']}),
  MMfnXR7ZlRrN5n94vJIFz:Object.freeze({id:'MMfnXR7ZlRrN5n94vJIFz',name:'grove-publish',version:'1.0.1',hash:'c0ca19972f205905d80155ed61fc298fd8b698ba32987dd35e0953a7e803b06f',size:6934,python:true,command:['python3','grove_publish_mcp.py'],files:['manifest.json','grove_publish.py','README.md','grove_publish_mcp.py'],tools:['grove_init','grove_check','grove_publish','grove_verify','grove_doctor']}),
});

function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function record(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function check(label,status,detail) { return {label,status,detail}; }
function reviewedRecipe(detail) {
  const recipe = record(detail) ? REVIEWED_RECIPES[detail.id] : null;
  return recipe && detail.name === recipe.name && detail.version === recipe.version && detail.bundle_hash === recipe.hash && detail.bundle_size === recipe.size ? recipe : null;
}

async function readBounded(response,limit,url) {
  if (!response?.ok || response.redirected || (response.url && response.url !== url)) throw new Error('Grove 返回的地址或响应无效。');
  const declared = response.headers?.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new Error('Grove 返回的文件超过允许大小。');
  if (!response.body?.getReader) throw new Error('Grove 连接不支持有界读取。');
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array) || (size += next.value.length) > limit) throw new Error('Grove 返回的文件超过允许大小。');
      chunks.push(Buffer.from(next.value));
    }
    return Buffer.concat(chunks,size);
  } catch (error) {
    await reader.cancel().catch(()=>{});
    throw error;
  } finally { reader.releaseLock(); }
}

function parseTarArchive(bundle) {
  let tar;
  try { tar = zlib.gunzipSync(bundle,{maxOutputLength:MAX_TAR}); }
  catch { throw new Error('工具包不是受支持的有界 tar.gz 归档。'); }
  if (!tar.length || tar.length % 512) throw new Error('工具包归档长度无效。');
  const entries = new Map();
  const names = new Set();
  let offset = 0,ended = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset,offset + 512);
    if (header.every(byte=>byte === 0)) {
      if (offset + 1024 > tar.length || !tar.subarray(offset).every(byte=>byte === 0)) throw new Error('工具包归档结尾无效。');
      ended = true; break;
    }
    const field = (start,length)=>header.subarray(start,start + length).toString('utf8').split('\0')[0];
    const name = field(0,100);
    if (field(345,155)) throw new Error('工具包使用了未经评估的归档前缀。');
    if (!name || name.length > 200 || name.includes('\\') || name.startsWith('/') || /[\x00-\x1f\x7f:]/.test(name) || name.split('/').some(part=>!part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('工具包包含不安全的归档路径。');
    const key = name.toLowerCase();
    if (names.has(key)) throw new Error('工具包包含重复或大小写冲突的路径。');
    names.add(key);
    if (![0,48].includes(header[156]) || field(157,100)) throw new Error('工具包含链接或未经评估的归档项目。');
    const sizeText = field(124,12).trim();
    const sumText = field(148,8).trim();
    if (!/^[0-7]+$/.test(sizeText) || !/^[0-7]+$/.test(sumText)) throw new Error('工具包归档数字字段无效。');
    const size = parseInt(sizeText,8);
    const checksum = header.reduce((sum,byte,index)=>sum + (index >= 148 && index < 156 ? 32 : byte),0);
    if (checksum !== parseInt(sumText,8) || size > MAX_TAR || offset + 512 + size > tar.length) throw new Error('工具包归档校验失败。');
    if (entries.size >= 100) throw new Error('工具包包含过多文件。');
    entries.set(name,Buffer.from(tar.subarray(offset + 512,offset + 512 + size)));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!ended || !entries.size) throw new Error('工具包归档不完整。');
  return entries;
}

async function existingDirectory(directory) {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const part of path.relative(current,absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current,part);
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('安装目录不能包含链接或非目录项目。');
  }
  return absolute;
}

async function regularFile(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('运行程序必须使用已验证的绝对路径。');
  await existingDirectory(path.dirname(file));
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('运行程序必须是实际文件，不能是链接。');
  return file;
}

function nativeCodexPath(env) {
  if (!env.APPDATA) return '';
  return path.join(env.APPDATA,'npm','node_modules','@openai','codex','node_modules','@openai','codex-win32-x64','vendor','x86_64-pc-windows-msvc','bin','codex.exe');
}

async function findProgram(name,env,platform) {
  const executable = platform === 'win32' ? `${name}.exe` : name;
  const pathValue = Object.entries(env).find(([key])=>key.toUpperCase() === 'PATH')?.[1] || '';
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory,executable);
    try { return await regularFile(candidate); } catch { /* Continue through actual PATH entries. */ }
  }
  throw new Error(`本机缺少可用的 ${name} 运行程序。`);
}

function runCommand(file,args,options = {}) {
  return new Promise((resolve,reject)=>{
    const child = spawn(file,args,{cwd:options.cwd,env:options.env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let stdout = '',stderr = '',settled = false;
    const finish = (error,result)=>{
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) { child.kill(); reject(error); } else resolve(result);
    };
    const timer = setTimeout(()=>finish(new Error('本机程序检查未及时完成。')),15000);
    child.stdout.on('data',chunk=>{stdout += chunk; if (stdout.length > 131072) finish(new Error('本机程序检查输出过大。'));});
    child.stderr.on('data',chunk=>{stderr += chunk; if (stderr.length > 131072) finish(new Error('本机程序检查输出过大。'));});
    child.once('error',()=>finish(new Error('本机程序无法启动。')));
    child.once('close',code=>finish(null,{code,stdout,stderr}));
  });
}

function createCodexMcpShim(command, pathValue) {
  function startShim(upstreamCommand, healthyPath) {
    const {spawn} = require('node:child_process');
    const {createInterface} = require('node:readline');
    const environment = {...process.env};
    if (typeof healthyPath === 'string') {
      for (const key of Object.keys(environment)) if (key.toUpperCase() === 'PATH') delete environment[key];
      environment.PATH = healthyPath;
    }
    const child = spawn(upstreamCommand[0],upstreamCommand.slice(1),{env:environment,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
    const lists = new Set();
    let stopping = false;
    const stop = ()=>{
      if (stopping) return;
      stopping = true;
      child.stdin.end();
      const timer = setTimeout(()=>child.kill(),500);
      timer.unref();
    };
    const fail = ()=>{process.exitCode = 1; stop();};
    child.on('error',fail); child.stdin.on('error',fail);
    child.stderr.pipe(process.stderr);
    const input = createInterface({input:process.stdin});
    const output = createInterface({input:child.stdout});
    input.on('line',line=>{
      if (stopping) return;
      let message;
      try { message = JSON.parse(line); } catch { child.stdin.write(`${line}\n`); return; }
      if (message?.method === 'tools/list' && message.id !== undefined) lists.add(message.id);
      if (message?.method === 'tools/call' && message.params?.name === 'codex_reply') message.params.name = 'codex-reply';
      child.stdin.write(`${JSON.stringify(message)}\n`);
    });
    output.on('line',line=>{
      let message;
      try { message = JSON.parse(line); } catch { process.stdout.write(`${line}\n`); return; }
      if (lists.delete(message?.id) && Array.isArray(message.result?.tools)) {
        message.result.tools = message.result.tools.map(tool=>tool.name === 'codex-reply' ? {...tool,name:'codex_reply'} : tool);
      }
      process.stdout.write(`${JSON.stringify(message)}\n`);
    });
    input.on('close',stop);
    child.on('close',code=>{process.exitCode = code || process.exitCode || 0;input.close();process.stdin.destroy();});
    process.on('SIGTERM',stop); process.on('SIGINT',stop);
    process.on('exit',()=>child.kill());
  }
  return `'use strict';\n(${startShim.toString()})(${JSON.stringify(command)},${JSON.stringify(pathValue)});\n`;
}

function probeMcp(command,{cwd,env,expectedTools}) {
  return new Promise((resolve,reject)=>{
    const child = spawn(command[0],command.slice(1),{cwd,env,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
    let buffer = '',bytes = 0,settled = false,initialized = false;
    const finish = error=>{
      if (settled) return;
      settled = true; clearTimeout(timer);
      const shutdown = setTimeout(()=>child.kill(),1000);
      child.once('close',()=>{clearTimeout(shutdown);if (error) reject(error); else resolve({verified:true,tools:[...expectedTools]});});
      child.stdin.end();
    };
    const timer = setTimeout(()=>finish(new Error('Kit MCP 协议检查未完成。')),15000);
    const send = message=>child.stdin.write(`${JSON.stringify(message)}\n`);
    child.once('error',()=>finish(new Error('Kit MCP 程序无法启动。')));
    child.stdin.on('error',()=>finish(new Error('Kit MCP 输入连接失败。')));
    child.once('exit',()=>{if (!settled) finish(new Error('Kit MCP 程序在检查完成前退出。'));});
    child.stderr.on('data',chunk=>{bytes += chunk.length; if (bytes > MAX_JSON) finish(new Error('Kit MCP 检查输出过大。'));});
    child.stdout.on('data',chunk=>{
      bytes += chunk.length;
      if (bytes > MAX_JSON) { finish(new Error('Kit MCP 检查输出过大。')); return; }
      buffer += chunk.toString('utf8');
      let newline;
      while (!settled && (newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0,newline).trim(); buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { finish(new Error('Kit MCP 返回格式无效。')); return; }
        if (message.id === 1) {
          if (message.error || !record(message.result) || !message.result.protocolVersion || !record(message.result.capabilities?.tools)) { finish(new Error('Kit MCP 初始化失败。')); return; }
          initialized = true;
          send({jsonrpc:'2.0',method:'notifications/initialized'});
          send({jsonrpc:'2.0',id:2,method:'tools/list',params:{}});
        } else if (message.id === 2) {
          const tools = message.result?.tools;
          if (!initialized || message.error || !Array.isArray(tools) || !expectedTools.every(name=>tools.some(tool=>tool.name === name && record(tool.inputSchema)))) { finish(new Error('Kit MCP 工具清单不匹配。')); return; }
          finish();
        }
      }
    });
    send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'being-desktop-install-check',version:'1.0.0'}}});
  });
}

function retainInstalledPath(name,expected,installed) {
  const invalid = ()=>{throw new Error('已安装 Kit 启动适配文件无法验证，未覆盖现有文件。');};
  let retainedPath,rebuilt;
  try {
    if (name === 'desktop-launcher.mjs') {
      const pattern = /^process\.env\.PATH = ("(?:[^"\\]|\\.)*");$/gm;
      const saved = [...installed.matchAll(pattern)],current = [...expected.matchAll(pattern)];
      if (saved.length !== 1 || current.length !== 1) return invalid();
      retainedPath = JSON.parse(saved[0][1]);
      rebuilt = expected.replace(pattern,()=>`process.env.PATH = ${JSON.stringify(retainedPath)};`);
    } else if (name === 'desktop-mcp-shim.cjs') {
      const savedLine = installed.trimEnd().split('\n').at(-1).trim();
      const currentLine = expected.trimEnd().split('\n').at(-1).trim();
      if (!savedLine.startsWith('})(') || !savedLine.endsWith(');') || !currentLine.startsWith('})(') || !currentLine.endsWith(');')) return invalid();
      const saved = JSON.parse(`[${savedLine.slice(3,-2)}]`);
      const current = JSON.parse(`[${currentLine.slice(3,-2)}]`);
      if (saved.length !== 2 || current.length !== 2 || JSON.stringify(saved[0]) !== JSON.stringify(current[0])) return invalid();
      retainedPath = saved[1];
      rebuilt = expected.slice(0,expected.lastIndexOf(currentLine)) + `})(${JSON.stringify(current[0])},${JSON.stringify(retainedPath)});\n`;
    } else return invalid();
  } catch { return invalid(); }
  if (typeof retainedPath !== 'string' || retainedPath.length > 65536 || retainedPath.includes('\0') || rebuilt !== installed) return invalid();
  return Buffer.from(rebuilt);
}

class GroveInstaller {
  constructor({kitsDir,fetchImpl = globalThis.fetch,nodePath,codexPath,workerCodexPath,pythonPath,platform = process.platform,arch = process.arch,env = process.env,runCommand:execute = runCommand,probeMcp:probe = probeMcp} = {}) {
    if (typeof kitsDir !== 'string' || !path.isAbsolute(kitsDir)) throw new Error('请提供 Kit 安装目录的绝对路径。');
    Object.assign(this,{kitsDir:path.resolve(kitsDir),fetchImpl,nodePath,codexPath,workerCodexPath,pythonPath,platform,arch,env:{...env},execute,probe});
    this._tail = Promise.resolve();
  }

  async _fetch(url,limit,json = false) {
    const response = await this.fetchImpl(url,{method:'GET',redirect:'error',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',headers:{Accept:json?'application/json':'application/octet-stream'}});
    if (json && !/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(response.headers?.get('content-type') || '')) throw new Error('Grove 详情格式无效。');
    const bytes = await readBounded(response,limit,url);
    if (!json) return bytes;
    try { return JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Grove 详情无法解析。'); }
  }

  async _inspect(id) {
    const checks = [];
    let kit,base;
    try {
      kit = await getGroveDetail(id,{fetchImpl:this.fetchImpl});
      base = assessKit(kit,{platform:this.platform,arch:this.arch});
      const recipe = REVIEWED_RECIPES[id];
      if (!recipe) {
        const reasons = [...base.reasons];
        if (id === 'jM-oec68MUWwUdF8yLjO8') reasons.unshift('已核对发布包：只有 manifest.json，缺少 server.mjs 和 package.json，请 Being 联系发布者补全。');
        else if (id === 'Bu0EzM-Qs9DxqvL-gzH9S') reasons.unshift('这是浏览器扩展安装工作流，需要 Being 协助加载扩展，不是可启动的 MCP Kit。');
        else reasons.unshift('此版本尚未形成可执行的一键安装方案，需要 Being 核对平台、依赖及配置。');
        return {result:{status:'needs_being',detail:'需要 Being 协助处理安装条件。',kit,loaded:false,assessment:{...base,installable:false,blocked:true,mode:'being',checks,reasons}}};
      }
      if (this.platform !== 'win32' || this.arch !== 'x64') throw new Error('当前一键安装方案仅验证了 Windows x64，请 Being 核对目标平台。');
      const raw = await this._fetch(`${ORIGIN}/api/grove/${id}`,MAX_JSON,true);
      if (!record(raw) || raw.id !== id || raw.name !== recipe.name || raw.version !== recipe.version || raw.bundle_hash !== recipe.hash || raw.bundle_size !== recipe.size || raw.has_bundle !== true || raw.download_url !== `${ORIGIN}/api/grove/${id}/download`) throw new Error('Grove 版本、下载地址或摘要已变更，需要 Being 重新评估后安装。');
      const archive = await this._fetch(`${ORIGIN}/api/grove/${id}/download`,recipe.size);
      if (archive.length !== recipe.size || digest(archive) !== recipe.hash) throw new Error('Grove 工具包大小或 SHA-256 校验失败。');
      const files = parseTarArchive(archive);
      if (files.size !== recipe.files.length || !recipe.files.every(name=>files.has(name))) throw new Error('工具包文件清单与已评估版本不一致。');
      let manifest;
      try { manifest = JSON.parse(files.get('manifest.json').toString('utf8')); } catch { throw new Error('归档 manifest 无法解析。'); }
      if (manifest.name !== recipe.name || manifest.version !== recipe.version || JSON.stringify(manifest.command) !== JSON.stringify(recipe.command) || !Array.isArray(manifest.tools) || !recipe.tools.every(name=>manifest.tools.some(tool=>tool.name === name && record(recipe.python ? tool.inputSchema : tool.params)))) throw new Error('归档 manifest 与已评估安装方案不一致。');
      if (raw.manifest?.name !== manifest.name || raw.manifest?.version !== manifest.version || JSON.stringify(raw.manifest?.command) !== JSON.stringify(manifest.command)) throw new Error('Grove 详情与归档 manifest 不一致。');
      checks.push(check('发布包','passed','版本、SHA-256、归档路径与启动文件已核对。'));
      await existingDirectory(this.kitsDir);
      await fs.access(this.kitsDir,require('node:fs').constants.W_OK);
      checks.push(check('安装目录','passed','独立 Kit 目录存在且可写。'));
      const target = path.join(this.kitsDir,recipe.name);
      if (recipe.python) {
        const python = await regularFile(this.pythonPath || await findProgram('python',this.env,this.platform));
        const version = await this.execute(python,['--version'],{env:this.env});
        const match = `${version.stdout}\n${version.stderr}`.trim().match(/^Python (\d+)\.(\d+)\.\d+/);
        if (version.code !== 0 || !match || Number(match[1]) !== 3 || Number(match[2]) < 10) throw new Error('需要 Python 3.10 或更高的 Python 3 版本。');
        checks.push(check('Python','passed',`Python ${match[1]}.${match[2]}，标准库运行，无需安装依赖。`));
        const adapted = {...manifest,command:[python,'-B',path.join(target,'grove_publish_mcp.py')],platform:['windows'],tools:manifest.tools.map(tool=>({...tool,params:tool.inputSchema}))};
        const environment = {...this.env,PYTHONDONTWRITEBYTECODE:'1'};
        delete environment.GROVE_BEARER;
        const result = {status:'ready',detail:'本机 Python 与发布包检查通过，可以一键安装。',kit,loaded:false,installPath:target,assessment:{...base,manifestCompatible:true,installable:true,blocked:false,mode:'one_click',localInstalled:false,localMcpRegistered:false,reasons:[],checks,runtime:{name:'python',version:`${match[1]}.${match[2]}`,verified:true}}};
        return {result,recipe,files,manifest:adapted,environment,target};
      }
      const node = await regularFile(this.nodePath || await findProgram('node',this.env,this.platform));
      const codex = await regularFile(this.codexPath || nativeCodexPath(this.env));
      const worker = recipe.name === 'codex-async' ? await regularFile(this.workerCodexPath || nativeCodexPath(this.env)) : codex;
      if (recipe.name === 'codex-async' && path.resolve(worker) !== path.resolve(nativeCodexPath(this.env))) throw new Error('Codex Async 需要验证 APPDATA 下实际使用的原生 Codex 程序。');
      const nodeVersion = await this.execute(node,['--version'],{env:this.env});
      const nodeMatch = String(nodeVersion.stdout).trim().match(/^v(\d+)\.\d+\.\d+/);
      if (nodeVersion.code !== 0 || !nodeMatch || Number(nodeMatch[1]) < recipe.nodeMajor) throw new Error(`需要 Node.js ${recipe.nodeMajor} 或更高版本。`);
      const codexVersion = await this.execute(codex,['--version'],{env:this.env});
      if (codexVersion.code !== 0 || !/codex(?:-cli)?\s+\d+\.\d+/i.test(String(codexVersion.stdout))) throw new Error('本机 Codex CLI 版本检查失败。');
      if (worker !== codex) {
        const version = await this.execute(worker,['--version'],{env:this.env});
        if (version.code !== 0 || !/codex(?:-cli)?\s+\d+\.\d+/i.test(String(version.stdout))) throw new Error('Codex Async 工作进程所用 CLI 不可用。');
      }
      const login = await this.execute(codex,['login','status'],{env:this.env});
      if (login.code !== 0 || !/logged in/i.test(`${login.stdout}\n${login.stderr}`)) throw new Error('Codex CLI 尚未登录，需要先完成登录。');
      checks.push(check('Node.js','passed',String(nodeVersion.stdout).trim().slice(0,60)),check('Codex CLI','passed','原生程序与登录状态已验证。'));
      const environment = {...this.env};
      for (const key of Object.keys(environment)) if (key.toUpperCase() === 'PATH') delete environment[key];
      const originalPath = Object.entries(this.env).find(([key])=>key.toUpperCase() === 'PATH')?.[1] || '';
      environment.PATH = [path.dirname(node),path.dirname(codex),originalPath].filter(Boolean).join(path.delimiter);
      const adapted = {...manifest,command:recipe.name === 'codex-win' ? [codex,'mcp-server'] : [node,path.join(target,'server.mjs')]};
      if (recipe.name === 'codex-win') {
        // Portal 0.8 normalizes request hyphens, so expose an underscore and translate at stdio.
        files.set('desktop-mcp-shim.cjs',Buffer.from(createCodexMcpShim([codex,'mcp-server'],environment.PATH)));
        adapted.command = [node,path.join(target,'desktop-mcp-shim.cjs')];
        adapted.tools = manifest.tools.map(tool=>tool.name === 'codex-reply' ? {...tool,name:'codex_reply'} : tool);
      }
      if (recipe.name === 'codex-async') {
        environment.CODEX_ASYNC_KIT_HOME = target;
        // Portal 0.8 ignores manifest.env and builds an invalid Windows PATH.
        // The reviewed adapter sets process state before importing the Kit.
        const optionalEnvironment = ['GROVE_TOKEN','BEINGS_TOWN_GROVE_TOKEN','GROVE_KIT_ID','GROVE_API_BASE','CODEX_ASYNC_LOOM_URL'];
        for (const key of optionalEnvironment) delete environment[key];
        const launcher = [
          "import {dirname} from 'node:path';",
          "import {fileURLToPath} from 'node:url';",
          'process.env.CODEX_ASYNC_KIT_HOME = dirname(fileURLToPath(import.meta.url));',
          `for (const key of ${JSON.stringify(optionalEnvironment)}) delete process.env[key];`,
          "for (const key of Object.keys(process.env)) if (key.toUpperCase() === 'PATH') delete process.env[key];",
          `process.env.PATH = ${JSON.stringify(environment.PATH)};`,
          "const {startServer} = await import('./server.mjs');",
          'startServer();','',
        ].join('\n');
        files.set('desktop-launcher.mjs',Buffer.from(launcher));
        adapted.command = [node,path.join(target,'desktop-launcher.mjs')];
      }
      const result = {status:'ready',detail:'本机环境与发布包检查通过，可以一键安装。',kit,loaded:false,installPath:target,assessment:{...base,installable:true,blocked:false,mode:'one_click',localInstalled:false,localMcpRegistered:false,reasons:[],checks,runtime:{...base.runtime,verified:true}}};
      return {result,recipe,files,manifest:adapted,environment,target};
    } catch (error) {
      const detail = error?.message && /^[\u4e00-\u9fff]/.test(error.message) ? error.message : '安装环境或 Grove 发布包无法验证，请 Being 协助检查。';
      checks.push(check('安装检查','failed',detail));
      return {result:{status:'needs_being',detail,kit,loaded:false,assessment:{...(base || {}),installable:false,blocked:true,mode:'being',reasons:[detail],checks}}};
    }
  }

  _payload(inspected) {
    const files = new Map(inspected.files);
    files.set('manifest.grove-original.json',Buffer.from(files.get('manifest.json')));
    files.set('manifest.json',Buffer.from(`${JSON.stringify(inspected.manifest,null,2)}\n`));
    return {files,hashes:Object.fromEntries([...files].map(([name,bytes])=>[name,digest(bytes)]))};
  }

  async _existing(inspected,hashes) {
    const {target,recipe} = inspected;
    let stat;
    try { stat = await fs.lstat(target); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('同名 Kit 路径不是实际目录，未覆盖。');
    let receipt;
    try {
      const file = await regularFile(path.join(target,RECEIPT));
      if ((await fs.stat(file)).size > 65536) throw new Error('Invalid receipt');
      receipt = JSON.parse(await fs.readFile(file,'utf8'));
    } catch { throw new Error('同名 Kit 目录不是已验证的桌面安装，未覆盖现有文件。'); }
    if (receipt.id !== recipe.id || receipt.recipeVersion !== (recipe.recipeVersion || 1) || receipt.mcpVerified !== true || receipt.bundleHash !== recipe.hash || receipt.version !== recipe.version || !record(receipt.files)) throw new Error('同名 Kit 安装记录与当前方案不同，未覆盖现有文件。');
    const installedHashes = {...hashes};
    // A desktop launch may inherit a different PATH from the installation shell.
    // Retain that one JSON string while verifying every other byte against the reviewed template.
    for (const name of ['desktop-launcher.mjs','desktop-mcp-shim.cjs']) {
      if (!Object.hasOwn(hashes,name) || receipt.files[name] === hashes[name]) continue;
      const file = await regularFile(path.join(target,name));
      if ((await fs.stat(file)).size > MAX_TAR) throw new Error('已安装 Kit 启动适配文件过大，未覆盖。');
      const retained = retainInstalledPath(name,inspected.files.get(name).toString('utf8'),await fs.readFile(file,'utf8'));
      installedHashes[name] = digest(retained);
    }
    if (JSON.stringify(receipt.files) !== JSON.stringify(installedHashes)) throw new Error('同名 Kit 安装记录与当前方案不同，未覆盖现有文件。');
    for (const [name,hash] of Object.entries(installedHashes)) {
      const file = await regularFile(path.join(target,name));
      if ((await fs.stat(file)).size > MAX_TAR || digest(await fs.readFile(file)) !== hash) throw new Error('已安装 Kit 文件被修改，未覆盖现有文件。');
    }
    return true;
  }

  async prepare(id) {
    const inspected = await this._inspect(id);
    if (inspected.result.status !== 'ready') return inspected.result;
    try {
      if (!await this._existing(inspected,this._payload(inspected).hashes)) return inspected.result;
      return {...inspected.result,status:'installed',alreadyInstalled:true,detail:'已安装文件与安装记录校验通过，之前的 MCP 协议检查已通过。',assessment:{...inspected.result.assessment,localInstalled:true,localMcpRegistered:true}};
    } catch (error) {
      const detail = error.message.startsWith('同名') || error.message.startsWith('已安装') ? error.message : '现有 Kit 安装无法验证，未覆盖。';
      return {...inspected.result,status:'needs_being',detail,assessment:{...inspected.result.assessment,installable:false,blocked:true,mode:'being',reasons:[detail]}};
    }
  }

  install(id) {
    const operation = this._tail.then(()=>this._install(id));
    this._tail = operation.catch(()=>{});
    return operation;
  }

  async verifyInstalledRoot() {
    const installed = [];
    try {
      await existingDirectory(this.kitsDir);
      for (const entry of await fs.readdir(this.kitsDir,{withFileTypes:true})) {
        if (entry.isSymbolicLink()) throw new Error('Kit 目录中存在链接，不能启用整个目录。');
        if (!entry.isDirectory()) continue;
        const recipe = Object.values(REVIEWED_RECIPES).find(item=>item.name === entry.name);
        if (!recipe) throw new Error('Kit 目录中有未评估的工具包，不能启用整个目录。');
        const inspected = await this._inspect(recipe.id);
        if (inspected.result.status !== 'ready' || !await this._existing(inspected,this._payload(inspected).hashes)) throw new Error('Kit 目录中的安装文件或收据未通过校验。');
        installed.push({id:recipe.id,name:recipe.name,version:recipe.version});
      }
      if (!installed.length) throw new Error('Kit 目录中还没有已验证的安装。');
      return {verified:true,detail:'目录内所有 Kit 均为已验证的桌面安装。',installed};
    } catch (error) {
      return {verified:false,detail:/^Kit/.test(error.message) ? error.message : 'Kit 安装目录无法验证。',installed:[]};
    }
  }

  async _install(id) {
    const inspected = await this._inspect(id);
    if (inspected.result.status !== 'ready') return inspected.result;
    const {result,recipe,manifest,environment,target} = inspected;
    const {files,hashes:expectedHashes} = this._payload(inspected);
    let staging = '',created = false;
    try {
      await existingDirectory(this.kitsDir);
      const existing = await this._existing(inspected,expectedHashes);
      if (!existing) {
        // Portal scans every subdirectory, including hidden names. Stage outside its kits root.
        staging = await fs.mkdtemp(path.join(path.dirname(this.kitsDir),'.being-kit-install-'));
        for (const [name,bytes] of files) await fs.writeFile(path.join(staging,name),bytes,{flag:'wx',mode:0o600});
        const probeCommand = manifest.command.map((argument,index)=>index > 0 && argument.startsWith(`${target}${path.sep}`) ? path.join(staging,path.relative(target,argument)) : argument);
        const protocol = await this.probe(probeCommand,{cwd:staging,env:{...environment,...(recipe.name === 'codex-async' ? {CODEX_ASYNC_KIT_HOME:staging} : {})},expectedTools:recipe.exposedTools || recipe.tools});
        if (protocol?.verified !== true) throw new Error('Kit MCP 协议检查未通过。');
        await fs.writeFile(path.join(staging,RECEIPT),`${JSON.stringify({recipeVersion:recipe.recipeVersion || 1,mcpVerified:true,version:recipe.version,id,name:recipe.name,bundleHash:recipe.hash,files:expectedHashes,installedAt:new Date().toISOString()},null,2)}\n`,{flag:'wx',mode:0o600});
        await existingDirectory(this.kitsDir);
        try { await fs.lstat(target); throw new Error('安装期间出现同名 Kit 目录，未覆盖。'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await fs.rename(staging,target); staging = ''; created = true;
      } else {
        const protocol = await this.probe(manifest.command,{cwd:target,env:environment,expectedTools:recipe.exposedTools || recipe.tools});
        if (protocol?.verified !== true) throw new Error('Kit MCP 协议检查未通过。');
      }
      return {...result,status:'installed',detail:'Kit 文件已安装，MCP 初始化与工具清单检查通过；尚未加载到 Portal。',loaded:false,alreadyInstalled:!created,receiptPath:path.join(target,RECEIPT),assessment:{...result.assessment,localInstalled:true,localMcpRegistered:true,checks:[...result.assessment.checks,check('MCP 协议','passed','initialize 与 tools/list 已通过，未执行模型任务。')]}};
    } catch (error) {
      const detail = error?.message && /^[\u4e00-\u9fff]/.test(error.message) ? error.message : 'Kit 安装未完成，请 Being 协助检查。';
      return {...result,status:'failed',detail,loaded:false,filesInstalled:created,assessment:{...result.assessment,installable:false,blocked:true,localInstalled:created,localMcpRegistered:false,reasons:[detail],checks:[...result.assessment.checks,check('安装','failed',detail)]}};
    } finally {
      if (staging && path.dirname(staging) === path.dirname(this.kitsDir) && path.basename(staging).startsWith('.being-kit-install-')) await fs.rm(staging,{recursive:true,force:true}).catch(()=>{});
    }
  }
}

module.exports = {GroveInstaller,REVIEWED_RECIPES,reviewedRecipe,parseTarArchive,probeMcp,createCodexMcpShim};
