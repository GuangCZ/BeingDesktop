'use strict';

const GROVE_ORIGIN = 'https://beings.town';
const GROVE_PATH = '/api/grove';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_BUNDLE_BYTES = 100 * 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const RESERVED_IDS = new Set(['help','token','my','publish','publish-manifest','download','install']);
const PLATFORM_NAMES = new Map([['windows','win32'],['win32','win32'],['linux','linux'],['darwin','darwin'],['macos','darwin'],['osx','darwin']]);
const RUNTIME_NAMES = new Set(['node','python','deno','bun','bash']);

function record(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function publicText(value, limit = 2000) {
  if (typeof value !== 'string') return '';
  // These are plain text DTOs. Renderers must use textContent, never innerHTML.
  return value.slice(0, limit * 2)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\b(?:https?|wss?):\/\/[^\s<>"']+/gi, match => {
      try {
        const url = new URL(match);
        url.username = ''; url.password = ''; url.search = ''; url.hash = '';
        return url.toString();
      } catch { return '[无效链接]'; }
    })
    .replace(/\b(?:Authorization|Proxy-Authorization|Cookie|Set-Cookie)\s*:[^\r\n]*/gi, '[已隐藏凭证]')
    .replace(/\bBearer\s+[^\s,"']+/gi, 'Bearer [已隐藏]')
    .replace(/(--(?:api[-_]?key|token|secret|password|authorization)\s+)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi, '$1[已隐藏]')
    .replace(/(\b["']?(?:[\w-]{0,100}(?:token|secret|password|credential)[\w-]{0,100}|api[_-]?key|authorization)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi, '$1[已隐藏]')
    .replace(/\bsk-[a-z0-9_-]{8,}\b/gi, '[已隐藏凭证]')
    .replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)?\b/g, '[已隐藏凭证]')
    .replace(/\b[a-f0-9]{32,}\b/gi, '[已隐藏凭证]')
    .slice(0, limit);
}

function validId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value) && !RESERVED_IDS.has(value.toLowerCase());
}

function integer(value, max = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, max) : 0;
}

function publicUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !url.hostname.includes('.')) return '';
    // Public links are display metadata, never a destination for an authenticated fetch.
    url.search = ''; url.hash = '';
    return url.href;
  } catch { return ''; }
}

function downloadUrl(value) {
  const normalized = publicUrl(value);
  if (!normalized) return '';
  const url = new URL(normalized);
  if (url.origin !== GROVE_ORIGIN) return '';
  const match = url.pathname.match(/^\/api\/grove\/([A-Za-z0-9._-]+)\/download$/);
  return match && validId(match[1]) ? normalized : '';
}

function publicSchema(value, depth = 0, budget = {remaining:2000}) {
  if (depth > 8 || --budget.remaining < 0 || !record(value)) return null;
  const result = {};
  for (const key of ['type','title','description','format','pattern']) {
    if (typeof value[key] === 'string') result[key] = publicText(value[key], key === 'description' ? 2000 : 300);
  }
  if (Array.isArray(value.type)) result.type = value.type.filter(item=>typeof item === 'string').slice(0,8).map(item=>publicText(item,30));
  if (Array.isArray(value.required)) result.required = value.required.filter(item=>typeof item === 'string').slice(0,100).map(item=>publicText(item,120));
  if (Array.isArray(value.enum)) result.enum = value.enum.slice(0,100).filter(item=>['string','number','boolean'].includes(typeof item) || item === null).map(item=>typeof item === 'string' ? publicText(item,300) : item);
  for (const key of ['minimum','maximum','minLength','maxLength','minItems','maxItems']) {
    if (typeof value[key] === 'number' && Number.isFinite(value[key])) result[key] = value[key];
  }
  if (typeof value.additionalProperties === 'boolean') result.additionalProperties = value.additionalProperties;
  if (typeof value.nullable === 'boolean') result.nullable = value.nullable;
  if (record(value.properties)) {
    result.properties = {};
    for (const [key, schema] of Object.entries(value.properties).slice(0,100)) {
      if (key.length > 120 || ['__proto__','prototype','constructor'].includes(key)) continue;
      const safe = publicSchema(schema, depth + 1, budget);
      if (safe) Object.defineProperty(result.properties, publicText(key,120), {value:safe,enumerable:true,writable:true,configurable:true});
    }
  }
  if (record(value.items)) result.items = publicSchema(value.items,depth + 1,budget);
  for (const key of ['anyOf','oneOf','allOf']) {
    if (Array.isArray(value[key])) result[key] = value[key].slice(0,12).map(item=>publicSchema(item,depth + 1,budget)).filter(Boolean);
  }
  return result;
}

