"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { HarmonyRequestError } from "@/lib/harmony/request-error";
import { consumeHarmonyVideoPackets } from "@/lib/harmony/media/browser-video-packets";

export type HarmonyFrameStatus = "idle" | "loading" | "live" | "error";
export type HarmonyFrameMode = "idle" | "video" | "frames";

export interface HarmonyLiveFrame {
  initialPreview?:boolean;
  geometryId?: string;
  serial: string;
  generation: number;
  revision: number;
  width: number;
  height: number;
}

interface UseHarmonyLiveFrameOptions {
  active: boolean;
  enabled: boolean;
  paused?: boolean;
  serial: string;
  generation?: number;
  fallbackError: string;
  chinese?: boolean;
  canvasRef: RefObject<HTMLCanvasElement | null>;
}

const VIDEO_CONFIG = 0x02;
const VIDEO_FRAME = 0x03;
const H264 = 0;
const RAW_RGBA = 1;
const JPEG = 2;
const STABLE_STREAM_FRAMES = 30;
const STABLE_STREAM_MS = 5_000;

type StreamConfig = {
  initialPreview?:boolean;
  changeDriven?: boolean;
  codec: number;
  width: number;
  height: number;
  fps: number;
  sps: Uint8Array;
  pps: Uint8Array;
};

type StreamAttempt = {
  geometryTimer?: number;
  geometryConfig?: StreamConfig;
  geometryRefreshing?: boolean;
  geometryId?: string;
  controller: AbortController;
  watchdog?: number;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
  failure?: Error;
  startedAt: number;
  decodedFrames: number;
  jpegChain: Promise<void>;
};

async function responseError(response: Response, chinese: boolean): Promise<string> {
  return (await responseFailure(response)).messageFor(chinese);
}

async function responseFailure(response: Response): Promise<HarmonyRequestError> {
  const payload = await response.json().catch(() => ({})) as { error?: unknown };
  return new HarmonyRequestError(payload.error, response.status);
}

function startCodedUnit(unit: Uint8Array): Uint8Array {
  if ((unit[0] === 0 && unit[1] === 0 && unit[2] === 1)
    || (unit[0] === 0 && unit[1] === 0 && unit[2] === 0 && unit[3] === 1)) return unit;
  const result = new Uint8Array(unit.length + 4);
  result.set([0, 0, 0, 1]);
  result.set(unit, 4);
  return result;
}

