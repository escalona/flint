export interface ParsedPiModel {
  provider: string;
  modelId: string;
}

/**
 * Flint model IDs for pi use the form "provider/model".
 */
export function parsePiModel(value: string | undefined): ParsedPiModel | null {
  if (!value) return null;

  const slashIndex = value.indexOf("/");
  if (slashIndex <= 0 || slashIndex === value.length - 1) {
    return null;
  }

  const provider = value.slice(0, slashIndex).trim();
  const modelId = value.slice(slashIndex + 1).trim();

  if (!provider || !modelId) {
    return null;
  }

  return { provider, modelId };
}

export function formatPiModel(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}
