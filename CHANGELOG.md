# Changelog

All notable changes to `wdk-protocol-swidge-orchestra` are documented here.

## [0.2.0] - 2026-06-24

### Changed

- Rename the npm package to `wdk-protocol-swidge-orchestra` for first publish under the WDK protocol naming convention.
- Update WDK package pins to the latest verified beta versions as of 2026-06-24.
- Implement the WDK `SwidgeProtocol` interface from `@tetherto/wdk-wallet@1.0.0-beta.11`.
- Add `quoteSwidge`, `swidge`, `getSwidgeStatus`, `getSupportedChains`, and `getSupportedTokens`.
- Keep the explicit `prepareSwap` and `executeSwapIntent` flow for durable app-side persistence.
- Move WDK wallet core to a runtime dependency because the module extends a WDK base protocol at import time.

### Added

- Swidge status and fee mapping documentation.
- Route-matrix based chain and token discovery.
- Error type documentation for API, state, submit, and timeout failures.
- Support and vulnerability reporting channels.

## [0.1.0] - 2026-06-09

### Added

- Initial Orchestra WDK package with Spark, Bitcoin L1, Lightning route documentation, client-key support, and funded live-test harness.
