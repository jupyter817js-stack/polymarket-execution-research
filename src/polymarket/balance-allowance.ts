interface BalanceAllowanceLike {
  balance?: string;
  allowance?: string;
  allowances?: Record<string, string>;
}

/**
 * V2 wire still returns plural `allowances` (object keyed by exchange address)
 * even though the V2 SDK type declares singular `allowance: string`.
 * Read plural first, fall back to singular, return raw uint as number.
 */
export const readMaxAllowanceRaw = (response: BalanceAllowanceLike): number | undefined => {
  if (response.allowances && typeof response.allowances === "object") {
    let max: number | undefined;
    for (const value of Object.values(response.allowances)) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && (max === undefined || parsed > max)) {
        max = parsed;
      }
    }
    if (max !== undefined) {
      return max;
    }
  }
  if (response.allowance !== undefined) {
    const parsed = Number(response.allowance);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};
