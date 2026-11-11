import { RelayerTxType } from "@polymarket/builder-relayer-client";
import { deriveProxyWallet, deriveSafe } from "@polymarket/builder-relayer-client/dist/builder/derive.js";
import { BuilderConfig } from "@polymarket/builder-signing-sdk";
import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config.js";
import { NegativeRiskConversionBridge } from "../src/trading/negative-risk-conversion-bridge.js";
import type { BinaryMarket } from "../src/types.js";
import type { NegativeRiskNoConversionOpportunity } from "../src/strategy/negative-risk.js";

const makeMarket = (id: string, slug: string): BinaryMarket => ({
  id,
  conditionId: `condition-${id}`,
  questionId: `question-${id}`,
  question: `Question ${id}`,
  slug,
  eventId: "event-1",
  eventSlug: "sample-event",
  eventTitle: "Sample event",
  groupItemTitle: slug,
  category: "Politics",
  outcomes: ["Yes", "No"],
  tokenIds: [`yes-${id}`, `no-${id}`],
  active: true,
  closed: false,
  acceptingOrders: true,
  enableOrderBook: true,
  orderMinSize: 1,
  orderPriceMinTickSize: 0.01,
  feesEnabled: false,
  negRisk: true,
  enableNegRisk: true,
  cumulativeMarkets: false,
  showAllOutcomes: true
});

const conversionOpportunity: NegativeRiskNoConversionOpportunity = {
  kind: "no-to-yes-conversion",
  group: {
    eventId: "event-1",
    eventSlug: "sample-event",
    eventTitle: "Sample event",
    marketId: "market-1",
    markets: [makeMarket("1", "outcome-a"), makeMarket("2", "outcome-b"), makeMarket("3", "outcome-c")]
  },
  shares: 5,
  grossCost: 2,
  grossCostPerShare: 0.4,
  grossEdge: 2.8,
  feeCost: 0,
  netEdge: 2.8,
  netEdgeBpsOnPar: 5600,
  detectedAtMs: Date.now(),
  entry: {
    market: makeMarket("1", "outcome-a"),
    tokenId: "no-1",
    outcomeTitle: "No: Outcome A",
    fill: {
      shares: 5,
      totalCost: 2,
      averagePrice: 0.4,
      worstPrice: 0.4
    },
    tickSize: 0.01,
    limitPrice: 0.4,
    feeRateBps: 0
  },
  exitLegs: [
    {
      market: makeMarket("2", "outcome-b"),
      tokenId: "yes-2",
      outcomeTitle: "Outcome B",
      fill: {
        shares: 4.5,
        totalProceeds: 2.7,
        averagePrice: 0.6,
        worstPrice: 0.6
      },
      tickSize: 0.01,
      limitPrice: 0.6,
      feeRateBps: 0
    },
    {
      market: makeMarket("3", "outcome-c"),
      tokenId: "yes-3",
      outcomeTitle: "Outcome C",
      fill: {
        shares: 4.5,
        totalProceeds: 2.1,
        averagePrice: 0.46666667,
        worstPrice: 0.46
      },
      tickSize: 0.01,
      limitPrice: 0.46,
      feeRateBps: 0
    }
  ],
  grossProceeds: 4.8,
  convertedSharesPerLeg: 4.5,
  conversionFeeBps: 0,
  conversionMarketId: "0x0000000000000000000000000000000000000000000000000000000000000100",
  conversionIndexSet: "0x2",
  sourceQuestionIndex: 1
};

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
} as unknown as Logger;

