export const USER_INPUT_MAX_QUESTIONS = 3;
export const USER_INPUT_MAX_OPTIONS = 6;
export const USER_INPUT_MAX_TEXT_LENGTH = 8_000;
export const USER_INPUT_DEFAULT_TIMEOUT_MS = 60_000;
export const USER_INPUT_MIN_TIMEOUT_MS = 30_000;
export const USER_INPUT_MAX_TIMEOUT_MS = 300_000;

/** A question must always have a finite deadline, including older extensions. */
export function userInputTimeoutMs(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return USER_INPUT_DEFAULT_TIMEOUT_MS;
  return Math.min(USER_INPUT_MAX_TIMEOUT_MS, Math.max(USER_INPUT_MIN_TIMEOUT_MS, Math.round(value)));
}

export type UserInputQuestionKind = "single_select" | "multi_select" | "text";

export interface UserInputOption {
  label: string;
  description?: string;
}

export interface UserInputQuestion {
  id: string;
  header?: string;
  question: string;
  kind: UserInputQuestionKind;
  options?: UserInputOption[];
  placeholder?: string;
  multiline?: boolean;
  required: boolean;
}

export type UserInputAnswers = Record<string, string[]>;

export type UserInputResult =
  | { answers: UserInputAnswers }
  | { cancelled: true; reason?: "timeout" };

type RawQuestion = Omit<UserInputQuestion, "required"> & { required?: boolean };

function boundedText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
  const text = value.trim();
  if (text.length > maxLength) throw new Error(`${field} must be ${maxLength} characters or fewer.`);
  return text;
}

export function normalizeUserInputQuestions(input: readonly RawQuestion[]): UserInputQuestion[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > USER_INPUT_MAX_QUESTIONS) {
    throw new Error(`questions must contain between 1 and ${USER_INPUT_MAX_QUESTIONS} items.`);
  }
  const ids = new Set<string>();
  return input.map((candidate, index) => {
    const id = boundedText(candidate?.id, `questions[${index}].id`, 64);
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id)) throw new Error(`questions[${index}].id must be a stable identifier.`);
    if (ids.has(id)) throw new Error(`Duplicate question id: ${id}.`);
    ids.add(id);
    const kind = candidate?.kind;
    if (kind !== "single_select" && kind !== "multi_select" && kind !== "text") {
      throw new Error(`questions[${index}].kind is invalid.`);
    }
    const question: UserInputQuestion = {
      id,
      question: boundedText(candidate.question, `questions[${index}].question`, 500),
      kind,
      required: candidate.required !== false,
    };
    if (candidate.header?.trim()) question.header = boundedText(candidate.header, `questions[${index}].header`, 40);
    if (candidate.placeholder?.trim()) question.placeholder = boundedText(candidate.placeholder, `questions[${index}].placeholder`, 240);
    if (kind === "text") {
      question.multiline = candidate.multiline === true;
      return question;
    }
    const rawOptions = candidate.options;
    if (!Array.isArray(rawOptions) || rawOptions.length < 2 || rawOptions.length > USER_INPUT_MAX_OPTIONS) {
      throw new Error(`${kind} questions require between 2 and ${USER_INPUT_MAX_OPTIONS} options.`);
    }
    const labels = new Set<string>();
    question.options = rawOptions.map((option, optionIndex) => {
      const label = boundedText(option?.label, `questions[${index}].options[${optionIndex}].label`, 100);
      if (labels.has(label)) throw new Error(`Duplicate option label in ${id}: ${label}.`);
      labels.add(label);
      return {
        label,
        ...(option.description?.trim()
          ? { description: boundedText(option.description, `questions[${index}].options[${optionIndex}].description`, 300) }
          : {}),
      };
    });
    return question;
  });
}

export function normalizeUserInputAnswers(
  questions: readonly UserInputQuestion[],
  input: unknown,
): UserInputAnswers {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("User answers are invalid.");
  const source = input as Record<string, unknown>;
  const answers: UserInputAnswers = {};
  for (const question of questions) {
    const rawValues = source[question.id];
    const values = Array.isArray(rawValues)
      ? rawValues.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean)
      : [];
    if (question.required && values.length === 0) throw new Error(`A response is required for ${question.id}.`);
    if (question.kind === "text") {
      if (values.length > 1 || (values[0]?.length ?? 0) > USER_INPUT_MAX_TEXT_LENGTH) throw new Error(`Text response for ${question.id} is invalid.`);
    } else {
      // Option buttons submit predefined labels; any other value is the card's
      // "Other" free-text answer, so only the length bound applies here.
      if (values.some((value) => value.length > USER_INPUT_MAX_TEXT_LENGTH)) throw new Error(`Selection for ${question.id} is invalid.`);
      if (question.kind === "single_select" && values.length > 1) throw new Error(`${question.id} accepts only one selection.`);
      if (new Set(values).size !== values.length) throw new Error(`Selection for ${question.id} contains duplicates.`);
    }
    answers[question.id] = values;
  }
  return answers;
}
