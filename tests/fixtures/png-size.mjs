// What the fake agents log about a picture in a tool answer: whether its bytes are a PNG and
// the width and height from its header, so tests never keep the picture itself.
const SIGNATURE = "89504e470d0a1a0a";

export function pngSize(base64) {
  const bytes = Buffer.from(base64, "base64");
  const png = bytes.subarray(0, 8).toString("hex") === SIGNATURE && bytes.length > 24;
  return png
    ? { png, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
    : { png, width: 0, height: 0 };
}