function textList(value, limit = 100, textLimit = 300) {
  return Array.isArray(value) ? value.filter(item=>typeof item === 'string').slice(0,limit).map(item=>publicText(item,textLimit)) : [];
}

function toolsDto(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0,100).filter(record).map(tool=>{
    const safe = {name:publicText(tool.name,120)};
    if (typeof tool.description === 'string') safe.description = publicText(tool.description,2000);
    if (record(tool.params)) safe.params = publicSchema(tool.params);
    if (record(tool.inputSchema)) safe.inputSchema = publicSchema(tool.inputSchema);
    return safe;
  });
}

function depsDto(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0,40).filter(record).map(dep=>({
    name:publicText(dep.name,160),type:publicText(dep.type,40),description:publicText(dep.description,1000),
    install_hint:publicText(dep.install_hint,2000),required:dep.required !== false
  }));
}

function platformsDto(value) {
  if (Array.isArray(value)) return textList(value,32,80);
  if (!record(value)) return null;
  const result = {};
  if (Array.isArray(value.supported)) result.supported = textList(value.supported,32,80);
  if (Array.isArray(value.architectures)) result.architectures = textList(value.architectures,16,80);
  if (record(value.backend_matrix)) {
    result.backend_matrix = {};
    for (const [key, platforms] of Object.entries(value.backend_matrix).slice(0,20)) {
      if (/^[a-zA-Z0-9_-]{1,40}$/.test(key) && !['__proto__','constructor','prototype'].includes(key)) result.backend_matrix[key] = textList(platforms,16,80);
    }
  }
  return result;
}

function manifestDto(value) {
  if (!record(value)) return null;
  const result = {name:publicText(value.name,120),version:publicText(value.version,80),description:publicText(value.description,4000),tools:toolsDto(value.tools)};
  if (typeof value.command === 'string') result.command = publicText(value.command,4000);
  else if (Array.isArray(value.command)) result.command = value.command.slice(0,64).map(item=>typeof item === 'string' ? publicText(item,4000) : null);
  if (typeof value.transport === 'string') result.transport = publicText(value.transport,40);
  if (value.platform !== undefined) result.platform = Array.isArray(value.platform) ? textList(value.platform,32,80) : null;
  if (value.platforms !== undefined) result.platforms = platformsDto(value.platforms);
  if (Array.isArray(value.architectures)) result.architectures = textList(value.architectures,16,80);
  if (record(value.provision)) {
    const provision = value.provision;
    result.provision = {deps:depsDto(provision.deps)};
    if (record(provision.runtime)) result.provision.runtime = {name:publicText(provision.runtime.name,80),version:publicText(provision.runtime.version,120)};
    if (provision.platforms !== undefined) result.provision.platforms = platformsDto(provision.platforms);
    for (const key of ['install','post_install']) {
      if (typeof provision[key] === 'string') result.provision[key] = publicText(provision[key],4000);
      else if (Array.isArray(provision[key])) result.provision[key] = textList(provision[key],30,2000);
    }
    if (Array.isArray(provision.env)) result.provision.env = provision.env.slice(0,50).filter(record).map(item=>({name:publicText(item.name,120),description:publicText(item.description,1000),required:item.required !== false}));
    if (record(provision.config_files)) result.provision.config_files = Object.fromEntries(Object.entries(provision.config_files).filter(([key])=>!['__proto__','prototype','constructor'].includes(key)).slice(0,30).map(([key,value])=>[publicText(key,80),publicText(value,1000)]));
  }
  if (record(value.env)) result.env = Object.fromEntries(Object.keys(value.env).filter(key=>/^[A-Za-z_][A-Za-z0-9_]{0,119}$/.test(key) && !['__proto__','prototype','constructor'].includes(key)).slice(0,50).map(key=>[key,'[需配置]']));
  if (record(value.source)) result.source = {github:publicText(value.source.github,200),ref:publicText(value.source.ref,120)};
  // Lifecycle commands are review requirements; do not return arbitrary executable definitions.
  if (record(value.lifecycle) && Object.keys(value.lifecycle).length) result.requires_lifecycle_review = true;
  result.review_issues = [];
  if (Array.isArray(value.command) && (value.command.length > 64 || value.command.some(item=>typeof item === 'string' && item.length > 4000))) result.review_issues.push('启动命令超过可审阅范围，请发布者提供精简且完整的 manifest。');
  if (Array.isArray(value.tools) && value.tools.length > 100) result.review_issues.push('工具定义超过可审阅范围，需要分批核对完整 manifest。');
  return result;
}

