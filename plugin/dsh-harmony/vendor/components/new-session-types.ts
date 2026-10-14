import type { AttachedFile } from "@/hooks/useAgentSession";
import type { AttachedImage } from "./ChatInput";
import type { SystemPromptSelection } from "@/lib/system-prompt-types";

export interface NewSessionInitialPrompt {
  id: string;
  message: string;
  images?: AttachedImage[];
  files?: AttachedFile[];
  systemPromptSelection?: SystemPromptSelection;
}

export interface NewSessionLaunch {
  cwd: string;
  projectRoot: string | null;
  model: { provider: string; modelId: string };
  prompt: NewSessionInitialPrompt;
}
