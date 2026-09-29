import { MAX_VOICE_AUDIO_BYTES } from "@irudd-scope/protocol/voice";

export function speechWav(
  bytes: Buffer,
  mediaType: string,
): { bytes: Buffer; durationSeconds: number } {
  if (!bytes.length || bytes.length + 44 > MAX_VOICE_AUDIO_BYTES)
    throw new Error("The provider returned empty or oversized audio.");
  if (mediaType.split(";")[0].trim() === "audio/wav" || bytes.toString("ascii", 0, 4) === "RIFF") {
    if (
      bytes.toString("ascii", 0, 4) !== "RIFF" ||
      bytes.toString("ascii", 8, 12) !== "WAVE" ||
      bytes.readUInt32LE(4) + 8 !== bytes.length
    )
      throw new Error("The provider returned invalid WAV audio.");
    let format = false;
    let dataSize = 0;
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const kind = bytes.toString("ascii", offset, offset + 4);
      const size = bytes.readUInt32LE(offset + 4);
      const start = offset + 8;
      if (start + size > bytes.length)
        throw new Error("The provider returned truncated WAV audio.");
      if (kind === "fmt ") {
        if (
          format ||
          size < 16 ||
          bytes.readUInt16LE(start) !== 1 ||
          bytes.readUInt16LE(start + 2) !== 1 ||
          bytes.readUInt32LE(start + 4) !== 24000 ||
          bytes.readUInt32LE(start + 8) !== 48000 ||
          bytes.readUInt16LE(start + 12) !== 2 ||
          bytes.readUInt16LE(start + 14) !== 16
        )
          throw new Error("Expected 24 kHz mono signed 16-bit PCM WAV.");
        format = true;
      }
      if (kind === "data") {
        if (dataSize || size % 2) throw new Error("The provider returned invalid WAV samples.");
        dataSize = size;
      }
      offset = start + size + (size % 2);
    }
    if (!format || !dataSize || offset !== bytes.length)
      throw new Error("The provider returned invalid WAV audio.");
    return { bytes, durationSeconds: dataSize / 48000 };
  }
  if (mediaType.split(";")[0].trim() !== "audio/pcm" || bytes.length % 2)
    throw new Error("Expected signed 16-bit little-endian mono PCM at 24 kHz.");
  const rate = /(?:rate|samplerate)=(\d+)/i.exec(mediaType);
  const channels = /channels=(\d+)/i.exec(mediaType);
  if ((rate && rate[1] !== "24000") || (channels && channels[1] !== "1"))
    throw new Error("The provider returned an unsupported PCM rate or channel count.");
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(bytes.length + 36, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(bytes.length, 40);
  return { bytes: Buffer.concat([header, bytes]), durationSeconds: bytes.length / 48000 };
}