describe("NegativeRiskConversionBridge", () => {
  const originalConversionHolderAddress = config.negativeRisk.conversionHolderAddress;
  const originalAllowedRelayerHolderAddresses = [
    ...config.negativeRisk.allowedRelayerHolderAddresses
  ];
  const originalRelayerTxType = config.negativeRisk.relayerTxType;

  afterEach(() => {
    (
      config.negativeRisk as { conversionHolderAddress?: string }
    ).conversionHolderAddress = originalConversionHolderAddress;
    (
      config.negativeRisk as { allowedRelayerHolderAddresses: string[] }
    ).allowedRelayerHolderAddresses = [...originalAllowedRelayerHolderAddresses];
    (config.negativeRisk as { relayerTxType: "proxy" | "safe" | "auto" }).relayerTxType =
      originalRelayerTxType;
  });

  it("uses the relayer path for a proxy holder derived from the signer", async () => {
    const signerAddress = "0x1111111111111111111111111111111111111111";
    const proxyFactory = "0x2222222222222222222222222222222222222222";
    const makerAddress = deriveProxyWallet(signerAddress, proxyFactory);
    const execute = vi.fn().mockResolvedValue({
      transactionHash: "0xrelay",
      hash: "0xrelay",
      wait: vi.fn().mockResolvedValue({
        transactionHash: "0xrelay"
      })
    });
    const bridge = new NegativeRiskConversionBridge(
      {
        chainId: 137,
        signer: {
          getAddress: vi.fn().mockResolvedValue(signerAddress),
          _signTypedData: vi.fn().mockResolvedValue("0xsig")
        }
      } as never,
      logger,
      makerAddress,
      {
        relayerUrl: "https://relayer-v2.polymarket.com/",
        builderConfig: new BuilderConfig({
          localBuilderCreds: {
            key: "builder-key",
            secret: "builder-secret",
            passphrase: "builder-passphrase"
          }
        }),
        autoApproveAdapter: true,
        relayClientFactory: () =>
          ({
            contractConfig: {
              ProxyContracts: {
                ProxyFactory: proxyFactory
              },
              SafeContracts: {
                SafeFactory: "0x3333333333333333333333333333333333333333"
              }
            },
            execute
          }) as never
      }
    );

    const result = await bridge.execute(conversionOpportunity);

    expect(result).toEqual({
      status: "converted",
      txHash: "0xrelay",
      autoApprovedAdapter: true
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toHaveLength(2);
  });

  it("rejects relayed conversion when the configured maker/funder does not match the derived proxy", async () => {
    const bridge = new NegativeRiskConversionBridge(
      {
        chainId: 137,
        signer: {
          getAddress: vi.fn().mockResolvedValue("0x1111111111111111111111111111111111111111"),
          _signTypedData: vi.fn().mockResolvedValue("0xsig")
        }
      } as never,
      logger,
      "0x9999999999999999999999999999999999999999",
      {
        relayerUrl: "https://relayer-v2.polymarket.com/",
        builderConfig: new BuilderConfig({
          localBuilderCreds: {
            key: "builder-key",
            secret: "builder-secret",
            passphrase: "builder-passphrase"
          }
        }),
        autoApproveAdapter: true,
        relayClientFactory: () =>
          ({
            contractConfig: {
              ProxyContracts: {
                ProxyFactory: "0x2222222222222222222222222222222222222222"
              },
              SafeContracts: {
                SafeFactory: "0x3333333333333333333333333333333333333333"
              }
            },
            execute: vi.fn()
          }) as never
      }
    );

    const result = await bridge.execute(conversionOpportunity);

    expect(result.status).toBe("funder_mismatch");
    expect(result.detail).toContain("preferredHolder=");
  });

  it("supports an explicit conversion holder override that differs from maker/funder", async () => {
    const signerAddress = "0x1111111111111111111111111111111111111111";
    const proxyFactory = "0x2222222222222222222222222222222222222222";
    const conversionHolder = deriveProxyWallet(signerAddress, proxyFactory);
    const execute = vi.fn().mockResolvedValue({
      transactionHash: "0xholderoverride",
      hash: "0xholderoverride",
      wait: vi.fn().mockResolvedValue({
        transactionHash: "0xholderoverride"
      })
    });
    (
      config.negativeRisk as { conversionHolderAddress?: string }
    ).conversionHolderAddress = conversionHolder;

    const bridge = new NegativeRiskConversionBridge(
      {
        chainId: 137,
        signer: {
          getAddress: vi.fn().mockResolvedValue(signerAddress),
          _signTypedData: vi.fn().mockResolvedValue("0xsig")
        }
      } as never,
      logger,
      "0x9999999999999999999999999999999999999999",
      {
        relayerUrl: "https://relayer-v2.polymarket.com/",
        builderConfig: new BuilderConfig({
          localBuilderCreds: {
            key: "builder-key",
            secret: "builder-secret",
            passphrase: "builder-passphrase"
          }
        }),
        autoApproveAdapter: true,
        relayClientFactory: () =>
          ({
            contractConfig: {
              ProxyContracts: {
                ProxyFactory: proxyFactory
              },
              SafeContracts: {
                SafeFactory: "0x3333333333333333333333333333333333333333"
              }
            },
            execute
          }) as never
      }
    );

    const result = await bridge.execute(conversionOpportunity);

    expect(result).toEqual({
      status: "converted",
      txHash: "0xholderoverride",
      autoApprovedAdapter: true
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("supports auto relayer routing and chooses the matching safe holder", async () => {
    const signerAddress = "0x1111111111111111111111111111111111111111";
    const proxyFactory = "0x2222222222222222222222222222222222222222";
    const safeFactory = "0x3333333333333333333333333333333333333333";
    const safeHolder = deriveSafe(signerAddress, safeFactory);
    const execute = vi.fn().mockResolvedValue({
      transactionHash: "0xsafeauto",
      hash: "0xsafeauto",
      wait: vi.fn().mockResolvedValue({
        transactionHash: "0xsafeauto"
      })
    });
    (config.negativeRisk as { relayerTxType: "proxy" | "safe" | "auto" }).relayerTxType =
      "auto";
    (
      config.negativeRisk as { allowedRelayerHolderAddresses: string[] }
    ).allowedRelayerHolderAddresses = [safeHolder];

    const bridge = new NegativeRiskConversionBridge(
      {
        chainId: 137,
        signer: {
          getAddress: vi.fn().mockResolvedValue(signerAddress),
          _signTypedData: vi.fn().mockResolvedValue("0xsig")
        }
      } as never,
      logger,
      "0x9999999999999999999999999999999999999999",
      {
        relayerUrl: "https://relayer-v2.polymarket.com/",
        builderConfig: new BuilderConfig({
          localBuilderCreds: {
            key: "builder-key",
            secret: "builder-secret",
            passphrase: "builder-passphrase"
          }
        }),
        autoApproveAdapter: true,
        relayClientFactory: (_signer, txType) =>
          ({
            contractConfig: {
              ProxyContracts: {
                ProxyFactory: proxyFactory
              },
              SafeContracts: {
                SafeFactory: safeFactory
              }
            },
            execute: txType === RelayerTxType.SAFE ? execute : vi.fn()
          }) as never
      }
    );

    const result = await bridge.execute(conversionOpportunity);

    expect(result).toEqual({
      status: "converted",
      txHash: "0xsafeauto",
      autoApprovedAdapter: true
    });
    expect(execute).toHaveBeenCalledOnce();
  });
});
