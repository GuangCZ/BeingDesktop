'use strict';
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const APP_ID='town.beings.desktop';
const directory=path.join(os.homedir(),'Library','Application Support','Being Desktop Signing');

function identity() {
  let value,certificate;
  try {
    value=JSON.parse(fs.readFileSync(path.join(directory,'identity.json'),'utf8'));
    certificate=new crypto.X509Certificate(fs.readFileSync(path.join(directory,'certificate.pem')));
  } catch {throw new Error('Stable macOS signing identity is missing. Restore the existing certificate and private key; do not generate a new identity for an update.');}
  const fingerprint=certificate.fingerprint.replaceAll(':','');
  if(!/^[A-F0-9]{40}$/.test(value.sha1) || fingerprint!==value.sha1 || value.kind!=='local-self-signed'
      || !path.isAbsolute(value.keychain) || /[\0\r\n]/.test(value.keychain)
      || Date.parse(certificate.validTo)<=Date.now())throw new Error('Stable macOS signing identity metadata is invalid or expired.');
  return value;
}
function requirement(value) {return `identifier "${APP_ID}" and certificate leaf = H"${value.sha1.toLowerCase()}"`;}
function verify(app) {
  const value=identity();
  execFileSync('/usr/bin/codesign',['--verify','--deep','--strict','-R',`=${requirement(value)}`,app],{stdio:'pipe'});
  const {spawnSync}=require('node:child_process');
  const result=spawnSync('/usr/bin/codesign',['-d','-r-',app],{encoding:'utf8'});
  const requirementText=result.stdout+result.stderr;
  if(result.status!==0 || !requirementText.includes(`designated => ${requirement(value)}`) || requirementText.includes('cdhash ')) {
    throw new Error('The application does not have the pinned, stable designated requirement.');
  }
  return {identity:value.name,certificateSha1:value.sha1,requirement:requirement(value)};
}
async function sign(app) {
  const value=identity();
  const {signAsync}=require('@electron/osx-sign');
  await signAsync({app,platform:'darwin',identity:value.sha1,keychain:value.keychain,
    identityValidation:false,preAutoEntitlements:false,preEmbedProvisioningProfile:false,
    optionsForFile:()=>({hardenedRuntime:false,timestamp:'none'})});
  // Pin the outer application's requirement explicitly. Preserve its signed
  // entitlements and resource layout after osx-sign has signed nested code.
  execFileSync('/usr/bin/codesign',['--force','--sign',value.sha1,'--keychain',value.keychain,'--timestamp=none',
    '--preserve-metadata=entitlements','--identifier',APP_ID,'--requirements',`=designated => ${requirement(value)}`,app],{stdio:'pipe'});
  console.log('Stable macOS signature verified:',JSON.stringify(verify(app)));
}
function developerIdentities(output) {
  return String(output).split('\n').flatMap(line=>{
    const match=/^\s*\d+\)\s+([A-F0-9]{40})\s+"(Developer ID Application: .+ \(([A-Z0-9]{10})\))"\s*$/.exec(line);
    return match?[{sha1:match[1],name:match[2],teamId:match[3]}]:[];
  });
}
function developerIdentity({initialize=false}={}) {
  const values=developerIdentities(execFileSync('/usr/bin/security',['find-identity','-v','-p','codesigning'],{encoding:'utf8'}));
  const profilePath=path.join(directory,'developer-identity.json');
  const profile=fs.existsSync(profilePath)?JSON.parse(fs.readFileSync(profilePath,'utf8')):null;
  if(profile && (!/^[A-Z0-9]{10}$/.test(profile.teamId) || profile.appId!==APP_ID))throw new Error('Invalid pinned Developer ID team or application ID.');
  let candidates=profile?values.filter(item=>item.teamId===profile.teamId):values;
  if(process.env.CSC_NAME)candidates=candidates.filter(item=>item.sha1===process.env.CSC_NAME || item.name.includes(process.env.CSC_NAME));
  if(candidates.length!==1)throw new Error('A unique Developer ID Application identity with its private key is required. Import it into Keychain, then run node scripts/macos-signing.cjs select-developer. Local/ad-hoc signing cannot satisfy the verified cross-build Keychain requirement.');
  const selected=candidates[0];
  if(!profile) {
    if(!initialize)throw new Error('Pin the Developer ID team first: node scripts/macos-signing.cjs select-developer');
    fs.mkdirSync(directory,{recursive:true,mode:0o700});
    fs.writeFileSync(profilePath,JSON.stringify({teamId:selected.teamId,appId:APP_ID},null,2),{mode:0o600,flag:'wx'});
  } else if(profile.appId!==APP_ID)throw new Error('Signing profile application ID mismatch.');
  return selected;
}
function verifyDeveloper(context) {
  const value=developerIdentity();
  const app=path.join(context.appOutDir,`${context.packager.appInfo.productFilename}.app`);
  const dr=`identifier "${APP_ID}" and anchor apple generic and certificate leaf[subject.OU] = "${value.teamId}"`;
  execFileSync('/usr/bin/codesign',['--verify','--deep','--strict','-R',`=${dr}`,app],{stdio:'pipe'});
  const {spawnSync}=require('node:child_process');
  const result=spawnSync('/usr/bin/codesign',['-d','-r-',app],{encoding:'utf8'});
  const text=result.stdout+result.stderr;
  if(result.status!==0 || !text.includes('designated => ') || /\bcdhash\b|certificate leaf = H"/.test(text))throw new Error('Developer ID signature has a build-specific designated requirement.');
}
async function afterPack(context) {
  if(context.electronPlatformName!=='darwin')throw new Error('Local macOS signing only supports Darwin app bundles.');
  await sign(path.join(context.appOutDir,`${context.packager.appInfo.productFilename}.app`));
}
function afterSign(context) {verify(path.join(context.appOutDir,`${context.packager.appInfo.productFilename}.app`));}
module.exports={identity,requirement,verify,sign,afterPack,afterSign,developerIdentities,developerIdentity,verifyDeveloper};
if(require.main===module) {
  const command=process.argv[2],app=process.argv[3];
  if(command==='select-developer')console.log(JSON.stringify(developerIdentity({initialize:true}),null,2));
  else if(command==='verify')console.log(JSON.stringify(verify(path.resolve(app)),null,2));
  else if(command==='sign')sign(path.resolve(app)).catch(error=>{console.error(error.message);process.exitCode=1;});
  else {console.log(JSON.stringify(identity(),null,2));}
}
