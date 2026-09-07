'use strict';

// Preserve the source artwork and its proportions at every exported size.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const {createHash, randomUUID} = require('node:crypto');
const {resizeBitmap, smallSvg} = require('./being-icon-artwork.cjs');
const sourceRecord = require('../design/being-pixel/logo-source.json');
const root = path.resolve(__dirname, '..');
const frameSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

if (!process.versions.electron) {
  const {spawn} = require('node:child_process');
  const env = {...process.env};
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, ...process.argv.slice(2)], {
    cwd: root, env, windowsHide: true, stdio: 'inherit',
  });
  child.on('error', error => {process.stderr.write(`${error.message}\n`); process.exitCode = 1;});
  child.on('exit', code => {process.exitCode = code ?? 1;});
} else {
  const {app, nativeImage} = require('electron');
  app.setPath('userData', path.join(root, '.local', 'being-icon-export', randomUUID()));
  app.disableHardwareAcceleration();
  app.whenReady().then(async () => {
    try {
      const source = path.resolve(process.argv[2] || path.join(root, 'design/being-pixel/being-source.png'));
      const sourceBytes = await fs.readFile(source);
      assert(sourceBytes.subarray(0, 8).equals(pngSignature), 'Source must be a PNG.');
      const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
      assert.equal(sourceSha256, sourceRecord.sourceSha256, 'Source changed; confirm the new artwork before exporting.');
      const original = nativeImage.createFromBuffer(sourceBytes);
      assert(!original.isEmpty(), 'Source PNG could not be decoded.');
      const sourceSize = original.getSize();
      assert(sourceSize.width > 0 && sourceSize.height > 0, 'Source dimensions must be positive.');
      const side = Math.min(sourceSize.width, sourceSize.height);
      const crop = {x: Math.floor((sourceSize.width - side) / 2), y: Math.floor((sourceSize.height - side) / 2), width: side, height: side};
      const artwork = original.crop(crop);

      const png = artwork.resize({width: 1024, height: 1024, quality: 'best'}).toPNG();
      const sourceBitmap = artwork.toBitmap();
      const rasterSizes = [...new Set([...frameSizes, 80, 96, 112, 160, 192, 512])].sort((a, b) => a - b);
      const sourceImages = new Map();
      for (const size of rasterSizes) {
        const bitmap = resizeBitmap(sourceBitmap, side, side, size);
        sourceImages.set(size, nativeImage.createFromBitmap(bitmap, {width: size, height: size}).toPNG());
      }
      sourceImages.set(1024, png);
      const images = frameSizes.map(size => sourceImages.get(size));
      const svg = smallSvg(sourceImages);
      const directory = Buffer.alloc(6 + frameSizes.length * 16);
      directory.writeUInt16LE(1, 2);
      directory.writeUInt16LE(frameSizes.length, 4);
      let offset = directory.length;
      frameSizes.forEach((size, index) => {
        const entry = 6 + index * 16;
        directory[entry] = size === 256 ? 0 : size;
        directory[entry + 1] = size === 256 ? 0 : size;
        directory.writeUInt16LE(1, entry + 4);
        directory.writeUInt16LE(32, entry + 6);
        directory.writeUInt32LE(images[index].length, entry + 8);
        directory.writeUInt32LE(offset, entry + 12);
        offset += images[index].length;
      });
      const ico = Buffer.concat([directory, ...images]);

      function verifyPng(bytes, size) {
        assert(bytes.subarray(0, 8).equals(pngSignature), 'Exported image is not PNG.');
        assert.equal(bytes.readUInt32BE(16), size, 'PNG width mismatch.');
        assert.equal(bytes.readUInt32BE(20), size, 'PNG height mismatch.');
        const decoded = nativeImage.createFromBuffer(bytes);
        assert(!decoded.isEmpty(), 'Exported PNG could not be decoded.');
        assert.deepEqual(decoded.getSize(), {width: size, height: size});
        return decoded;
      }
      const decodedPng = verifyPng(png, 1024);
      assert.equal(ico.readUInt16LE(0), 0);
      assert.equal(ico.readUInt16LE(2), 1);
      assert.equal(ico.readUInt16LE(4), frameSizes.length);
      let expectedOffset = 6 + frameSizes.length * 16;
      const verifiedFrames = frameSizes.map((size, index) => {
        const entry = 6 + index * 16;
        assert.equal(ico[entry] || 256, size);
        assert.equal(ico[entry + 1] || 256, size);
        assert.equal(ico.readUInt16LE(entry + 4), 1);
        assert.equal(ico.readUInt16LE(entry + 6), 32);
        const bytes = ico.readUInt32LE(entry + 8);
        const start = ico.readUInt32LE(entry + 12);
        assert.equal(start, expectedOffset);
        assert(start + bytes <= ico.length, 'ICO frame exceeds file bounds.');
        verifyPng(ico.subarray(start, start + bytes), size);
        expectedOffset += bytes;
        return {size, bytes, decoded: true};
      });
      assert.equal(expectedOffset, ico.length);
      const hasAlpha = image => {
        const pixels = image.toBitmap();
        for (let index = 3; index < pixels.length; index += 4) if (pixels[index] < 255) return true;
        return false;
      };
      const sourceHasTransparency = hasAlpha(original);
      const outputHasTransparency = hasAlpha(decodedPng);
      assert(!sourceHasTransparency || outputHasTransparency, 'Source transparency was lost.');

      const destination = path.join(root, 'renderer/assets/being');
      await fs.mkdir(destination, {recursive: true});
      const pngPath = path.join(destination, 'being-icon.png');
      const icoPath = path.join(destination, 'being-icon.ico');
      const smallSvgPath = path.join(destination, 'being-icon-small.svg');
      await fs.writeFile(pngPath, png);
      await fs.writeFile(icoPath, ico);
      await fs.writeFile(smallSvgPath, svg);

      for (const size of rasterSizes) {
        await fs.writeFile(path.join(destination, `being-icon-${size}.png`), sourceImages.get(size));
      }
      assert((await fs.readFile(pngPath)).equals(png), 'PNG write verification failed.');
      assert((await fs.readFile(icoPath)).equals(ico), 'ICO write verification failed.');
      const report = {
        passed: true, source, sourceSize, crop, sourceHasTransparency, outputHasTransparency,
        sourceSha256, smallSvg: smallSvgPath,
        smallIconPolicy: 'All sizes come from the same original crop, scaled uniformly. Gaussian-prefiltered area sampling (sigma 0.3 output pixels) reduces aliasing. No glyph redrawing, tile merging, letter-spacing changes, or optical enlargement. UI uses density-aware PNG srcset; the SVG fallback selects source-derived rasters by CSS width. The source and 1024 px PNG are unchanged.',
        transform: {crop, scaleX: 'outputSize / 1152', scaleY: 'outputSize / 1152', sigmaInOutputPixels: 0.3},
        rasterSizes: [...sourceImages.keys()],
        png: {path: pngPath, size: 1024, bytes: png.length, sha256: createHash('sha256').update(png).digest('hex')},
        ico: {path: icoPath, bytes: ico.length, sha256: createHash('sha256').update(ico).digest('hex'), frames: verifiedFrames},
      };
      await fs.writeFile(path.join(root, 'design/being-pixel/icon-export-report.json'), JSON.stringify(report, null, 2) + '\n');
      process.stdout.write(JSON.stringify(report) + '\n');
      app.exit(0);
    } catch (error) {
      process.stderr.write(`Being icon export failed: ${error.message}\n`);
      app.exit(1);
    }
  });
}