function kitDto(value) {
  if (!record(value) || !validId(value.id) || typeof value.name !== 'string') return null;
  return {
    id:value.id,name:publicText(value.name,120),version:publicText(value.version,80),
    description:publicText(value.description,4000),being_id:publicText(value.being_id,120),display_name:publicText(value.display_name,160),
    status:['grown','sprouting'].includes(value.status) ? value.status : 'unknown',
    has_bundle:value.has_bundle === true,schema_complete:value.schema_complete === true,
    install_count:integer(value.install_count),self_calls:integer(value.self_calls),total_calls:integer(value.total_calls),
    created_at:publicText(value.created_at,80),updated_at:publicText(value.updated_at,80),last_used_at:publicText(value.last_used_at,80),
    forked_from:validId(value.forked_from) ? value.forked_from : null
  };
}

async function readPublicJson(url, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url,{method:'GET',redirect:'error',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',headers:{Accept:'application/json'}});
  } catch { throw new Error('无法连接 Grove，请检查网络后重试。'); }
  if (!response || !response.ok || response.redirected || (response.url && response.url !== url)) {
    if (response?.body?.cancel) await response.body.cancel().catch(()=>{});
    throw new Error(response?.status === 404 ? '没有找到这个 Grove 工具包。' : 'Grove 暂时无法返回数据，请稍后重试。');
  }
  const length = response.headers?.get('content-length');
  const contentType = response.headers?.get('content-type') || '';
  if ((length && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) || !/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(contentType)) {
    if (response.body?.cancel) await response.body.cancel().catch(()=>{});
    throw new Error('Grove 返回的数据格式或大小不受支持。');
  }
  if (!response.body?.getReader) throw new Error('Grove 连接不支持有界数据读取。');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array) || (bytes += chunk.value.byteLength) > MAX_RESPONSE_BYTES) throw new Error('limit');
      chunks.push(Buffer.from(chunk.value));
    }
    return JSON.parse(Buffer.concat(chunks,bytes).toString('utf8'));
  } catch {
    await reader.cancel().catch(()=>{});
    throw new Error('Grove 返回的数据无法读取或超过大小限制。');
  } finally { reader.releaseLock(); }
}

async function getGroveCatalog(input = {}, dependencies = {}) {
  if (!record(input) || !record(dependencies)) throw new Error('Grove 列表参数无效。');
  const {limit = 30,offset = 0} = input;
  const {fetchImpl = globalThis.fetch} = dependencies;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 100000 || typeof fetchImpl !== 'function') throw new Error('Grove 列表参数无效。');
  const url = `${GROVE_ORIGIN}${GROVE_PATH}?limit=${limit}&offset=${offset}`;
  const response = await readPublicJson(url,fetchImpl);
  if (!record(response) || !Array.isArray(response.kits)) throw new Error('Grove 目录格式无效。');
  const kits = response.kits.slice(0,limit).map(kitDto).filter(Boolean);
  return {kits,count:Math.max(kits.length,integer(response.count)),returned:kits.length};
}

