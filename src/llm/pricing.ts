export interface ModelRatePerMillionTokens {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

const MODEL_RATES: ReadonlyArray<{
  prefix: string;
  rates: ModelRatePerMillionTokens;
}> = [
  {
    prefix: "offline",
    rates: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
  },
  {
    prefix: "gemini-2.5-flash",
    rates: { inputUsdPerMillion: 0.3, outputUsdPerMillion: 2.5 },
  },
  {
    prefix: "gemini-2.5-pro",
    rates: { inputUsdPerMillion: 1.25, outputUsdPerMillion: 10.0 },
  },
  {
    prefix: "gemini-2.0-flash",
    rates: { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.4 },
  },
  {
    prefix: "gpt-4o-mini",
    rates: { inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.6 },
  },
  {
    prefix: "gpt-4o",
    rates: { inputUsdPerMillion: 2.5, outputUsdPerMillion: 10.0 },
  },
];

export function getModelTokenRates(model: string): ModelRatePerMillionTokens {
  const lower = model.trim().toLowerCase();
  for (const entry of MODEL_RATES) {
    if (lower.startsWith(entry.prefix)) {
      return entry.rates;
    }
  }
  return { inputUsdPerMillion: 0.3, outputUsdPerMillion: 2.5 };
}

export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const rates = getModelTokenRates(model);
  const raw =
    (Math.max(0, inputTokens) / 1_000_000) * rates.inputUsdPerMillion +
    (Math.max(0, outputTokens) / 1_000_000) * rates.outputUsdPerMillion;
  return Number(raw.toFixed(8));
}
