'use strict';

// Resample the source bitmap only. No glyph reconstruction or optical resizing.
function normalCdf(value) {
  const x = Math.abs(value);
  const t = 1 / (1 + 0.2316419 * x);
  const tail = Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI) *
    t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return value < 0 ? tail : 1 - tail;
}

function samplingWeights(sourceSize, size, sigma) {
  const scale = sourceSize / size;
  return Array.from({length: size}, (_, destination) => {
    const start = destination * scale;
    const end = (destination + 1) * scale;
    const spread = sigma * scale;
    const first = Math.max(0, Math.floor(start - 4 * spread));
    const last = Math.min(sourceSize, Math.ceil(end + 4 * spread));
    const weights = [];
    let total = 0;
    for (let source = first; source < last; source++) {
      const weight = spread > 0
        ? normalCdf((end - source - 0.5) / spread) - normalCdf((start - source - 0.5) / spread)
        : Math.max(0, Math.min(end, source + 1) - Math.max(start, source));
      weights.push(weight);
      total += weight;
    }
    return {first, weights: weights.map(weight => weight / total)};
  });
}

function resizeBitmap(source, width, height, size, {sigma = 0.3} = {}) {
  const horizontal = samplingWeights(width, size, sigma);
  const vertical = width === height ? horizontal : samplingWeights(height, size, sigma);
  const intermediate = new Float64Array(size * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < size; x++) {
      const {first, weights} = horizontal[x];
      const destination = (y * size + x) * 4;
      for (let sample = 0; sample < weights.length; sample++) {
        const offset = (y * width + first + sample) * 4;
        for (let channel = 0; channel < 4; channel++) {
          intermediate[destination + channel] += source[offset + channel] * weights[sample];
        }
      }
    }
  }
  const result = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const {first, weights} = vertical[y];
    for (let x = 0; x < size; x++) {
      const destination = (y * size + x) * 4;
      for (let channel = 0; channel < 4; channel++) {
        let value = 0;
        for (let sample = 0; sample < weights.length; sample++) {
          value += intermediate[((first + sample) * size + x) * 4 + channel] * weights[sample];
        }
        result[destination + channel] = Math.max(0, Math.min(255, Math.round(value)));
      }
    }
  }
  return result;
}

function smallSvg(images) {
  const sizes = [...images.keys()].sort((a, b) => a - b);
  let css = '.frame{display:none}.s64{display:inline}';
  // SVG image documents select by CSS width; UI consumers use PNG srcset for density.
  sizes.forEach((size, index) => {
    const minWidth = index ? (sizes[index - 1] + size) / 2 : 0;
    css += `@media(min-width:${minWidth}px){.frame{display:none}.s${size}{display:inline}}`;
  });
  const frames = sizes.map(size =>
    `<image class="frame s${size}" width="1024" height="1024" href="data:image/png;base64,${images.get(size).toString('base64')}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" role="img" aria-label="Being"><title>Being</title><style>${css}</style>${frames}</svg>\n`;
}

module.exports = {resizeBitmap, smallSvg};