async function getGroveDetail(id, dependencies = {}) {
  if (!record(dependencies)) throw new Error('Grove 工具包参数无效。');
  const {fetchImpl = globalThis.fetch} = dependencies;
  if (!validId(id) || typeof fetchImpl !== 'function') throw new Error('Grove 工具包标识无效。');
  const response = await readPublicJson(`${GROVE_ORIGIN}${GROVE_PATH}/${encodeURIComponent(id)}`,fetchImpl);
  const kit = kitDto(response);
  if (!kit || (kit.id !== id && kit.name !== id)) throw new Error('Grove 工具包详情与请求不匹配。');
  const guide = record(response.setup_guide) ? response.setup_guide : {};
  return {...kit,
    manifest:manifestDto(response.manifest),source_url:publicUrl(response.source_url),download_url:downloadUrl(response.download_url),
    bundle_hash:typeof response.bundle_hash === 'string' && /^[a-f0-9]{64}$/i.test(response.bundle_hash) ? response.bundle_hash.toLowerCase() : '',
    bundle_size:integer(response.bundle_size),
    setup_guide:{has_bundle:guide.has_bundle === true,steps:textList(guide.steps,40,4000),deps:depsDto(guide.deps),
      env_template:record(guide.env_template) ? Object.fromEntries(Object.keys(guide.env_template).filter(key=>/^[A-Za-z_][A-Za-z0-9_]{0,119}$/.test(key) && !['__proto__','prototype','constructor'].includes(key)).slice(0,50).map(key=>[key,'[需配置]'])) : {}}
  };
}

function platformDeclaration(value) {
  const list = Array.isArray(value) ? value : record(value) && Array.isArray(value.supported) ? value.supported : null;
  return list ? [...new Set(list.filter(item=>typeof item === 'string').map(item=>PLATFORM_NAMES.get(item.toLowerCase()) || item.toLowerCase()))] : null;
}

