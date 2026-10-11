export interface SystemPromptTemplate {
  id: string;
  name: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
}

export type SystemPromptSelection =
  | { mode: "default" }
  | { mode: "template"; templateId: string };

export interface SessionSystemPromptBinding {
  version: 1;
  revision: number;
  source: SystemPromptSelection["mode"];
  templateId: string | null;
  templateName: string | null;
  prompt: string | null;
  appliedAt: string;
}

export interface SystemPromptCatalog {
  templates: SystemPromptTemplate[];
  defaultTemplateId: string | null;
  selectorVisible: boolean;
  maxPromptLength: number;
  maxNameLength: number;
}
