'use strict';

const {app, net} = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {PortalInstaller, PORTAL_RELEASE} = require('../src/portal-installer.cjs');
const {portalRequestAdapter} = require('../src/desktop-network.cjs');

const directory = path.resolve(process.argv[2]);
app.setPath('userData', path.join(directory, 'electron'));
app.whenReady().then(async () => {
  const data = path.join(directory, 'installer');
  await fs.mkdir(data, {recursive:true});
  const phases = new Set();
  const network = [];
  let report;
  try {
    const requestImpl = options => {
      const item = {host:new URL(options.url).hostname}; network.push(item);
      const request = net.request(options);
      request.on('redirect',status=>{item.status=status;});
      request.on('response',response=>{item.status=response.statusCode;});
      request.on('error',()=>{if (!item.status) item.failed=true;});
      return request;
    };
    const installer = new PortalInstaller({userDataDir:data,requestImpl:portalRequestAdapter(requestImpl)});
    const installed = await installer.install({onProgress:value=>phases.add(value.phase)});
    const content = await fs.readFile(installed.executable);
    const digest = crypto.createHash('sha256').update(content).digest('hex');
    const inspected = await installer.inspect();
    report = {passed:digest===PORTAL_RELEASE.sha256 && content.length===PORTAL_RELEASE.size && inspected.verified===true,
      version:PORTAL_RELEASE.version,size:content.length,sha256:digest,phases:[...phases],network,verified:inspected.verified,executed:false};
  } catch (error) { report = {passed:false,error:error.message.startsWith('Portal ')?error.message:'Official Portal download or verification failed.',phases:[...phases],network,executed:false}; }
  await fs.writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2));
  process.stdout.write(JSON.stringify(report)+'\n');
  app.exit(report.passed?0:1);
}).catch(()=>app.exit(1));
