'use strict';
const {build,Platform}=require('electron-builder');
const config=require('../package.json').build;
build({targets:Platform.WINDOWS.createTarget(['dir']),config:{...config,
  directories:{...config.directories,output:process.argv[2] || 'dist-target-binding'},
  extraResources:[{from:'.local/target-binding-bundle',to:'portal-target-binding'}],
}}).catch(error=>{console.error(error);process.exitCode=1;});
