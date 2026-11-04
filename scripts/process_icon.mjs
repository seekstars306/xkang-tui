import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import fs from 'node:fs';
import path from 'node:path';

const SRC = process.argv[2];
if (!SRC) {
  console.error('Usage: node process_icon.mjs <source-image>');
  process.exit(1);
}

const ASSETS_DIR = path.resolve('assets');
const RELEASES_DIR = path.resolve('server/data/releases');

async function main() {
  // 1. Load and get metadata
  const img = sharp(SRC);
  const meta = await img.metadata();
  console.log(`Source: ${meta.width}x${meta.height}, format: ${meta.format}`);

  // 2. Get raw pixel data (RGBA)
  const { data, info } = await img
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  console.log(`Raw: ${width}x${height}, channels: ${channels}`);

  // 3. Flood fill from corners to identify background pixels
  //    Background = light-colored pixels connected to the edges
  const visited = new Uint8Array(width * height);
  const queue = [];

  function getPixel(x, y) {
    const i = (y * width + x) * channels;
    return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] };
  }

  function isBackground(x, y) {
    const p = getPixel(x, y);
    // Light background: high brightness, low saturation
    const brightness = (p.r + p.g + p.b) / 3;
    const maxC = Math.max(p.r, p.g, p.b);
    const minC = Math.min(p.r, p.g, p.b);
    const saturation = maxC === 0 ? 0 : (maxC - minC) / maxC;
    // Background is bright (>180) and low saturation (<0.25)
    return brightness > 180 && saturation < 0.25;
  }

  // Seed flood fill from all edge pixels
  for (let x = 0; x < width; x++) {
    if (isBackground(x, 0)) queue.push([x, 0]);
    if (isBackground(x, height - 1)) queue.push([x, height - 1]);
  }
  for (let y = 0; y < height; y++) {
    if (isBackground(0, y)) queue.push([0, y]);
    if (isBackground(width - 1, y)) queue.push([width - 1, y]);
  }

  // BFS flood fill
  while (queue.length > 0) {
    const [cx, cy] = queue.shift();
    const idx = cy * width + cx;
    if (cx < 0 || cx >= width || cy < 0 || cy >= height || visited[idx]) continue;
    if (!isBackground(cx, cy)) continue;
    visited[idx] = 1;

    queue.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
  }

  // 4. Set alpha=0 for background pixels
  let transparentCount = 0;
  for (let i = 0; i < width * height; i++) {
    if (visited[i]) {
      data[i * channels + 3] = 0; // Set alpha to 0
      transparentCount++;
    }
  }
  console.log(`Made ${transparentCount} pixels transparent (${(transparentCount / (width * height) * 100).toFixed(1)}%)`);

  // 5. Also add slight edge feathering: pixels adjacent to transparent areas get semi-transparent
  const feathered = Buffer.from(data);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      if (!visited[idx]) {
        // Check if any neighbor is transparent
        const neighbors = [
          (y - 1) * width + x,
          (y + 1) * width + x,
          y * width + (x - 1),
          y * width + (x + 1),
        ];
        const transparentNeighbors = neighbors.filter(n => visited[n]).length;
        if (transparentNeighbors > 0) {
          const pi = idx * channels;
          // Slightly reduce alpha for edge smoothing
          const currentAlpha = feathered[pi + 3];
          const reduction = transparentNeighbors * 60;
          feathered[pi + 3] = Math.max(0, currentAlpha - reduction);
        }
      }
    }
  }

  // 6. Find bounding box of non-transparent content
  let minX = width, minY = height, maxX = 0, maxY = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (!visited[idx]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  console.log(`Content bounding box: (${minX},${minY}) to (${maxX},${maxY}) = ${maxX - minX + 1}x${maxY - minY + 1}`);

  // 7. Crop to content and resize to 256x256 PNG
  const contentW = maxX - minX + 1;
  const contentH = maxY - minY + 1;
  const size = Math.max(contentW, contentH);
  const padding = Math.round(size * 0.02); // 2% padding
  const cropSize = size + padding * 2;

  // Calculate crop region centered on content
  const centerX = Math.round((minX + maxX) / 2);
  const centerY = Math.round((minY + maxY) / 2);
  const cropLeft = Math.max(0, centerX - Math.round(cropSize / 2));
  const cropTop = Math.max(0, centerY - Math.round(cropSize / 2));
  const cropRight = Math.min(width, cropLeft + cropSize);
  const cropBottom = Math.min(height, cropTop + cropSize);

  const pngBuffer = await sharp(feathered, {
    raw: { width, height, channels },
  })
    .extract({
      left: cropLeft,
      top: cropTop,
      width: cropRight - cropLeft,
      height: cropBottom - cropTop,
    })
    .resize(256, 256, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  // 8. Save PNG
  const pngPath = path.join(ASSETS_DIR, 'icon.png');
  fs.writeFileSync(pngPath, pngBuffer);
  console.log(`Saved: ${pngPath} (${pngBuffer.length} bytes)`);

  // 9. Generate ICO with multiple sizes
  const sizes = [16, 32, 48, 64, 128, 256];
  const pngBuffers = await Promise.all(
    sizes.map(s =>
      sharp(pngBuffer)
        .resize(s, s, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer()
    )
  );

  const icoBuffer = await pngToIco(pngBuffers);
  const icoPath = path.join(ASSETS_DIR, 'icon.ico');
  fs.writeFileSync(icoPath, icoBuffer);
  console.log(`Saved: ${icoPath} (${icoBuffer.length} bytes)`);

  // 10. Copy to server releases
  fs.mkdirSync(RELEASES_DIR, { recursive: true });
  fs.copyFileSync(pngPath, path.join(RELEASES_DIR, 'icon.png'));
  fs.copyFileSync(icoPath, path.join(RELEASES_DIR, 'icon.ico'));
  console.log(`Copied to ${RELEASES_DIR}`);

  console.log('Done!');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
