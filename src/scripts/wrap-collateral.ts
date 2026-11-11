import "dotenv/config";

import { BigNumber, Contract, Wallet, providers, utils } from "ethers";

const ERC20_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)"
];

const ONRAMP_ABI = [
  "function wrap(uint256 amount)"
];

interface Options {
  amountUsdc: string;
  privateKey: string;
  rpcUrl: string;
  usdcAddress: string;
  pusdAddress: string;
  onrampAddress: string;
  dryRun: boolean;
  funderAddress?: string;
}

const readArg = (name: string): string | undefined => {
  const prefix = `--${name}=`;
  const item = process.argv.slice(2).find((entry) => entry.startsWith(prefix));
  return item ? item.slice(prefix.length) : undefined;
};

const requireEnv = (name: string, override?: string): string => {
  const value = override ?? process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing ${name}. Set it in .env or pass via CLI flag.`);
  }
  return value.trim();
};

const parseOptions = (): Options => {
  const amountUsdc = readArg("amount");
  if (!amountUsdc) {
    throw new Error(
      "Missing --amount=<usdc>. Example: npm run wrap-collateral -- --amount=100 --dry-run"
    );
  }

  return {
    amountUsdc,
    privateKey: requireEnv("POLYBOT_PRIVATE_KEY", readArg("private-key")),
    rpcUrl: requireEnv("POLYBOT_CHAIN_RPC_URL", readArg("rpc-url")),
    usdcAddress: requireEnv("POLYBOT_USDC_TOKEN_ADDRESS", readArg("usdc")),
    pusdAddress: requireEnv("POLYBOT_PUSD_TOKEN_ADDRESS", readArg("pusd")),
    onrampAddress: requireEnv("POLYBOT_COLLATERAL_ONRAMP_ADDRESS", readArg("onramp")),
    dryRun: process.argv.includes("--dry-run"),
    funderAddress: readArg("funder") ?? process.env.POLYBOT_FUNDER_ADDRESS
  };
};

const formatUnits = (value: BigNumber, decimals: number): string =>
  utils.formatUnits(value, decimals);

const main = async () => {
  const options = parseOptions();

  const provider = new providers.JsonRpcProvider(options.rpcUrl);
  const wallet = new Wallet(options.privateKey, provider);

  console.log("─".repeat(60));
  console.log("Polymarket V2 Collateral Onramp — USDC → pUSD wrap");
  console.log("─".repeat(60));
  console.log("Signer (EOA):       ", wallet.address);
  console.log("Funder (proxy):     ", options.funderAddress ?? "(same as signer)");
  console.log("USDC token:         ", options.usdcAddress);
  console.log("pUSD token:         ", options.pusdAddress);
  console.log("Collateral Onramp:  ", options.onrampAddress);
  console.log("Mode:               ", options.dryRun ? "DRY-RUN (no tx)" : "LIVE");
  console.log("─".repeat(60));

  const usdc = new Contract(options.usdcAddress, ERC20_ABI, wallet);
  const pusd = new Contract(options.pusdAddress, ERC20_ABI, provider);
  const onramp = new Contract(options.onrampAddress, ONRAMP_ABI, wallet);

  const usdcDecimals: number = await usdc.decimals();
  const pusdDecimals: number = await pusd.decimals();
  const amount = utils.parseUnits(options.amountUsdc, usdcDecimals);

  const usdcBalance: BigNumber = await usdc.balanceOf(wallet.address);
  const pusdBalanceBefore: BigNumber = await pusd.balanceOf(wallet.address);
  const allowance: BigNumber = await usdc.allowance(wallet.address, options.onrampAddress);

  console.log("USDC balance:        ", formatUnits(usdcBalance, usdcDecimals));
  console.log("pUSD balance (pre):  ", formatUnits(pusdBalanceBefore, pusdDecimals));
  console.log("USDC → onramp allow.:", formatUnits(allowance, usdcDecimals));
  console.log("Wrap amount:         ", options.amountUsdc);

  if (usdcBalance.lt(amount)) {
    throw new Error(
      `Insufficient USDC. Balance ${formatUnits(usdcBalance, usdcDecimals)} < requested ${options.amountUsdc}`
    );
  }

  if (options.dryRun) {
    console.log("\nDRY-RUN: would approve onramp (if needed) then call wrap(). No transaction sent.");
    return;
  }

  if (allowance.lt(amount)) {
    console.log("\nApproving onramp to spend USDC…");
    const approveTx = await usdc.approve(options.onrampAddress, amount);
    console.log("approve tx:", approveTx.hash);
    await approveTx.wait();
    console.log("approve confirmed");
  } else {
    console.log("\nAllowance already sufficient — skipping approve.");
  }

  console.log("\nCalling onramp.wrap()…");
  const wrapTx = await onramp.wrap(amount);
  console.log("wrap tx:", wrapTx.hash);
  await wrapTx.wait();
  console.log("wrap confirmed");

  const pusdBalanceAfter: BigNumber = await pusd.balanceOf(wallet.address);
  console.log("\npUSD balance (post): ", formatUnits(pusdBalanceAfter, pusdDecimals));
  console.log("Δ pUSD:              ", formatUnits(pusdBalanceAfter.sub(pusdBalanceBefore), pusdDecimals));
  console.log("\nDone. Verify on Polygonscan and proceed to Exchange allowance setup.");
};

main().catch((error) => {
  console.error("\nwrap-collateral failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
