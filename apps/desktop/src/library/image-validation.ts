import { crc32 } from "node:zlib";
import { ScopeError } from "@irudd-scope/protocol";

export function validatePng(base64: string): { bytes: Buffer; width: number; height: number } {
  if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64))
    throw new ScopeError(400, "Screenshot must be base64 PNG.");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.byteLength > 8 * 1024 * 1024) throw new ScopeError(413, "Screenshot exceeds 8 MiB.");
  if (
    bytes.length < 33 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString("ascii", 12, 16) !== "IHDR"
  )
    throw new ScopeError(400, "Screenshot must be a PNG image.");
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height || width > 8192 || height > 8192)
    throw new ScopeError(400, "Screenshot dimensions must be between 1 and 8192 pixels.");
  const depths: Record<number, readonly number[]> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  if (
    !depths[bytes[25]]?.includes(bytes[24]) ||
    bytes[26] !== 0 ||
    bytes[27] !== 0 ||
    bytes[28] > 1
  )
    throw new ScopeError(400, "Screenshot PNG header is invalid.");
  let offset = 8;
  let imageData = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + length + 12;
    if (end > bytes.length) break;
    const kind = bytes.toString("ascii", offset + 4, offset + 8);
    if (
      crc32(bytes.subarray(offset + 4, offset + length + 8)) !==
      bytes.readUInt32BE(offset + length + 8)
    )
      throw new ScopeError(400, "Screenshot PNG checksum is invalid.");
    if (kind === "IHDR" && offset !== 8)
      throw new ScopeError(400, "Screenshot PNG repeats its header.");
    if (kind === "IDAT" && length > 0) imageData = true;
    if (kind === "IEND" && length === 0 && end === bytes.length && imageData)
      return { bytes, width, height };
    offset = end;
  }
  throw new ScopeError(400, "Screenshot PNG is incomplete.");
}
