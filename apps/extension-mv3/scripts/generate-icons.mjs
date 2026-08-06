import { deflateSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sizes = Object.freeze([16, 32, 48, 128]);
const outputDirectory = fileURLToPath(new URL("../public/icons/", import.meta.url));
const storeIconSource = fileURLToPath(new URL("../assets/meanthis-icon-128.png", import.meta.url));
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
  const pixels = Array.from({ length: scale * scale }, () => [0, 0, 0, 0]);
  const unit = scale / logicalSize;
  const position = (value) => value * unit;
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
      position(left),
      position(top),
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
      position(centerX),
      position(centerY),
      distance(radiusX),
      distance(radiusY),
    ),
    color,
  );
  const polygon = (points, color) => {
    const scaled = points.map(([x, y]) => [position(x), position(y)]);
    draw((x, y) => insidePolygon(x, y, scaled), color);
  };
  const stroke = (points, width, color) => {
    const scaled = points.map(([x, y]) => [position(x), position(y)]);
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
  const curve = (start, control, end, width, color) => stroke(
    quadraticPoints(start, control, end),
    width,
    color,
  );

  const cobalt = [36, 87, 214, 255];
  const navy = [5, 11, 32, 255];
  const cream = [255, 240, 204, 255];

  if (logicalSize === 32) {
    const gold = [247, 183, 51, 255];
    rounded(0.5, 0.5, 31, 31, 7.5, cobalt);

    const leftEye = [[0.7, 5.3], [16.1, 14.7]];
    appendQuadratic(leftEye, [15.2, 19.9], [10.6, 22.3], 10);
    appendQuadratic(leftEye, [4.7, 23.2], [1.5, 17.7], 10);
    appendQuadratic(leftEye, [0.3, 12.3], [0.7, 5.3], 10);
    polygon(leftEye, gold);
    const rightEye = [[18, 15.5], [31.2, 9.6]];
    appendQuadratic(rightEye, [30.6, 14.8], [27.5, 18.1], 10);
    appendQuadratic(rightEye, [24.3, 20.9], [20.7, 18.8], 10);
    appendQuadratic(rightEye, [19.2, 18.1], [18, 15.5], 8);
    polygon(rightEye, gold);

    rounded(7.9, 12, 2.8, 6.4, 1.4, navy);
    rounded(24.4, 13.3, 1.8, 4, 0.9, navy);
    ellipse(8.7, 13.2, 0.42, 0.42, cream);
    ellipse(24.9, 14.1, 0.34, 0.34, cream);
    curve([0.5, 4.2], [8.1, 8.5], [16.2, 14.3], 1.5, cream);
    curve([31.3, 7.2], [23.9, 9.8], [18.3, 14.7], 1.3, cream);
    curve([15.3, 19], [8.8, 25.8], [2, 30.7], 1.5, cream);
    curve([18.2, 19], [24.5, 25.1], [31, 29.4], 1.3, cream);
    const mouth = [[10.3, 28]];
    appendQuadratic(mouth, [16.3, 22.9], [21, 26], 10);
    appendQuadratic(mouth, [23.5, 28], [26, 25.4], 8);
    stroke(mouth, 2.2, cream);
    stroke(mouth, 1.1, gold);
  } else {
    const gold = [255, 196, 77, 255];
    rounded(0, 0, 16, 16, 4, cobalt);

    const leftEye = [[0.2, 2.5], [8, 7.2]];
    appendQuadratic(leftEye, [7.6, 10.1], [5.2, 11.2], 8);
    appendQuadratic(leftEye, [2.3, 11.7], [0.7, 8.8], 8);
    appendQuadratic(leftEye, [0.1, 6.1], [0.2, 2.5], 8);
    polygon(leftEye, gold);
    const rightEye = [[9, 7.6], [15.7, 4.8]];
    appendQuadratic(rightEye, [15.4, 7.4], [13.8, 9.1], 8);
    appendQuadratic(rightEye, [12.2, 10.3], [10.4, 9.4], 8);
    appendQuadratic(rightEye, [9.5, 9], [9, 7.6], 6);
    polygon(rightEye, gold);

    rounded(3.9, 5.9, 1.5, 3.6, 0.75, navy);
    rounded(12.15, 6.4, 1.1, 2.4, 0.55, navy);
    curve([0.1, 2], [4, 4.2], [8, 7.1], 0.85, cream);
    curve([15.9, 3.6], [12.1, 4.9], [9.1, 7.3], 0.72, cream);
    curve([7.7, 9.6], [4.4, 13], [0.8, 15.5], 0.8, cream);
    curve([9.1, 9.6], [12.3, 12.7], [15.6, 14.8], 0.7, cream);
    const mouth = [[5, 14.4]];
    appendQuadratic(mouth, [8.1, 11.6], [10.4, 13.2], 8);
    appendQuadratic(mouth, [11.6, 14.2], [12.9, 12.8], 6);
    stroke(mouth, 1.2, cream);
    stroke(mouth, 0.65, gold);
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
  for (const size of sizes) {
    const path = join(outputDirectory, `meanthis-${size}.png`);
    const expected = size === 128 ? await readFile(storeIconSource) : renderIcon(size);
    if (check) {
      const observed = await readFile(path);
      if (!observed.equals(expected)) throw new Error(`Extension icon is stale: ${path}`);
    } else {
      await writeFile(path, expected);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await generateIcons({ check: process.argv.includes("--check") });
    process.stdout.write(`Extension icons ${process.argv.includes("--check") ? "verified" : "generated"}.\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
