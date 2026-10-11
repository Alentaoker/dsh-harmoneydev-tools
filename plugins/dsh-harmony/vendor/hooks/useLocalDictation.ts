"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  encodePcm16Wav,
  MAX_VOICE_RECORDING_MS,
  resampleAudio,
} from "@/lib/voice-audio";

import { LiveDictation } from "@/lib/live-dictation";

export type LocalDictationPhase = "idle" | "starting" | "recording" | "transcribing";
export type LocalDictationError = "permission" | "microphone" | "no-speech" | "generic";

interface LocalDictationOptions {
  language: "zh" | "en";
  onTranscript: (text: string) => void;
}

interface AudioCapture {
  stream: MediaStream;
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  silentGain: GainNode;
  dictation: LiveDictation;
  sampleRate: number;
}

type AudioContextConstructor = new () => AudioContext;

function getAudioContextConstructor(): AudioContextConstructor | null {
  if (typeof window === "undefined") return null;
  const audioWindow = window as typeof window & { webkitAudioContext?: AudioContextConstructor };
  return window.AudioContext ?? audioWindow.webkitAudioContext ?? null;
}

function releaseCapture(capture: AudioCapture | null): void {
  if (!capture) return;
  capture.processor.onaudioprocess = null;
  try { capture.source.disconnect(); } catch { /* Already disconnected. */ }
  try { capture.processor.disconnect(); } catch { /* Already disconnected. */ }
  try { capture.silentGain.disconnect(); } catch { /* Already disconnected. */ }
  for (const track of capture.stream.getTracks()) track.stop();
  void capture.context.close().catch(() => {});
}

export function useLocalDictation({ language, onTranscript }: LocalDictationOptions) {
  const [available, setAvailable] = useState(false);
  const [phase, setPhase] = useState<LocalDictationPhase>("idle");
  const [error, setError] = useState<LocalDictationError | null>(null);
  const captureRef = useRef<AudioCapture | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const phaseRef = useRef<LocalDictationPhase>("idle");
  const mountedRef = useRef(true);
  const onTranscriptRef = useRef(onTranscript);
  const languageRef = useRef(language);
  const stopRef = useRef<() => Promise<boolean>>(async () => false);
  onTranscriptRef.current = onTranscript;
  languageRef.current = language;

  const setCurrentPhase = useCallback((next: LocalDictationPhase) => {
    phaseRef.current = next;
    if (mountedRef.current) setPhase(next);
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const cancel = useCallback(() => {
    clearTimer();
    requestRef.current?.abort();
    requestRef.current = null;
    const capture = captureRef.current;
    captureRef.current = null;
    capture?.dictation.cancel();
    releaseCapture(capture);
    setCurrentPhase("idle");
  }, [clearTimer, setCurrentPhase]);

  const stop = useCallback(async () => {
    const capture = captureRef.current;
    if (!capture) { if (phaseRef.current === "starting") cancel(); return false; }
    clearTimer();
    releaseCapture(capture);
    setCurrentPhase("transcribing");
    const controller = requestRef.current;
    try {
      const recognized = await capture.dictation.finish();
      if (requestRef.current === controller && !controller?.signal.aborted && mountedRef.current && !recognized) setError("no-speech");
      return requestRef.current === controller && !controller?.signal.aborted && recognized;
    } catch { return false; /* The live decoder already reports the failure. */ }
    finally {
      if (requestRef.current === controller) {
        captureRef.current = null;
        requestRef.current = null;
        setCurrentPhase("idle");
      }
    }
  }, [cancel, clearTimer, setCurrentPhase]);
  stopRef.current = stop;

  const start = useCallback(async () => {
    if (phaseRef.current !== "idle") return;
    const AudioContextClass = getAudioContextConstructor();
    if (!AudioContextClass || !navigator.mediaDevices?.getUserMedia) {
      setAvailable(false);
      return;
    }
    setError(null);
    setCurrentPhase("starting");
    const controller = new AbortController();
    requestRef.current = controller;
    const recordingLanguage = languageRef.current;
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      if (controller.signal.aborted || requestRef.current !== controller) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      context = new AudioContextClass();
      await context.resume();
      if (controller.signal.aborted || requestRef.current !== controller) { for (const track of stream.getTracks()) track.stop(); void context.close().catch(() => {}); return; }
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const silentGain = context.createGain();
      const dictation = new LiveDictation({
        sampleRate: context.sampleRate,
        language: recordingLanguage,
        transcribe: async samples => {
          const wav = encodePcm16Wav(resampleAudio(samples, context!.sampleRate));
          const timeout = new AbortController();
          const timer = setTimeout(() => timeout.abort(), 20_000);
          try {
            const response = await fetch(`/api/speech/transcribe?language=${recordingLanguage}`, {
              method: "POST", headers: { "content-type": "audio/wav" },
              body: new Uint8Array(wav).buffer,
              signal: AbortSignal.any([controller.signal, timeout.signal]),
            });
            const payload = await response.json() as { text?: unknown };
            if (!response.ok) throw new Error("Local transcription failed");
            return typeof payload.text === "string" ? payload.text : "";
          } finally { clearTimeout(timer); }
        },
        onText: text => {
          if (!controller.signal.aborted && requestRef.current === controller && mountedRef.current) {
            setError(null); onTranscriptRef.current(text);
          }
        },
        onError: () => {
          if (!controller.signal.aborted && requestRef.current === controller && mountedRef.current) {
            cancel(); setError("generic");
          }
        },
      });
      silentGain.gain.value = 0;
      processor.onaudioprocess = (event) => {
        dictation.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      };
      source.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(context.destination);
      captureRef.current = {
        stream,
        context,
        source,
        processor,
        silentGain,
        dictation,
        sampleRate: context.sampleRate,
      };
      setCurrentPhase("recording");
      timerRef.current = setTimeout(() => { void stopRef.current(); }, MAX_VOICE_RECORDING_MS);
    } catch (captureError) {
      for (const track of stream?.getTracks() ?? []) track.stop();
      if (context) void context.close().catch(() => {});
      if (controller.signal.aborted || requestRef.current !== controller || !mountedRef.current) return;
      requestRef.current = null;
      const name = captureError instanceof DOMException ? captureError.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") setError("permission");
      else if (name === "NotFoundError" || name === "NotReadableError") setError("microphone");
      else setError("generic");
      setCurrentPhase("idle");
    }
  }, [cancel, setCurrentPhase]);

  const toggle = useCallback(async () => {
    if (phaseRef.current === "recording" || phaseRef.current === "starting") await stop();
    else if (phaseRef.current === "idle") await start();
  }, [start, stop]);

  const clearError = useCallback(() => setError(null), []);

  const refreshAvailability = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/speech/transcribe", { cache: "no-store", signal });
    if (!response.ok) return;
    const payload = await response.json() as { available?: unknown };
    const nextAvailable = payload.available === true;
    setAvailable(nextAvailable);
    if (!nextAvailable && phaseRef.current !== "idle") cancel();
  }, [cancel]);

  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => { void refreshAvailability(controller.signal).catch(() => {}); };
    refresh();
    window.addEventListener("piora:speech-settings-changed", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      controller.abort();
      window.removeEventListener("piora:speech-settings-changed", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [refreshAvailability]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimer();
      requestRef.current?.abort();
      captureRef.current?.dictation.cancel();
      releaseCapture(captureRef.current);
      captureRef.current = null;
    };
  }, [clearTimer]);

  return {
    available,
    supported: typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia) && Boolean(getAudioContextConstructor()),
    phase,
    error,
    toggle,
    stop,
    cancel,
    clearError,
  };
}
