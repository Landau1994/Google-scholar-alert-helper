// Centralized Gemini model configuration with env overrides and deprecation fallback helpers.

export const DEFAULT_GEMINI_FLASH_MODEL = 'gemini-3.8-flash';
export const DEFAULT_GEMINI_TEXT_FALLBACKS = [
  'gemini-flash-latest',
  'gemini-2.5-flash',
] as const;
export const DEFAULT_GEMINI_EMBEDDING_MODEL = 'gemini-embedding-2';

const readEnv = (key: string): string | undefined => {
  if (typeof process !== 'undefined' && process.env && process.env[key]) {
    return process.env[key];
  }
  try {
    const metaEnv = (import.meta as any)?.env;
    if (metaEnv && metaEnv[key]) {
      return metaEnv[key];
    }
  } catch {
    // Ignore when import.meta.env is unavailable
  }
  return undefined;
};

const parseModelList = (raw: string | undefined, defaults: readonly string[]): string[] => {
  if (!raw || !raw.trim()) return [...defaults];
  return raw
    .split(',')
    .map(m => m.trim())
    .filter(Boolean);
};

export const GEMINI_FLASH_MODEL =
  readEnv('VITE_GEMINI_FLASH_MODEL')?.trim() || DEFAULT_GEMINI_FLASH_MODEL;

export const GEMINI_TEXT_FALLBACK_MODELS: string[] = Array.from(
  new Set([
    GEMINI_FLASH_MODEL,
    ...parseModelList(readEnv('VITE_GEMINI_FALLBACK_MODELS'), DEFAULT_GEMINI_TEXT_FALLBACKS),
  ])
);

export const GEMINI_EMBEDDING_MODEL =
  readEnv('VITE_GEMINI_EMBEDDING_MODEL')?.trim() || DEFAULT_GEMINI_EMBEDDING_MODEL;

/**
 * Strip leading "models/" prefix returned by Google's ListModels API.
 */