function assessKit(detail, options = {}) {
  if (!record(options)) throw new Error('工具包兼容性检查参数无效。');
  const {platform = 'win32',arch = 'x64'} = options;
  if (!record(detail) || !['win32','darwin','linux'].includes(platform) || !['x64','arm64','ia32','arm'].includes(arch)) throw new Error('工具包兼容性检查参数无效。');
  const manifest = record(detail.manifest) ? detail.manifest : {};
  const provision = record(manifest.provision) ? manifest.provision : {};
  const reasons = [];
  let manifestCompatible = true;
  const blockManifest = reason=>{manifestCompatible = false;reasons.push(reason);};
  if (Array.isArray(manifest.review_issues)) for (const issue of manifest.review_issues.slice(0,10)) if (typeof issue === 'string') blockManifest(publicText(issue,500));
  if (!manifest.name || !manifest.version || !manifest.description) blockManifest('Manifest 缺少名称、版本或描述，请发布者补全。');
  if (typeof manifest.command === 'string') blockManifest('Grove 的 command 是字符串；Portal 0.8 需要参数数组，请发布者提供兼容 manifest。');
  else if (!Array.isArray(manifest.command) || !manifest.command.length || manifest.command.length > 64 || manifest.command.some(item=>typeof item !== 'string' || !item.trim() || item.length > 4000 || item.includes('\0'))) blockManifest('Manifest 缺少有效的 command 参数数组。');
  const tools = toolsDto(manifest.tools);
  if (!Array.isArray(manifest.tools) || !manifest.tools.length || manifest.tools.length > 100 || manifest.tools.some(tool=>!record(tool) || !tool.name || typeof tool.description !== 'string' || !record(tool.params))) blockManifest('Portal 0.8 的每个工具需要 name、description 和 params；请发布者补全工具定义。');
  if (manifest.transport && manifest.transport !== 'stdio') blockManifest('此工具包使用非 stdio 传输，需要单独配置连接方式。');
  if (Object.hasOwn(manifest,'platform') && !Array.isArray(manifest.platform)) blockManifest('Portal 0.8 的 platform 字段需要操作系统名称数组。');
  const declarations = [platformDeclaration(manifest.platform),platformDeclaration(manifest.platforms),platformDeclaration(provision.platforms)].filter(item=>item !== null);
  const platforms = declarations.length ? declarations.reduce((common,list)=>common.filter(item=>list.includes(item))) : [];
  if (!declarations.length) reasons.push('工具包未声明支持的操作系统，请先向发布者确认本机兼容性。');
  else if (!platforms.includes(platform)) reasons.push(`工具包声明的平台不包含 ${platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : 'Linux'}；单个后端支持不能代表整包兼容。`);
  const architectures = Array.isArray(manifest.architectures) ? manifest.architectures : record(manifest.platforms) && Array.isArray(manifest.platforms.architectures) ? manifest.platforms.architectures : null;
  if (architectures && !architectures.some(item=>item === arch || item === (arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : arch))) reasons.push(`工具包声明的处理器架构不包含 ${arch}。`);
  const executable = Array.isArray(manifest.command) && typeof manifest.command[0] === 'string' ? manifest.command[0].replace(/\\/g,'/').split('/').pop().toLowerCase().replace(/\.exe$/,'') : '';
  const inferred = executable.startsWith('python') ? 'python' : RUNTIME_NAMES.has(executable) ? executable : '';
  const declared = record(provision.runtime) && typeof provision.runtime.name === 'string' ? provision.runtime.name : '';
  const runtime = {name:publicText(declared || inferred,80),version:record(provision.runtime) ? publicText(provision.runtime.version,120) : '',declared:Boolean(declared),verified:false};
  if (!runtime.name) reasons.push('工具包未声明可识别的运行时，需要确认启动程序及其依赖。');
  else if (platform === 'win32' && runtime.name === 'bash') reasons.push('启动脚本需要 Bash；尚未确认它在 Windows 的本地运行方式。');
  else reasons.push(`需要检查本机 ${runtime.name}${runtime.version ? ` ${runtime.version}` : ''} 及启动文件是否可用。`);
  if (manifest.command && JSON.stringify(manifest.command).match(/\{\{(?:KIT_HOME|YOUR_[^}]+)\}\}|(?:\/Users\/|\/home\/|[A-Za-z]:\\)|\[已隐藏/)) reasons.push('启动命令仍含发布者路径、待填凭证或已隐藏字段，需要先完成本机配置。');
  if (Array.isArray(provision.deps) && provision.deps.some(item=>record(item) && item.required !== false)) reasons.push('有必需依赖尚未安装验证，请先查看安装说明。');
  if (provision.install || provision.post_install || manifest.requires_lifecycle_review || manifest.lifecycle) reasons.push('工具包包含安装步骤或生命周期脚本，需先检查具体操作。');
  if ((Array.isArray(provision.env) && provision.env.some(item=>item.required !== false)) || (record(manifest.env) && Object.keys(manifest.env).length) || (record(provision.config_files) && Object.keys(provision.config_files).length)) reasons.push('工具包需要环境变量或本机配置文件，尚未完成配置检查。');
  const archiveReady = detail.has_bundle === true && typeof detail.bundle_hash === 'string' && /^[a-f0-9]{64}$/i.test(detail.bundle_hash) && Number.isSafeInteger(detail.bundle_size) && detail.bundle_size > 0 && detail.bundle_size <= MAX_BUNDLE_BYTES && Boolean(downloadUrl(detail.download_url));
  if (archiveReady) reasons.push('已提供包摘要；仍需下载后校验摘要、检查归档路径与 manifest，才能安装到本机。');
  else if (detail.source_url) reasons.push('外部来源尚未验证包摘要与归档格式，请先核对发布版本。');
  else reasons.push('尚无可验证的完整工具包：需要下载地址、SHA-256 摘要及有效包大小。');
  // Catalog metadata cannot prove an archive or a local runtime is ready to execute.
  return {installable:false,blocked:true,reasons:[...new Set(reasons)],runtime,tools,platforms,manifestCompatible,archiveReady};
}

module.exports = {getGroveCatalog,getGroveDetail,assessKit};
