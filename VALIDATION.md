# Validation and limitations

Checked: 11 November 2026. These results describe this public source snapshot only.

- npm run build: passed.
- Full test run: 391 tests, 371 passed and 20 failed; 54 suites passed and 7 failed. The suite is not green. Known failures include expectation/default-behavior mismatches and incomplete logger mocks; execution behavior needs review before use. No tests were hidden or disabled to report success.
- Kept the original CLOB SDK API version for source compatibility; updated Axios and ws dependencies.
- npm audit --omit=dev: 17 low dependency findings; 0 moderate, high or critical findings. Some SDK dependencies are deprecated and need a separately validated migration.
- No funded wallet, exchange order, live strategy, profitability check or production deployment was run.

## Publication review

Private operational files and original history are excluded. Source was reviewed for credentials and direct contact information; the new public Git history is scanned with Gitleaks before publication. Narrow inline exemptions identify deterministic test fixtures and public contract addresses, not operational secrets. Automated checks are not a security audit and cannot guarantee the absence of vulnerabilities.
