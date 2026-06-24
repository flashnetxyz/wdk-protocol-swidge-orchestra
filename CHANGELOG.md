# Changelog

All notable changes to `@flashnet/orchestra-wdk` are documented here.

## [0.2.0] - 2026-06-09

### Changed

- Implement the WDK `SwidgeProtocol` interface from `@tetherto/wdk-wallet@1.0.0-beta.9`.
- Add `quoteSwidge`, `swidge`, `getSwidgeStatus`, `getSupportedChains`, and `getSupportedTokens`.
- Keep the explicit `prepareSwap` and `executeSwapIntent` flow for durable app-side persistence.
- Move WDK wallet core to a runtime dependency because the module extends a WDK base protocol at import time.

### Added

- Swidge status and fee mapping documentation.
- Route-matrix based chain and token discovery.

## [0.1.0] - 2026-06-09

### Added

- Initial Orchestra WDK package with Spark, Bitcoin L1, Lightning route documentation, client-key support, and funded live-test harness.
