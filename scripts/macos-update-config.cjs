'use strict';
const {writeFile} = require('node:fs/promises');
const path = require('node:path');
const {getAppUpdatePublishConfiguration} = require('app-builder-lib/out/publish/PublishManager');
const {serializeToYaml} = require('builder-util');
module.exports = async context => {
  const config = await getAppUpdatePublishConfiguration(context.packager, null, context.arch, false);
  if (!config) throw new Error('Desktop update feed is required before signing.');
  await writeFile(path.join(context.packager.getResourcesDir(context.appOutDir), 'app-update.yml'), serializeToYaml(config));
};
