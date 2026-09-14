'use strict';
const {spawn} = require('node:child_process');
const path = require('node:path');
const {consoleEnvironment, WINDOWS_RUNNER} = require('./desktop-console.cjs');

// Only CLI configuration is inherited; Desktop/Loom tokens and runtime code
// injection variables stay excluded. Never persist or put these values in prompts.
const CLI_ENVIRONMENT_KEYS = new Set([
  'http_proxy','https_proxy','all_proxy','no_proxy','codex_home',
  'xdg_config_home','xdg_data_home','xdg_cache_home',
  'openai_api_key','openai_base_url','openai_org_id','openai_organization','openai_project_id',
  'cursor_api_key','xai_api_key','grok_api_key',
  'anthropic_api_key','anthropic_auth_token','anthropic_base_url','claude_config_dir',
  'node_extra_ca_certs','ssl_cert_file','ssl_cert_dir','requests_ca_bundle',
]);

// Encode values as data, including prompts; never interpolate user text as shell code.
const psValue = value => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value).toString('base64')}'))`;
function agentEnvironment(source = process.env) {
  const env = consoleEnvironment(source);
  for (const [key,value] of Object.entries(source)) {
    if (CLI_ENVIRONMENT_KEYS.has(key.toLowerCase()) && typeof value === 'string' && !value.includes('\0')) env[key] = value;
  }
  return env;
}
function launchAgent({file, args = [], input = '', cwd, onData = () => {}, platform = process.platform, spawnImpl = spawn, environment = process.env}) {
  const env = agentEnvironment(environment);
  let child;
  if (platform === 'win32') {
    const command = `$agentExecutable = ${psValue(file)}\n$agentArguments = @(${args.map(psValue).join(',')})\n`
      + (input ? `${psValue(input)} | & $agentExecutable @agentArguments` : '& $agentExecutable @agentArguments');
    const shell = path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    child = spawnImpl(shell, ['-NoLogo','-NoProfile','-NonInteractive','-OutputFormat','Text','-EncodedCommand',Buffer.from(WINDOWS_RUNNER,'utf16le').toString('base64')],
      {cwd,env,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
    child.stdin.on('error',()=>{});
    child.stdin.end(command);
  } else {
    child = spawnImpl(file,args,{cwd,env,detached:true,shell:false,stdio:['pipe','pipe','pipe']});
    child.stdin.on('error',()=>{});
    child.stdin.end(input);
  }
  for (const stream of ['stdout','stderr']) {
    child[stream].setEncoding('utf8');
    child[stream].on('data',text=>onData(stream,text));
  }
  let failed = null, stopping = false;
  child.on('error',error=>{failed=error;});
  const done = new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal,error:failed,stopped:stopping})));
  return {done, async stop() {
    if (child.exitCode !== null || child.signalCode !== null) return done;
    stopping = true;
    if (platform === 'win32') {
      if (!child.kill()) throw new Error('无法停止 worker，请重试。');
    } else {
      try { process.kill(-child.pid,'SIGKILL'); } catch (error) { if(error.code!=='ESRCH')throw error; }
    }
    return done;
  }};
}
module.exports = {launchAgent, psValue, agentEnvironment};
