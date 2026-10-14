export const LOCAL_SPEECH_PACK_ID = "sensevoice-small-int8";

export type SpeechHardwareTier = "compact" | "balanced" | "performance";
export type SpeechInstallPhase = "idle" | "downloading" | "installing" | "complete" | "error";

export interface SpeechHardwareProfile {
  platform: string;
  arch: string;
  logicalCores: number;
  memoryGiB: number;
  threads: number;
  tier: SpeechHardwareTier;
  supported: boolean;
  runtimePackage: string | null;
}

export interface SpeechInstallState {
  phase: SpeechInstallPhase;
  downloadedBytes: number;
  totalBytes: number;
  currentFile?: string;
  error?: string;
  updatedAt: string;
}

export interface SpeechStatus {
  enabled: boolean;
  available: boolean;
  installed: boolean;
  bundled: boolean;
  engine: "sherpa-onnx";
  model: "SenseVoiceSmall INT8";
  packId: typeof LOCAL_SPEECH_PACK_ID;
  packVersion: string;
  packDirectory: string;
  packPath: string;
  approximateDownloadBytes: number;
  installedBytes: number | null;
  languages: string[];
  hardware: SpeechHardwareProfile;
  install: SpeechInstallState;
}