export function normalizeModelName(name: string): string {
  return String(name || '').trim().replace(/^models\//, '');
}

/**
 * Detect whether a Gemini API error indicates the target model was deprecated,
 * removed, renamed, or is unsupported (HTTP 404 / 410 / NOT_FOUND).
 */
export function isModelUnavailableError(error: any): boolean {
  const status = error?.status ?? error?.statusCode ?? error?.code;
  const msg = String(error?.message || error || '').toLowerCase();

  // Never misclassify rate-limit, auth, or network timeouts as model deprecation
  if (
    status === 429 ||
    status === 401 ||
    status === 403 ||
    msg.includes('rate limit') ||
    msg.includes('quota') ||
    msg.includes('api key')
  ) {
    return false;
  }

  if (status === 404 || status === 410) {
    return true;
  }

  return (
    msg.includes('not_found') ||
    msg.includes('is not found for api version') ||
    msg.includes('model not found') ||
    msg.includes('models/') && msg.includes('not found') ||
    msg.includes('is no longer available') ||
    msg.includes('has been deprecated') ||
    msg.includes('model is deprecated') ||
    msg.includes('model has been retired') ||
    msg.includes('is not supported for generatecontent') ||
    msg.includes('is not supported for embedcontent')
  );
}

export interface ListedModelInfo {
  name?: string;
  supportedActions?: string[];
  supportedGenerationMethods?: string[];
}

const supportsAction = (model: ListedModelInfo, action: string): boolean => {
  const actions = model.supportedActions || model.supportedGenerationMethods;
  if (!actions || actions.length === 0) return true; // If API omits field, rely on name heuristics
  const target = action.toLowerCase();
  return actions.some(a => a.toLowerCase().includes(target));
};

const parseGeminiVersionScore = (id: string): number => {
  const match = id.match(/gemini-(\d+)(?:\.(\d+))?/);
  if (!match) return 0;
  const major = parseInt(match[1], 10) || 0;
  const minor = parseInt(match[2] || '0', 10) || 0;
  return major * 100 + minor;
};

/**
 * Choose the best general-purpose Gemini Flash text model from a ListModels response.
 * Excludes specialized/non-text variants (tts, image, audio, live, embedding, exp) and any failed models.
 */
export function pickBestFlashModelFromList(
  models: ListedModelInfo[],
  exclude: Set<string> = new Set()
): string | null {
  const excludedNormalized = new Set(Array.from(exclude).map(normalizeModelName));
  const disallowedPattern = /(tts|image|audio|live|video|veo|imagen|embedding|aqa|robotics|computer-use|exp|001$)/i;

  const candidates = models
    .filter(m => m.name && supportsAction(m, 'generateContent'))
    .map(m => normalizeModelName(m.name!))
    .filter(id => id.includes('gemini') && id.includes('flash'))
    .filter(id => !disallowedPattern.test(id))
    .filter(id => !excludedNormalized.has(id));

  if (candidates.length === 0) return null;

  const scoreCandidate = (id: string): number => {
    let score = parseGeminiVersionScore(id) * 10;
    if (id === 'gemini-flash-latest') score += 5000;
    if (!id.includes('preview')) score += 50;
    if (!id.includes('lite')) score += 20;
    if (/^gemini-\d+(?:\.\d+)?-flash$/.test(id)) score += 30;
    return score;
  };

  candidates.sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
  return candidates[0];
}

/**
 * Choose the best available Gemini embedding model from a ListModels response.
 */
export function pickBestEmbeddingModelFromList(
  models: ListedModelInfo[],
  exclude: Set<string> = new Set()
): string | null {
  const excludedNormalized = new Set(Array.from(exclude).map(normalizeModelName));

  const candidates = models
    .filter(m => m.name && supportsAction(m, 'embedContent'))
    .map(m => normalizeModelName(m.name!))
    .filter(id => id.includes('embedding'))
    .filter(id => !excludedNormalized.has(id));

  if (candidates.length === 0) return null;

  const scoreCandidate = (id: string): number => {
    let score = 0;
    const numMatch = id.match(/gemini-embedding-(\d+)/);
    if (numMatch) score += 1000 + parseInt(numMatch[1], 10) * 100;
    if (id.includes('text-embedding')) score += 500;
    if (!id.includes('exp') && !id.includes('preview')) score += 50;
    return score;
  };

  candidates.sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
  return candidates[0];
}

export interface ModelFallbackOptions<T> {
  action: (modelName: string) => Promise<T>;
  primaryModel: string;
  fallbackModels?: string[];
  maxRetriesPerModel?: number;
  failedModels?: Set<string>;
  discoverModel?: (exclude: Set<string>) => Promise<string | null>;
  onModelSwitch?: (fromModel: string, toModel: string, reason: string) => void;
  retryDelayMs?: (attempt: number, error: any) => number | null;
}

/**
 * Execute a model-backed async action with automatic fallback across candidate models
 * and dynamic replacement discovery when a model is deprecated or removed (404/NOT_FOUND).
 */
export async function executeWithModelFallback<T>(
  options: ModelFallbackOptions<T>
): Promise<{ result: T; modelUsed: string }> {
  const {
    action,
    primaryModel,
    fallbackModels = [],
    maxRetriesPerModel = 3,
    failedModels = new Set<string>(),
    discoverModel,
    onModelSwitch,
    retryDelayMs,
  } = options;

  const queue = Array.from(new Set([primaryModel, ...fallbackModels])).filter(
    m => !failedModels.has(m)
  );
  if (queue.length === 0) {
    queue.push(primaryModel);
  }

  let discoveredOnce = false;
  let lastError: any;

  while (queue.length > 0) {
    const modelName = queue.shift()!;

    for (let attempt = 1; attempt <= maxRetriesPerModel; attempt++) {
      try {
        const result = await action(modelName);
        return { result, modelUsed: modelName };
      } catch (error: any) {
        lastError = error;

        if (isModelUnavailableError(error)) {
          failedModels.add(modelName);

          // If static fallbacks are exhausted, try live discovery once
          if (queue.length === 0 && !discoveredOnce && discoverModel) {
            discoveredOnce = true;
            try {
              const discovered = await discoverModel(failedModels);
              if (discovered && !failedModels.has(discovered)) {
                queue.push(discovered);
              }
            } catch {
              // Discovery failed; fall through and throw lastError
            }
          }

          if (queue.length > 0) {
            onModelSwitch?.(modelName, queue[0], error?.message || 'Model unavailable');
            break; // Immediately move to next model without retrying the dead one
          }

          throw error;
        }

        const waitMs = retryDelayMs ? retryDelayMs(attempt, error) : null;
        if (waitMs === null || attempt >= maxRetriesPerModel) {
          throw error;
        }
        if (waitMs > 0) {
          await new Promise(resolve => setTimeout(resolve, waitMs));
        }
      }
    }
  }

  throw lastError;
}
