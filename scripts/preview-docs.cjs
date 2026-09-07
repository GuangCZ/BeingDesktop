'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../docs');
const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.xml':'application/xml'};
const server = http.createServer((request, response) => {
  let pathname;
  try {pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).replace(/^\/BeingDesktop(?=\/)/, '');} catch {response.writeHead(400).end(); return;}
  const file = path.resolve(root, '.' + (pathname.endsWith('/') ? pathname + 'index.html' : pathname));
  if (!file.startsWith(root + path.sep)) {response.writeHead(403).end(); return;}
  fs.readFile(file, (error, content) => {
    if (error) {response.writeHead(404).end('Not found'); return;}
    response.writeHead(200, {'Content-Type':types[path.extname(file)] || 'application/octet-stream','Cache-Control':'no-store'}).end(content);
  });
});
server.listen(4173, '127.0.0.1', () => console.log('Documentation: http://127.0.0.1:4173/BeingDesktop/'));
