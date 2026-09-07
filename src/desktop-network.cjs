'use strict';
const {EventEmitter} = require('node:events');
const {Readable} = require('node:stream');

// Electron fetch rejects manual redirects. ClientRequest exposes them before following.
function portalRequestAdapter(requestImpl) {
  return (url, options, callback) => {
    const request = new EventEmitter();
    let ended=false, delivered=false, nativeRequest;
    const fail = () => {
      if (!delivered) { delivered=true; request.emit('error', new Error('Portal download failed')); }
    };
    request.end = () => {
      if (ended) return;
      ended=true;
      try {
        nativeRequest=requestImpl({url:url.href,method:'GET',redirect:'manual',credentials:'omit',useSessionCookies:false,referrerPolicy:'no-referrer'});
        nativeRequest.on('error',fail);
        nativeRequest.on('redirect',(statusCode,method,redirectUrl)=>{
          if (delivered) return;
          delivered=true;
          const response=Readable.from([]);
          response.statusCode=statusCode;
          response.headers={location:redirectUrl};
          try { callback(response); } finally { nativeRequest.abort(); }
        });
        nativeRequest.on('response',response=>{
          if (delivered) { response.resume(); return; }
          delivered=true;
          // Body errors remain attached to the actual response stream.
          callback(response);
        });
        nativeRequest.setHeader('User-Agent','Being-Desktop-Portal-Installer');
        nativeRequest.setHeader('Accept','application/octet-stream');
        nativeRequest.end();
      } catch { fail(); }
    };
    return request;
  };
}

module.exports = {portalRequestAdapter};
