import { inflateSync } from "node:zlib";

// What the fake agents log about a picture in a tool answer: whether its bytes are a PNG, the
// width and height from its header, and a coarse grid of where it has ink, so tests can check
// the picture shows the boxes without keeping the picture itself.
const SIGNATURE = "89504e470d0a1a0a";
/** The ink grid has this many columns and rows. */
export const INK_GRID = 32;

export function pngSize(base64) {
  const bytes = Buffer.from(base64, "base64");
  const png = bytes.subarray(0, 8).toString("hex") === SIGNATURE && bytes.length > 24;
  if (!png) return { png, width: 0, height: 0, ink: [] };
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return { png, width, height, ink: inkGrid(bytes, width, height) };
}

/** Rows of 0 and 1: 1 where a cell has a pixel that differs from the top left pixel. */
function inkGrid(bytes, width, height) {
  const depth = bytes[24];
  const colorType = bytes[25];
  const channels = { 2: 3, 6: 4 }[colorType];
  if (depth !== 8 || !channels || bytes[28] !== 0) return [];
  const parts = [];
  for (let at = 8; at < bytes.length;) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.subarray(at + 4, at + 8).toString("latin1");
    if (type === "IDAT") parts.push(bytes.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const data = inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = data[y * (stride + 1)];
    const row = data.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const corner = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;
      const guess = left + up - corner;
      const nearest =
        Math.abs(guess - left) <= Math.abs(guess - up) &&
        Math.abs(guess - left) <= Math.abs(guess - corner)
          ? left
          : Math.abs(guess - up) <= Math.abs(guess - corner)
            ? up
            : corner;
      const add = [0, left, up, (left + up) >> 1, nearest][filter];
      pixels[y * stride + x] = (row[x] + add) & 0xff;
    }
  }
  const grid = Array.from({ length: INK_GRID }, () => Array(INK_GRID).fill("0"));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = y * stride + x * channels;
      let differs = false;
      for (let c = 0; c < 3; c++) if (Math.abs(pixels[at + c] - pixels[c]) > 24) differs = true;
      if (differs)
        grid[Math.floor((y * INK_GRID) / height)][Math.floor((x * INK_GRID) / width)] = "1";
    }
  return grid.map((row) => row.join(""));
}