function h264Codec(sps: Uint8Array): string {
  const unit = startCodedUnit(sps);
  const offset = unit[2] === 1 ? 3 : 4;
  const profile = unit[offset + 1] ?? 0x42;
  const compatibility = unit[offset + 2] ?? 0xe0;
  const level = unit[offset + 3] ?? 0x1f;
  return `avc1.${[profile, compatibility, level].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function keyframeData(config: StreamConfig, frame: Uint8Array): Uint8Array {
  const sps = startCodedUnit(config.sps);
  const pps = startCodedUnit(config.pps);
  const nal = startCodedUnit(frame);
  const result = new Uint8Array(sps.length + pps.length + nal.length);
  result.set(sps, 0);
  result.set(pps, sps.length);
  result.set(nal, sps.length + pps.length);
  return result;
}

function parseConfig(payload: Uint8Array): StreamConfig {
  if (payload.length < 13) throw new Error("Harmony video configuration is truncated");
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const config: StreamConfig = {
    codec: view.getUint8(0),
    width: view.getUint32(1, false),
    height: view.getUint32(5, false),
    fps: view.getUint32(9, false),
    sps: new Uint8Array(),
    pps: new Uint8Array(),
  };
  if (config.width < 1 || config.height < 1 || config.width > 16_384 || config.height > 16_384) {
    throw new Error("Harmony video dimensions are invalid");
  }
  if (config.codec !== H264) {config.initialPreview=config.codec===JPEG&&payload[13]===2;return config;}
  if (payload.length < 17) throw new Error("Harmony H.264 configuration is truncated");
  let offset = 13;
  const spsLength = view.getUint16(offset, false);
  offset += 2;
  if (offset + spsLength + 2 > payload.length) throw new Error("Harmony H.264 SPS is truncated");
  config.sps = payload.slice(offset, offset + spsLength);
  offset += spsLength;
  const ppsLength = view.getUint16(offset, false);
  offset += 2;
  if (offset + ppsLength > payload.length) throw new Error("Harmony H.264 PPS is truncated");
  config.pps = payload.slice(offset, offset + ppsLength);
  config.changeDriven = payload[offset + ppsLength] === 1;
  return config;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolveDelay) => {
    const timer = window.setTimeout(done, milliseconds);
    const abort = () => done();
    function done() {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolveDelay();
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function waitForDecoderCapacity(decoder: VideoDecoder, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted || decoder.state !== "configured") return false;
  if (decoder.decodeQueueSize <= 8) return true;
  return new Promise((resolveCapacity) => {
    let settled = false;
    const finish = (available: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      decoder.removeEventListener("dequeue", check);
      signal.removeEventListener("abort", abort);
      resolveCapacity(available);
    };
    const check = () => {
      if (signal.aborted || decoder.state !== "configured") finish(false);
      else if (decoder.decodeQueueSize <= 4) finish(true);
    };
    const abort = () => finish(false);
    // Apply bounded backpressure before abandoning a dependent frame group.
    // Most short decoder bursts drain without waiting for another keyframe.
    const timer = window.setTimeout(() => finish(!signal.aborted && decoder.state === "configured" && decoder.decodeQueueSize <= 8), 1_000);
    decoder.addEventListener("dequeue", check);
    signal.addEventListener("abort", abort, { once: true });
    check();
  });
}

function reconnectDelay(failures: number): number {
  return Math.min(8_000, 250 * (2 ** Math.min(Math.max(0, failures - 1), 5)));
}

export function useHarmonyLiveFrame(options: UseHarmonyLiveFrameOptions) {
  const [visibilityEpoch, setVisibilityEpoch] = useState(0);
  const previewLifecycle = useRef<AbortController | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [status, setStatus] = useState<HarmonyFrameStatus>("idle");
  const [mode, setMode] = useState<HarmonyFrameMode>("idle");
  const [error, setError] = useState<string | null>(null);
  const [frame, setFrame] = useState<HarmonyLiveFrame | null>(null);
  const [fallbackReason, setFallbackReason] = useState<string | null>(null);
  const [videoBlocked, setVideoBlocked] = useState(false);
  const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);

  useEffect(() => {
    const update = () => {
      if (document.hidden) previewLifecycle.current?.abort();
      // A revision also handles a hide/show pair batched into one React render.
      setVisibilityEpoch(epoch => epoch + 1);
    };
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    if (!options.active || !options.enabled || !options.serial || options.generation === undefined) {
      setFrame(null);
      setStatus("idle");
      setMode("idle");
      setError(null);
      setFallbackReason(null);
      setVideoBlocked(false);
      return;
    }
    if (options.paused || document.hidden) {
      setFrame(current => current?.geometryId ? { ...current, geometryId: undefined } : current);
      setStatus("idle");
      return;
    }

    const lifecycle = new AbortController();
    previewLifecycle.current = lifecycle;
    let disposed = false;
    let decoder: VideoDecoder | undefined;
    let decoderEpoch = 0;
    let config: StreamConfig | undefined;
    let revision = 0;
    let firstKeyframe = false;
    let failures = 0;
    let hasFrame = false;
    let activeAttempt: StreamAttempt | undefined;
    let drawingCanvas: HTMLCanvasElement | null = null;
    let drawingContext: CanvasRenderingContext2D | null = null;
    const contextFor = (canvas: HTMLCanvasElement) => {
      if (drawingCanvas !== canvas) {
        drawingCanvas = canvas;
        drawingContext = canvas.getContext("2d", { alpha: false });
      }
      return drawingContext;
    };
    const closeDecoder = () => {
      // A stream can change configuration without replacing its connection.
      // Invalidate callbacks before close, which may itself deliver an error.
      decoderEpoch += 1;
      // WebCodecs closes itself after a fatal decode error.
      if (decoder && decoder.state !== "closed") decoder.close();
      decoder = undefined;
    };
    const armWatchdog = (attempt: StreamAttempt,timeoutMs=15000) => {
      window.clearTimeout(attempt.watchdog);
      // This native source emits only when pixels change. Once a real frame
      // has decoded, silence alone is not evidence of a broken connection.
      // EOF, transport errors and device/geometry checks still detect loss.
      if (config?.changeDriven && attempt.decodedFrames > 0) return;
      attempt.watchdog = window.setTimeout(() => {
        if (disposed || activeAttempt !== attempt) return;
        attempt.failure = new Error("Harmony video stopped producing frames");
        attempt.controller.abort();
        void attempt.reader?.cancel(attempt.failure).catch(() => undefined);
      }, timeoutMs);
    };
    setFrame(null);
    setStatus("loading");
    setMode("video");
    setError(null);
    setFallbackReason(null);
    setVideoBlocked(false);
    const initialCanvas = options.canvasRef.current;
    if (initialCanvas) contextFor(initialCanvas)?.clearRect(0, 0, initialCanvas.width, initialCanvas.height);

    const refreshGeometry = async (attempt: StreamAttempt, expected: StreamConfig) => {
      const isCurrent = () => !disposed && !attempt.controller.signal.aborted && activeAttempt === attempt && attempt.geometryConfig === expected;
      if (!isCurrent() || attempt.geometryRefreshing) return;
      attempt.geometryRefreshing = true;
      let geometryId: string | undefined;
      try {
        const response = await fetch(`/api/harmony/geometry?serial=${encodeURIComponent(options.serial)}&space=video`, { cache: "no-store", signal: attempt.controller.signal });
        if (response.ok) {
          const { geometry } = await response.json();
          if (geometry?.frameWidth === expected.width && geometry?.frameHeight === expected.height && typeof geometry.geometryId === "string") geometryId = geometry.geometryId;
        }
      } catch { /* A later automatic probe can recover without reconnecting. */ }
      if (!isCurrent()) return;
      attempt.geometryId = geometryId;
      attempt.geometryRefreshing = false;
      // A static phone may not send another frame after the asynchronous probe.
      // Publish readiness (and failures) immediately, without waiting for pixels.
      setFrame(current => current && current.width === expected.width && current.height === expected.height
        && current.geometryId !== geometryId ? { ...current, geometryId } : current);
      attempt.geometryTimer = window.setTimeout(() => {
        attempt.geometryTimer = undefined;
        void refreshGeometry(attempt, expected);
      }, expected.changeDriven ? 5000 : 1500);
    };

    const publishFrame = (width: number, height: number, attempt: StreamAttempt) => {
      if (disposed || activeAttempt !== attempt || attempt.controller.signal.aborted) return;
      if (attempt.geometryConfig && !attempt.geometryRefreshing && attempt.geometryTimer === undefined) void refreshGeometry(attempt, attempt.geometryConfig);
      revision += 1;
      attempt.decodedFrames += 1;
      armWatchdog(attempt);
      if (attempt.decodedFrames >= STABLE_STREAM_FRAMES || performance.now() - attempt.startedAt >= STABLE_STREAM_MS) {
        failures = 0;
      }
      const nextFrame = { serial: options.serial, generation: options.generation!, revision, width, height, geometryId: attempt.geometryId,initialPreview:config?.initialPreview===true };
      if (!hasFrame) {
        hasFrame = true;
        setFrame(nextFrame);
      } else {
        setFrame((current) => current && current.width === width && current.height === height && current.geometryId === nextFrame.geometryId&&current.initialPreview===nextFrame.initialPreview ? current : nextFrame);
      }
      setStatus("live");
      setError(null);
      setFallbackReason(config?.initialPreview?(options.chinese?'视频通道已连接，先显示当前预览；画面变化后切入实时视频。':'Video connected; showing initial preview until the screen changes.'):null);
      setVideoBlocked(false);
    };

    const drawVideoFrame = (videoFrame: VideoFrame, attempt: StreamAttempt) => {
      try {
        const canvas = options.canvasRef.current;
        if (!canvas || disposed || activeAttempt !== attempt || attempt.controller.signal.aborted) return;
        const width = videoFrame.displayWidth || videoFrame.codedWidth;
        const height = videoFrame.displayHeight || videoFrame.codedHeight;
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }
        contextFor(canvas)?.drawImage(videoFrame, 0, 0, width, height);
        publishFrame(width, height, attempt);
      } finally {
        videoFrame.close();
      }
    };

    const configureDecoder = async (next: StreamConfig, attempt: StreamAttempt) => {
      closeDecoder();
      const configuredEpoch = decoderEpoch;
      firstKeyframe = false;
      if (next.codec !== H264) return;
      if (!("VideoDecoder" in window)) throw new Error("This Piora runtime does not support hardware video decoding");
      const decoderConfig: VideoDecoderConfig = {
        codec: h264Codec(next.sps),
        codedWidth: next.width,
        codedHeight: next.height,
        optimizeForLatency: true,
        hardwareAcceleration: "prefer-hardware",
      };
      const support = await VideoDecoder.isConfigSupported(decoderConfig);
      if (disposed || activeAttempt !== attempt || attempt.controller.signal.aborted || decoderEpoch !== configuredEpoch) return;
      if (!support.supported) throw new Error(`H.264 decoder ${decoderConfig.codec} is unavailable`);
      decoder = new VideoDecoder({
        output: (videoFrame) => {
          if (decoderEpoch !== configuredEpoch) {
            videoFrame.close();
            return;
          }
          drawVideoFrame(videoFrame, attempt);
        },
        error: (decodeError) => {
          if (disposed || activeAttempt !== attempt || attempt.controller.signal.aborted || decoderEpoch !== configuredEpoch) return;
          const failure = new Error(decodeError.message || options.fallbackError);
          attempt.failure = failure;
          void attempt.reader?.cancel(failure).catch(() => undefined);
        },
      });
      decoder.configure(support.config ?? decoderConfig);
    };

    const drawJpeg = async (bytes: Uint8Array, next: StreamConfig, attempt: StreamAttempt) => {
      const bitmap = await createImageBitmap(new Blob([bytes.slice().buffer as ArrayBuffer], { type: "image/jpeg" }));
      try {
        const canvas = options.canvasRef.current;
        if (!canvas || disposed || activeAttempt !== attempt || attempt.controller.signal.aborted) return;
        if (canvas.width !== next.width || canvas.height !== next.height) {
          canvas.width = next.width;
          canvas.height = next.height;
        }
        contextFor(canvas)?.drawImage(bitmap, 0, 0, next.width, next.height);
        publishFrame(next.width, next.height, attempt);
      } finally {
        bitmap.close();
      }
    };

    const drawRgba = (bytes: Uint8Array, next: StreamConfig, attempt: StreamAttempt) => {
      if (bytes.length < 8) throw new Error("Harmony RGBA frame is truncated");
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const width = view.getUint32(0, false);
      const height = view.getUint32(4, false);
      if (width !== next.width || height !== next.height || bytes.length !== 8 + width * height * 4) {
        throw new Error("Harmony RGBA frame dimensions are invalid");
      }
      const canvas = options.canvasRef.current;
      if (!canvas || disposed || activeAttempt !== attempt) return;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const pixels = new Uint8ClampedArray(bytes.slice(8).buffer as ArrayBuffer);
      contextFor(canvas)?.putImageData(new ImageData(pixels, width, height), 0, 0);
      publishFrame(width, height, attempt);
    };

    const processPacket = async (type: number, payload: Uint8Array, attempt: StreamAttempt) => {
      if (type === VIDEO_CONFIG) {
        config = parseConfig(payload);
        setMode(config.initialPreview?'frames':'video');
        window.clearTimeout(attempt.geometryTimer);
        attempt.geometryTimer = undefined;
        attempt.geometryConfig = config;
        attempt.geometryRefreshing = false;
        attempt.geometryId = undefined;
        setFrame(previous => previous ? { ...previous, geometryId: undefined } : previous);
        await configureDecoder(config, attempt);
        return;
      }
      if (type !== VIDEO_FRAME || !config || payload.length < 9) return;
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      const keyframe = (view.getUint8(0) & 1) !== 0;
      const timestamp = Number(view.getBigUint64(1, false));
      const data = payload.subarray(9);
      if (config.codec === H264) {
        if (!decoder || decoder.state !== "configured") return;
        if (!firstKeyframe && !keyframe) return;
        if (decoder.decodeQueueSize > 8) {
          const pendingDecoder = decoder;
          const available = await waitForDecoderCapacity(pendingDecoder, attempt.controller.signal);
          if (disposed || activeAttempt !== attempt || attempt.controller.signal.aborted || decoder !== pendingDecoder || decoder.state !== "configured") return;
          if (!available) {
            // Waiting for another keyframe on this connection can deadlock when
            // the producer only has dependent deltas left. Reconnect so the
            // bundled stream opens a fresh capture and requests a new IDR.
            const failure = new Error("Harmony video decoder remained overloaded");
            attempt.failure = failure;
            attempt.controller.abort();
            throw failure;
          }
        }
        const chunkData = keyframe ? keyframeData(config, data) : startCodedUnit(data);
        decoder.decode(new EncodedVideoChunk({ type: keyframe ? "key" : "delta", timestamp, data: chunkData }));
        if (keyframe) firstKeyframe = true;
      } else if (config.codec === JPEG) {
        attempt.jpegChain = attempt.jpegChain.then(() => drawJpeg(data, config!, attempt));
        await attempt.jpegChain;
      } else if (config.codec === RAW_RGBA) {
        drawRgba(data, config, attempt);
      } else {
        throw new Error(`Unsupported Harmony video codec ${config.codec}`);
      }
    };

    const consume = async (body: ReadableStream<Uint8Array>, attempt: StreamAttempt) => {
      const reader = body.getReader();
      attempt.reader = reader;
      try {
        await consumeHarmonyVideoPackets(reader, (type, payload) => processPacket(type, payload, attempt), { signal: attempt.controller.signal });
        throw attempt.failure ?? new Error("Harmony video connection closed");
      } finally {
        await reader.cancel().catch(() => undefined);
        if (attempt.reader === reader) attempt.reader = undefined;
        reader.releaseLock();
      }
    };

    const pollFrames = async (durationMs=Infinity, intervalMs=120) => {
      const until=performance.now()+durationMs;
      let fallbackGeometry: { width: number; height: number; geometryId: string } | undefined;
      let fallbackGeometryCheckedAt = 0;
      let fallbackFailures = 0;
      setMode("frames");
      closeDecoder();
      config = undefined;
      firstKeyframe = false;
      while (!lifecycle.signal.aborted&&performance.now()<until) {
        if (document.hidden) {
          await delay(1_000, lifecycle.signal);
          continue;
        }
        try {
          const response = await fetch(`/api/harmony/frame?serial=${encodeURIComponent(options.serial)}&v=${Date.now()}`, {
            cache: "no-store",
            signal: lifecycle.signal,
          });
          if (!response.ok) throw new Error(await responseError(response, Boolean(options.chinese)));
          const generation = Number(response.headers.get("X-Harmony-Generation"));
          const frameRevision = Number(response.headers.get("X-Harmony-Revision"));
          if (!Number.isSafeInteger(generation) || !Number.isSafeInteger(frameRevision)) {
            throw new Error("Device frame metadata is invalid");
          }
          const bitmap = await createImageBitmap(await response.blob());
          try {
            const canvas = options.canvasRef.current;
            if (!canvas || disposed) return;
            if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
              canvas.width = bitmap.width;
              canvas.height = bitmap.height;
            }
            contextFor(canvas)?.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height);
            hasFrame = true;
            if (fallbackGeometry?.width !== bitmap.width || fallbackGeometry?.height !== bitmap.height || performance.now() - fallbackGeometryCheckedAt > 1500) {
              // Keep verified geometry during a same-size refresh so polling cannot cancel an in-progress mouse gesture.
              if (fallbackGeometry?.width !== bitmap.width || fallbackGeometry?.height !== bitmap.height) fallbackGeometry = undefined;
              fallbackGeometryCheckedAt = performance.now();
              setFrame({ geometryId: fallbackGeometry?.geometryId, serial: options.serial, generation, revision: frameRevision, width: bitmap.width, height: bitmap.height });
              setStatus("live");
              setError(null);
              const response = await fetch(`/api/harmony/geometry?serial=${encodeURIComponent(options.serial)}&space=screenshot`, { cache: "no-store", signal: lifecycle.signal }).catch(() => null);
              fallbackGeometry = undefined;
              if (response?.ok) {
                const { geometry } = await response.json();
                if (geometry?.frameWidth === bitmap.width && geometry?.frameHeight === bitmap.height) {
                  fallbackGeometry = { width: bitmap.width, height: bitmap.height, geometryId: geometry.geometryId };
                }
              }
            }
            if (disposed || lifecycle.signal.aborted) return;
            setFrame({
              geometryId: fallbackGeometry?.geometryId,
              serial: options.serial,
              generation,
              revision: frameRevision,
              width: bitmap.width,
              height: bitmap.height,
            });
            setStatus("live");
            setError(null);
            fallbackFailures = 0;
          } finally {
            bitmap.close();
          }
          await delay(intervalMs, lifecycle.signal);
        } catch (frameError) {
          if (lifecycle.signal.aborted || disposed) return;
          fallbackFailures += 1;
          // Agent device actions intentionally interrupt an in-flight passive
          // screenshot. Keep the last frame visible and retry instead of
          // presenting the device as unavailable while the Agent is working.
          if (!hasFrame) {
            setStatus("error");
            setError(frameError instanceof Error ? frameError.message : options.fallbackError);
          } else {
            setStatus("error");
            setFrame(previous => previous ? { ...previous, geometryId: undefined } : previous);
            fallbackGeometry = undefined;
            setError(frameError instanceof Error ? frameError.message : options.fallbackError);
          }
          await delay(Math.min(4_000, 250 * (2 ** Math.min(fallbackFailures - 1, 4))), lifecycle.signal);
        }
      }
    };

    const connect = async () => {
      while (!lifecycle.signal.aborted) {
        const attempt: StreamAttempt = {
          controller: new AbortController(),
          startedAt: performance.now(),
          decodedFrames: 0,
          jpegChain: Promise.resolve(),
        };
        activeAttempt = attempt;
        const abortAttempt = () => attempt.controller.abort();
        lifecycle.signal.addEventListener("abort", abortAttempt, { once: true });
        // Preparing the reusable driver and native channel has its own bounded
        // startup budget. Do not cancel it using the decoder's frame budget.
        armWatchdog(attempt,45000);
        if (!hasFrame) setStatus("loading");
        try {
          const response = await fetch(`/api/harmony/video?serial=${encodeURIComponent(options.serial)}`, {
            cache: "no-store",
            headers: { Accept: "application/vnd.piora.harmony-stream" },
            signal: attempt.controller.signal,
          });
          if (disposed || lifecycle.signal.aborted || activeAttempt !== attempt || attempt.controller.signal.aborted) {
            await response.body?.cancel().catch(() => undefined);
            throw attempt.failure ?? new Error("Harmony video connection was cancelled");
          }
          if (!response.ok) throw await responseFailure(response);
          if (!response.body) throw new Error("Harmony video response has no stream body");
          // Establishing the connection and decoding its first frame each have
          // a bounded budget. Configuration packets cannot renew the latter;
          // only an actual displayed frame renews it after this transition.
          armWatchdog(attempt);
          await consume(response.body, attempt);
        } catch (streamError) {
          window.clearTimeout(attempt.watchdog);
          window.clearTimeout(attempt.geometryTimer);
          attempt.controller.abort();
          if (lifecycle.signal.aborted || disposed) return;
          failures += 1;
          setStatus("error");
          setFrame(previous => previous ? { ...previous, geometryId: undefined } : previous);
          const failure = attempt.failure ?? streamError;
          const blocked = failure instanceof HarmonyRequestError && failure.videoBlocked;
          const reason = failure instanceof HarmonyRequestError ? failure.messageFor(Boolean(options.chinese))
            : failure instanceof Error ? failure.message : options.fallbackError;
          setError(reason);
          setFallbackReason(reason);
          setVideoBlocked(blocked);
          closeDecoder();
          config = undefined;
          firstKeyframe = false;
          if (blocked || (!hasFrame && failures >= 1) || failures >= 3) {
            // The packaged low-latency video service is not available on every
            // device/decoder combination. Fall back to the existing bounded
            // screenshot endpoint so observation remains available while the
            // Agent holds the exclusive write lease.
            await attempt.jpegChain.catch(() => undefined);
            if (activeAttempt === attempt) activeAttempt = undefined;
            // An external encoder is a known contention state, not a decoder
            // failure. Keep a low-rate preview and probe release every 10s.
            await pollFrames(blocked ? 10_000 : Math.min(120000,30000*2**Math.min(Math.max(0,failures-1),2)), blocked ? 1500 : 120);
            if(lifecycle.signal.aborted||disposed)return;
            setMode('video');
            continue;
          }
          await attempt.jpegChain.catch(() => undefined);
          await delay(reconnectDelay(failures), lifecycle.signal);
        } finally {
          window.clearTimeout(attempt.watchdog);
          window.clearTimeout(attempt.geometryTimer);
          lifecycle.signal.removeEventListener("abort", abortAttempt);
          if (activeAttempt === attempt) activeAttempt = undefined;
        }
      }
    };

    void connect();
    return () => {
      disposed = true;
      lifecycle.abort();
      if (previewLifecycle.current === lifecycle) previewLifecycle.current = null;
      window.clearTimeout(activeAttempt?.watchdog);
      window.clearTimeout(activeAttempt?.geometryTimer);
      closeDecoder();
      void activeAttempt?.reader?.cancel().catch(() => undefined);
      void activeAttempt?.jpegChain.catch(() => undefined);
    };
  }, [options.active, options.canvasRef, options.chinese, options.enabled, options.fallbackError, options.generation, options.paused, options.serial, refreshKey, visibilityEpoch]);

  return { frame, status, mode, error, fallbackReason, videoBlocked, refresh };
}
