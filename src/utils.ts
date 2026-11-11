export const asNumber = (value: string | number | undefined, fallback = 0): number => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : fallback;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  return fallback;
};

const getTickDecimalPlaces = (tickSize: number): number => {
  const asText = tickSize.toString().toLowerCase();

  if (asText.includes("e-")) {
    const [, exponent = "0"] = asText.split("e-");
    return Number(exponent);
  }

  const decimalIndex = asText.indexOf(".");
  return decimalIndex >= 0 ? asText.length - decimalIndex - 1 : 0;
};

const normalizeToTickPrecision = (value: number, tickSize: number): number =>
  Number(value.toFixed(getTickDecimalPlaces(tickSize)));

export const roundDownToTick = (value: number, tickSize: number): number => {
  if (tickSize <= 0) {
    return value;
  }

  return normalizeToTickPrecision(
    Math.floor((value + Number.EPSILON) / tickSize) * tickSize,
    tickSize
  );
};

export const roundUpToTick = (value: number, tickSize: number): number => {
  if (tickSize <= 0) {
    return value;
  }

  return normalizeToTickPrecision(
    Math.ceil((value - Number.EPSILON) / tickSize) * tickSize,
    tickSize
  );
};

export const clampPrice = (value: number, tickSize: number): number => {
  const lowerBound = tickSize;
  const upperBound = 1 - tickSize;
  return normalizeToTickPrecision(Math.min(Math.max(value, lowerBound), upperBound), tickSize);
};

export const getExecutableTickSize = (
  bookTickSize: number | undefined,
  marketTickSize: number | undefined,
  fallback = 0.001
): number => {
  const candidates = [bookTickSize, marketTickSize].filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0
  );

  if (candidates.length === 0) {
    return fallback;
  }

  return Math.max(...candidates);
};

export const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const result: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }

  return result;
};

export const formatUsd = (value: number): string => value.toFixed(4);

export const isPast = (timestamp?: string): boolean => {
  if (!timestamp) {
    return false;
  }

  const date = Date.parse(timestamp);
  return Number.isFinite(date) && date <= Date.now();
};
