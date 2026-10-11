/** Inspect only the fixed video-config prefix while forwarding bytes with backpressure. */
export function videoMetadataTransform(onConfig: (width: number, height: number) => void, onFrame?: () => void): TransformStream<Uint8Array, Uint8Array> {
  let header = Buffer.alloc(0);
  let prefix = Buffer.alloc(0);
  let remaining = 0;
  let type = 0;
  return new TransformStream({
    transform(chunk, controller) {
      let offset = 0;
      while (offset < chunk.length) {
        if (remaining === 0) {
          const length = Math.min(8 - header.length, chunk.length - offset);
          header = Buffer.concat([header, chunk.subarray(offset, offset + length)]);
          offset += length;
          if (header.length < 8) continue;
          type = header.readUInt32BE(0);
          remaining = header.readUInt32BE(4);
          if (remaining > 64 * 1024 * 1024) throw new Error("Harmony video packet exceeds limit");
          header = Buffer.alloc(0); prefix = Buffer.alloc(0);
          if (!remaining) continue;
        }
        const length = Math.min(remaining, chunk.length - offset);
        if (type === 2 && prefix.length < 13) {
          prefix = Buffer.concat([prefix, chunk.subarray(offset, offset + Math.min(length, 13 - prefix.length))]);
          if (prefix.length === 13) {
            onConfig(prefix.readUInt32BE(1), prefix.readUInt32BE(5));
            type = -1;
          }
        }
        remaining -= length; offset += length;
        if (remaining === 0 && type === 3) onFrame?.();
      }
      controller.enqueue(chunk);
    },
  });
}
