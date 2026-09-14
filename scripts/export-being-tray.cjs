'use strict';

// The menu bar uses the original Be silhouette as an alpha mask. The application
// icon remains a separate export with its original black background.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {crc32} = require('node:zlib');
const {resizeBitmap} = require('./being-icon-artwork.cjs');
const sourceRecord = require('../design/being-pixel/logo-source.json');
const root = path.resolve(__dirname, '..');

function withDensity(png, scale) {
  // A PNG pHYs chunk records 72 dpi at 1x and 144 dpi at 2x for AppKit.
  const chunk = Buffer.alloc(21);
  chunk.writeUInt32BE(9, 0);
  chunk.write('pHYs', 4);
  chunk.writeUInt32BE(Math.round(72 * scale / 0.0254), 8);
  chunk.writeUInt32BE(Math.round(72 * scale / 0.0254), 12);
  chunk[16] = 1;
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 17)), 17);
  return Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]);
}

if (!process.versions.electron) {
  const {spawnSync} = require('node:child_process');
  const env = {...process.env};
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnSync(require('electron'), [__filename], {cwd: root, env, stdio: 'inherit'});
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
} else {
  const {app, nativeImage} = require('electron');
  try {
    const bytes = fs.readFileSync(path.join(root, sourceRecord.source));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sourceRecord.sourceSha256, 'Unexpected source artwork');
    const source = nativeImage.createFromBuffer(bytes).crop(sourceRecord.crop);
    const {width, height} = source.getSize();
    const pixels = source.toBitmap();
    let left = width, top = height, right = -1, bottom = -1;
    // Ignore near-black antialias noise when measuring the source silhouette.
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) > 32) {
        left = Math.min(left, x); right = Math.max(right, x);
        top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
    }
    assert(right > left && bottom > top, 'Source silhouette is empty');
    // Uniform scaling preserves the letter shapes and spacing. Center a square
    // around the measured glyph before sampling, then trim only empty padding.
    const side = Math.max(right - left + 1, bottom - top + 1) + 4;
    const crop = {x: Math.floor((left + right + 1 - side) / 2), y: Math.floor((top + bottom + 1 - side) / 2), width: side, height: side};
    const artwork = source.crop(crop).toBitmap();
    const destination = path.join(root, 'renderer/assets/being');
    const outputs = [];
    for (const scale of [1, 2]) {
      const size = 20 * scale;
      const sampled = resizeBitmap(artwork, side, side, size);
      let peak = 0;
      for (let i = 0; i < sampled.length; i += 4) peak = Math.max(peak, (sampled[i] + sampled[i + 1] + sampled[i + 2]) / 3);
      assert(peak > 0, 'Sampled silhouette is empty');
      const canvasWidth = 22 * scale, canvasHeight = 18 * scale;
      const bitmap = Buffer.alloc(canvasWidth * canvasHeight * 4);
      for (let y = 0; y < canvasHeight; y++) for (let x = 0; x < size; x++) {
        const input = ((y + scale) * size + x) * 4;
        const output = (y * canvasWidth + x + scale) * 4;
        // Normalize the sampled grid's peak to full opacity for menu bar
        // contrast. RGB stays black so the OS supplies the visible tint.
        bitmap[output + 3] = Math.round((sampled[input] + sampled[input + 1] + sampled[input + 2]) / 3 * 255 / peak);
      }
      const file = `being-trayTemplate${scale === 2 ? '@2x' : ''}.png`;
      const image = nativeImage.createFromBitmap(bitmap, {width: canvasWidth, height: canvasHeight, scaleFactor: scale});
      fs.writeFileSync(path.join(destination, file), withDensity(image.toPNG({scaleFactor: scale}), scale));
      outputs.push({file, width: canvasWidth, height: canvasHeight, scale});
    }
    console.log(JSON.stringify({source: sourceRecord.source, crop, logicalSize: {width: 22, height: 18}, outputs}));
    app.exit(0);
  } catch (error) {
    console.error(error.message);
    app.exit(1);
  }
}
