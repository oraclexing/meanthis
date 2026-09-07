import { deflateSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sizes = Object.freeze([16, 32, 48, 128]);
const outputDirectory = fileURLToPath(new URL("../public/icons/", import.meta.url));
const storeIconPath = fileURLToPath(new URL("../assets/meanthis-icon-128.png", import.meta.url));
const supersample = 4;

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ ((value & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  name.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return result;
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const scanlines = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y += 1) {
    const offset = y * (1 + size * 4);
    scanlines[offset] = 0;
    rgba.copy(scanlines, offset + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(scanlines, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function insideRoundedRect(x, y, left, top, width, height, radius) {
  const right = left + width;
  const bottom = top + height;
  if (x < left || x >= right || y < top || y >= bottom) return false;
  const nearestX = Math.max(left + radius, Math.min(x, right - radius));
  const nearestY = Math.max(top + radius, Math.min(y, bottom - radius));
  const dx = x - nearestX;
  const dy = y - nearestY;
  return dx * dx + dy * dy <= radius * radius;
}

function insideEllipse(x, y, centerX, centerY, radiusX, radiusY) {
  const dx = (x - centerX) / radiusX;
  const dy = (y - centerY) / radiusY;
  return dx * dx + dy * dy <= 1;
}

function insidePolygon(x, y, points) {
  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index, index += 1) {
    const [currentX, currentY] = points[index];
    const [previousX, previousY] = points[previous];
    if (((currentY > y) !== (previousY > y))
      && x < ((previousX - currentX) * (y - currentY)) / (previousY - currentY) + currentX) {
      inside = !inside;
    }
  }
  return inside;
}

function distanceToSegment(x, y, startX, startY, endX, endY) {
  const segmentX = endX - startX;
  const segmentY = endY - startY;
  const lengthSquared = segmentX * segmentX + segmentY * segmentY;
  const ratio = lengthSquared === 0
    ? 0
    : Math.max(0, Math.min(1, ((x - startX) * segmentX + (y - startY) * segmentY) / lengthSquared));
  return Math.hypot(
    x - (startX + ratio * segmentX),
    y - (startY + ratio * segmentY),
  );
}

function quadraticPoints(start, control, end, segments = 12) {
  const points = [start];
  for (let index = 1; index <= segments; index += 1) {
    const t = index / segments;
    const inverse = 1 - t;
    points.push([
      inverse * inverse * start[0] + 2 * inverse * t * control[0] + t * t * end[0],
      inverse * inverse * start[1] + 2 * inverse * t * control[1] + t * t * end[1],
    ]);
  }
  return points;
}

function appendQuadratic(points, control, end, segments = 12) {
  points.push(...quadraticPoints(points.at(-1), control, end, segments).slice(1));
  return points;
}

function blend(pixel, color) {
  const sourceAlpha = color[3] / 255;
  const targetAlpha = pixel[3] / 255;
  const alpha = sourceAlpha + targetAlpha * (1 - sourceAlpha);
  if (alpha === 0) return [0, 0, 0, 0];
  return [
    Math.round((color[0] * sourceAlpha + pixel[0] * targetAlpha * (1 - sourceAlpha)) / alpha),
    Math.round((color[1] * sourceAlpha + pixel[1] * targetAlpha * (1 - sourceAlpha)) / alpha),
    Math.round((color[2] * sourceAlpha + pixel[2] * targetAlpha * (1 - sourceAlpha)) / alpha),
    Math.round(alpha * 255),
  ];
}

function renderIcon(size) {
  const logicalSize = size === 16 ? 16 : 32;
  const scale = size * supersample;
  const safeInset = size === 128 ? 8 * supersample : 0;
  const renderScale = (size === 128 ? 112 : size) * supersample;
  const visualScale = size === 16 ? 1.18 : size === 32 ? 1.1 : size === 48 ? 1.06 : 1.1;
  const pixels = Array.from({ length: scale * scale }, () => [0, 0, 0, 0]);
  const unit = (renderScale / logicalSize) * visualScale;
  const horizontalNudge = 0;
  const verticalNudge = (size === 16 ? -0.8 : size === 32 ? -0.75 : size === 48 ? -1 : 0)
    * supersample;
  const renderCenter = safeInset + renderScale / 2;
  const positionX = (value) => renderCenter + horizontalNudge + (value - logicalSize / 2) * unit;
  const positionY = (value) => renderCenter + verticalNudge + (value - logicalSize / 2) * unit;
  const distance = (value) => value * unit;
  const draw = (predicate, color) => {
    for (let y = 0; y < scale; y += 1) {
      for (let x = 0; x < scale; x += 1) {
        const sampleX = x + 0.5;
        const sampleY = y + 0.5;
        if (!predicate(sampleX, sampleY)) continue;
        pixels[y * scale + x] = blend(pixels[y * scale + x], color);
      }
    }
  };
  const rounded = (left, top, width, height, radius, color) => draw(
    (x, y) => insideRoundedRect(
      x,
      y,
      positionX(left),
      positionY(top),
      distance(width),
      distance(height),
      distance(radius),
    ),
    color,
  );
  const ellipse = (centerX, centerY, radiusX, radiusY, color) => draw(
    (x, y) => insideEllipse(
      x,
      y,
      positionX(centerX),
      positionY(centerY),
      distance(radiusX),
      distance(radiusY),
    ),
    color,
  );
  const polygon = (points, color) => {
    const scaled = points.map(([x, y]) => [positionX(x), positionY(y)]);
    draw((x, y) => insidePolygon(x, y, scaled), color);
  };
  const stroke = (points, width, color) => {
    const scaled = points.map(([x, y]) => [positionX(x), positionY(y)]);
    const radius = distance(width) / 2;
    draw((x, y) => scaled.some((point, index) => index > 0 && distanceToSegment(
      x,
      y,
      scaled[index - 1][0],
      scaled[index - 1][1],
      point[0],
      point[1],
    ) <= radius), color);
  };

  const cobalt = [36, 87, 214, 255];
  const navy = [5, 11, 32, 255];
  const cream = [255, 240, 204, 255];
  const nose = [169, 99, 86, 255];

  if (logicalSize === 32) {
    const gold = [247, 183, 51, 255];
    const head = [[5.1, 10.5], [5.6, 5.2]];
    appendQuadratic(head, [5.7, 4.3], [6.5, 4.7], 6);
    head.push([11, 9.2]);
    appendQuadratic(head, [12.5, 8.1], [14.3, 9.1], 8);
    head.push([16, 7.8], [17.7, 9.1]);
    appendQuadratic(head, [19.5, 8.1], [21, 9.2], 8);
    head.push([25.5, 4.7]);
    appendQuadratic(head, [26.3, 4.3], [26.4, 5.2], 6);
    head.push([26.8, 10.5]);
    appendQuadratic(head, [29.2, 12.9], [29.5, 17], 10);
    head.push(
      [31, 18.5], [29.6, 20], [30.8, 21.6], [28.9, 22.7], [29.8, 24.5],
      [27.4, 25.2], [27.8, 27], [24.8, 26.9],
    );
    appendQuadratic(head, [21.6, 29.3], [16, 29.5], 12);
    appendQuadratic(head, [10.4, 29.3], [7.2, 26.9], 12);
    head.push(
      [4.2, 27], [4.6, 25.2], [2.2, 24.5], [3.1, 22.7], [1.2, 21.6],
      [2.4, 20], [1, 18.5], [2.5, 17],
    );
    appendQuadratic(head, [2.8, 12.9], [5.1, 10.5], 10);
    polygon(head, gold);
    stroke(head, 1.6, cobalt);
    stroke(head, 0.7, navy);

    polygon([[6.6, 6.4], [10.6, 9.9], [6.3, 10.7]], cream);
    polygon([[25.4, 6.4], [21.4, 9.9], [25.7, 10.7]], cream);

    const leftEye = [[7.1, 15.1]];
    appendQuadratic(leftEye, [10.6, 15.9], [14.1, 15.2], 8);
    appendQuadratic(leftEye, [13.2, 20.2], [10.4, 20.2], 10);
    appendQuadratic(leftEye, [7.7, 20.2], [7.1, 15.1], 10);
    polygon(leftEye, navy);
    const leftEyeLight = [[8.5, 16.4]];
    appendQuadratic(leftEyeLight, [10.7, 16.9], [12.8, 16.4], 8);
    appendQuadratic(leftEyeLight, [12.3, 18.9], [10.6, 18.9], 8);
    appendQuadratic(leftEyeLight, [8.9, 18.9], [8.5, 16.4], 8);
    polygon(leftEyeLight, cream);
    ellipse(10.6, 17, 0.8, 1.15, navy);

    const rightEye = [[17.9, 15.2]];
    appendQuadratic(rightEye, [21.4, 15.9], [24.9, 15.1], 8);
    appendQuadratic(rightEye, [24.3, 20.2], [21.6, 20.2], 10);
    appendQuadratic(rightEye, [18.8, 20.2], [17.9, 15.2], 10);
    polygon(rightEye, navy);
    const rightEyeLight = [[19.2, 16.4]];
    appendQuadratic(rightEyeLight, [21.3, 16.9], [23.5, 16.4], 8);
    appendQuadratic(rightEyeLight, [23.1, 18.9], [21.4, 18.9], 8);
    appendQuadratic(rightEyeLight, [19.7, 18.9], [19.2, 16.4], 8);
    polygon(rightEyeLight, cream);
    ellipse(21.4, 17, 0.8, 1.15, navy);

    ellipse(13.4, 23.2, 3.9, 4.2, cream);
    ellipse(18.6, 23.2, 3.9, 4.2, cream);
    polygon([[13.8, 19.8], [16, 18.9], [18.2, 19.8], [16, 21.9]], nose);
    stroke([[13.8, 19.8], [16, 18.9], [18.2, 19.8], [16, 21.9], [13.8, 19.8]], 0.45, navy);
    stroke([[16, 21.9], [16, 23.4]], 0.9, navy);
    stroke([[16, 23.4], [14.6, 24.6]], 0.9, navy);
    stroke([[16, 23.4], [17.4, 24.6]], 0.9, navy);
    stroke([[10.3, 20.5], [3.9, 19.8]], 0.78, navy);
    stroke([[10.1, 22.5], [3.6, 22.1]], 0.78, navy);
    stroke([[10.3, 23.3], [4.3, 24.8]], 0.78, navy);
    stroke([[21.7, 20.5], [28.1, 19.8]], 0.78, navy);
    stroke([[21.9, 22.5], [28.4, 22.1]], 0.78, navy);
    stroke([[21.7, 23.3], [27.7, 24.8]], 0.78, navy);
  } else {
    const gold = [255, 196, 77, 255];
    const head = [
      [2.4, 5.6], [2.8, 2.5], [5.2, 4.7], [7.2, 4.7], [8, 4], [8.8, 4.7],
      [10.8, 4.7], [13.2, 2.5], [13.6, 5.6], [15.1, 8.7], [15.8, 9.4],
      [15.1, 10.2], [15.7, 11], [14.8, 11.6], [15.2, 12.5], [14, 12.8],
      [14.2, 13.8], [12.7, 13.7], [11, 14.8], [8, 15], [5, 14.8], [3.3, 13.7],
      [1.8, 13.8], [2, 12.8], [0.8, 12.5], [1.2, 11.6], [0.3, 11],
      [0.9, 10.2], [0.2, 9.4], [0.9, 8.7], [2.4, 5.6],
    ];
    polygon(head, gold);
    stroke(head, 0.8, cobalt);
    stroke(head, 0.35, navy);
    polygon([[3.3, 3.5], [5.1, 4.9], [3.2, 5.4]], cream);
    polygon([[12.7, 3.5], [10.9, 4.9], [12.8, 5.4]], cream);
    polygon([[3.5, 7.3], [7, 7.3], [6.2, 9.2], [5.1, 9.6], [4, 9.1]], navy);
    ellipse(5.2, 8.15, 0.9, 0.75, cream);
    polygon([[9, 7.3], [12.5, 7.3], [12, 9.1], [10.9, 9.6], [9.8, 9.2]], navy);
    ellipse(10.8, 8.15, 0.9, 0.75, cream);
    ellipse(6.6, 11.6, 2, 2.2, cream);
    ellipse(9.4, 11.6, 2, 2.2, cream);
    polygon([[7.3, 10], [8, 9.6], [8.7, 10], [8, 10.8]], nose);
    stroke([[8, 10.8], [8, 11.7]], 0.5, navy);
    stroke([[8, 11.7], [7.3, 12.3]], 0.5, navy);
    stroke([[8, 11.7], [8.7, 12.3]], 0.5, navy);
    stroke([[5.5, 10.6], [2.3, 10.2]], 0.45, navy);
    stroke([[5.4, 11.5], [2.3, 12]], 0.45, navy);
    stroke([[10.5, 10.6], [13.7, 10.2]], 0.45, navy);
    stroke([[10.6, 11.5], [13.7, 12]], 0.45, navy);
  }

  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const totals = [0, 0, 0, 0];
      for (let sampleY = 0; sampleY < supersample; sampleY += 1) {
        for (let sampleX = 0; sampleX < supersample; sampleX += 1) {
          const sourceX = x * supersample + sampleX;
          const pixel = pixels[(y * supersample + sampleY) * scale + sourceX];
          for (let channel = 0; channel < 4; channel += 1) totals[channel] += pixel[channel];
        }
      }
      const offset = (y * size + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        rgba[offset + channel] = Math.round(totals[channel] / (supersample * supersample));
      }
    }
  }
  return encodePng(size, rgba);
}

export async function generateIcons({ check = false } = {}) {
  if (!check) await mkdir(outputDirectory, { recursive: true });
  const expectedStoreIcon = renderIcon(128);
  if (check) {
    const observedStoreIcon = await readFile(storeIconPath);
    if (!observedStoreIcon.equals(expectedStoreIcon)) {
      throw new Error("Extension icon is stale: " + storeIconPath);
    }
  } else {
    await writeFile(storeIconPath, expectedStoreIcon);
  }
  for (const size of sizes) {
    const path = join(outputDirectory, "meanthis-" + size + ".png");
    const expected = size === 128 ? expectedStoreIcon : renderIcon(size);
    if (check) {
      const observed = await readFile(path);
      if (!observed.equals(expected)) throw new Error("Extension icon is stale: " + path);
    } else {
      await writeFile(path, expected);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await generateIcons({ check: process.argv.includes("--check") });
    process.stdout.write("Extension icons "
      + (process.argv.includes("--check") ? "verified" : "generated")
      + ".\n");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
