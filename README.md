# Polymarket execution and risk research

TypeScript/Node.js implementation of market-data ingestion, strategy coordination, order execution, inventory accounting, and risk controls for Polymarket.

## What to review

| Area | Entry point | Implementation |
| --- | --- | --- |
| Market data | src/polymarket/market-ws.ts | WebSocket updates and order-book state |
| Coordination | src/core/strategy-coordinator.ts | Strategy intents checked against shared position and risk gates |
| Execution | src/trading/quote-executor.ts | Quote posting, cancellation and replacement |
| Signing | src/trading/clob-client.ts | ethers wallet and CLOB client construction |
| Accounting | src/core/inventory-lot-tracker.ts | Inventory lots and realized P&L support |
| Risk | src/core/risk-manager.ts | Running, degraded and halted states |
| Recovery | src/core/runtime-checkpoint-service.ts | Atomic checkpoint writes |
| Simulation | src/simulation/harness.ts | Offline replay using strategy and execution components |

## Architecture

~~~text
Market feeds -> Order books -> Strategy evaluators
 -> Coordinator -> Risk / position checks -> Execution adapters
 -> Fill processing -> Inventory / P&L -> Checkpoints and reports
~~~

The design separates strategy intent from execution and portfolio limits. Different strategies share position and risk state rather than placing independent orders without coordination.

## Review locally

Use Node.js 22+.

~~~sh
npm ci --ignore-scripts
npm run build
npm test
~~~

The test suite uses mocked clients and local fixtures. No funded wallet is required for these commands. See VALIDATION.md for the actual results and known failures. The public package intentionally exposes build and test commands rather than live-launch shortcuts. Source files still include execution capabilities; do not use credentials or run operational scripts merely to review this repository.

## Boundaries

This is trading-system research, not a complete exchange, custody service, audited protocol, or verified profitable strategy. Contract interaction code does not imply authorship or audit of the underlying smart contracts. External API assumptions and dependencies require revalidation before any deployment.

## About this public edition

This is a source snapshot prepared for code review. Operational logs, account-specific configuration, runtime state, private keys, and the private repository history are excluded. The original implementation is preserved separately. This snapshot is not evidence of audited production readiness or investment performance.

Please use Upwork Messages for project discussions.
