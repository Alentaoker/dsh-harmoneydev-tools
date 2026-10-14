/** Browser-side framing with one bounded partial packet and no growing concatenations. */
export const MAX_HARMONY_VIDEO_PACKET_BYTES = 8 * 1024 * 1024;
const HEADER_BYTES = 8;

type PacketReaderOptions = {
  signal?: AbortSignal;
  maxPacketBytes?: number;
  maxBufferedBytes?: number;
};

function aborted(): DOMException {
  return new DOMException("Harmony video connection was cancelled", "AbortError");
}

/**
 * Complete payloads already present in a network chunk remain views of that chunk.
 * A payload crossing chunks gets one allocation, filled directly as bytes arrive.
 * Callbacks are awaited before reading more data, preserving decoder backpressure.
 * The caller owns releaseLock; cancellation here only unblocks an outstanding read.
 */
export async function consumeHarmonyVideoPackets(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onPacket: (type: number, payload: Uint8Array) => void | Promise<void>,
  options: PacketReaderOptions = {},
): Promise<void> {
  const maxPacketBytes = options.maxPacketBytes ?? MAX_HARMONY_VIDEO_PACKET_BYTES;
  const maxBufferedBytes = options.maxBufferedBytes ?? maxPacketBytes + HEADER_BYTES;
  if (!Number.isSafeInteger(maxPacketBytes) || maxPacketBytes < 0
    || !Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < HEADER_BYTES) {
    throw new RangeError("Invalid Harmony video buffer limits");
  }
  const { signal } = options;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", cancel, { once: true });
  const header = new Uint8Array(HEADER_BYTES);
  const headerView = new DataView(header.buffer);
  let headerLength = 0;
  let type = 0;
  let payloadLength = 0;
  let payloadWritten = 0;
  let partial: Uint8Array | undefined;
  const reset = () => {
    headerLength = 0;
    payloadLength = 0;
    payloadWritten = 0;
    partial = undefined;
  };
  try {
    if (signal?.aborted) { cancel(); throw aborted(); }
    while (true) {
      if (signal?.aborted) throw aborted();
      const { done, value } = await reader.read();
      if (signal?.aborted) throw aborted();
      if (done) {
        if (headerLength || payloadWritten) throw new Error("Harmony video packet is truncated");
        return;
      }
      if (!value?.length) continue;
      if (headerLength + payloadWritten + value.length > maxBufferedBytes) {
        throw new Error("Harmony video stream exceeded its buffer limit");
      }
      let offset = 0;
      while (offset < value.length) {
        if (signal?.aborted) throw aborted();
        if (headerLength < HEADER_BYTES) {
          const count = Math.min(HEADER_BYTES - headerLength, value.length - offset);
          header.set(value.subarray(offset, offset + count), headerLength);
          headerLength += count;
          offset += count;
          if (headerLength < HEADER_BYTES) continue;
          type = headerView.getUint32(0, false);
          payloadLength = headerView.getUint32(4, false);
          if (payloadLength > maxPacketBytes) throw new Error("Harmony video packet is too large");
          if (payloadLength + HEADER_BYTES > maxBufferedBytes) {
            throw new Error("Harmony video stream exceeded its buffer limit");
          }
          if (payloadLength === 0) {
            await onPacket(type, value.subarray(offset, offset));
            reset();
            continue;
          }
        }
        if (offset === value.length) continue;
        if (!partial && value.length - offset >= payloadLength) {
          const payload = value.subarray(offset, offset + payloadLength);
          offset += payloadLength;
          await onPacket(type, payload);
          reset();
          continue;
        }
        // Do not allocate until the payload actually needs to span network chunks.
        partial ??= new Uint8Array(payloadLength);
        const count = Math.min(payloadLength - payloadWritten, value.length - offset);
        partial.set(value.subarray(offset, offset + count), payloadWritten);
        payloadWritten += count;
        offset += count;
        if (payloadWritten === payloadLength) {
          await onPacket(type, partial);
          reset();
        }
      }
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}
