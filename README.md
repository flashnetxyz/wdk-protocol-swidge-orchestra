# wdk-protocol-swidge-orchestra

![Powered by WDK](https://img.shields.io/badge/Powered%20by-WDK-111111)

`wdk-protocol-swidge-orchestra` is a WDK `SwidgeProtocol` for moving between BTC on Spark, Bitcoin L1, or Lightning and USDT on Ethereum, Tron, Arbitrum, Solana, BSC, Optimism, Plasma, Polygon, TON, and every route returned by Orchestra.

WDK owns wallet accounts, key material, and transaction signing. Orchestra owns quote routing, deposit addresses, order state, and settlement. The host wallet owns durable local or backend persistence.

```
WDK account -> Orchestra protocol -> Flashnet Orchestra API
     |                  |                    |
     | signs payment    | submits tx id      | routes and settles order
     |                  |                    |
     +---- app persists serializable state --+
```

The package does not run a database, custody keys, poll chains directly, or hide money-moving state transitions from the app.

## USDT Route Coverage

Use the live route matrix as the source of truth:

[`GET /v1/orchestration/routes`](https://orchestration.flashnet.xyz/v1/orchestration/routes)

Representative BTC and USDT routes:

```javascript
const routes = [
  "spark:BTC -> tron:USDT",
  "bitcoin:BTC -> ethereum:USDT",
  "lightning:BTC -> arbitrum:USDT",
  "bsc:USDT -> spark:BTC",
  "solana:USDT -> lightning:BTC",
  "polygon:USDT -> bitcoin:BTC"
]
```

The package also exposes WDK discovery methods:

```javascript
const chains = await orchestra.getSupportedChains()
const tokens = await orchestra.getSupportedTokens({
  fromChain: "spark",
  toChain: "tron"
})
```

Use discovery for wallet UI. Use the route matrix when you need the exact source and destination pairs Orchestra can execute at that moment.

## Install

```bash
npm install wdk-protocol-swidge-orchestra @tetherto/wdk-wallet@1.0.0-beta.11
```

Install the WDK wallet packages for the chains you support:

```bash
npm install @tetherto/wdk@1.0.0-beta.12 @tetherto/wdk-wallet-spark@1.0.0-beta.21 @tetherto/wdk-wallet-btc@1.0.0-beta.10 @tetherto/wdk-wallet-evm@1.0.0-beta.14
```

## WDK Interface

`Orchestra` extends `SwidgeProtocol` from `@tetherto/wdk-wallet@1.0.0-beta.11`.

Implemented methods:

- `quoteSwidge(options)`
- `swidge(options, config?)`
- `getSwidgeStatus(id, options?)`
- `getSupportedChains()`
- `getSupportedTokens(options?)`

WDK's `SwidgeProtocol` base class delegates `quoteSwap`, `swap`, `quoteBridge`, and `bridge` to `quoteSwidge` and `swidge`. This package does not override those methods.

Current WDK beta note: the protocol class conforms to `SwidgeProtocol`. If the WDK manager in your app has not yet added Swidge registration helpers, construct the protocol from the source account directly as shown below.

## Create A Protocol

Create one Orchestra instance per source wallet account. Set `sourceChain` explicitly because WDK accounts do not always expose a canonical chain id to protocol constructors.

```javascript
import WDK from "@tetherto/wdk"
import WalletManagerBtc from "@tetherto/wdk-wallet-btc"
import WalletManagerEvm from "@tetherto/wdk-wallet-evm"
import WalletManagerSpark from "@tetherto/wdk-wallet-spark"
import Orchestra from "wdk-protocol-swidge-orchestra"

const wdk = new WDK(seedPhrase)
  .registerWallet("spark", WalletManagerSpark, {
    network: "MAINNET",
    syncAndRetry: true
  })
  .registerWallet("bitcoin", WalletManagerBtc, {
    network: "bitcoin",
    client: {
      type: "electrum",
      clientConfig: {
        host: "electrum.blockstream.info",
        port: 50001
      }
    }
  })
  .registerWallet("arbitrum", WalletManagerEvm, {
    chainId: 42161,
    provider: process.env.ARBITRUM_RPC_URL
  })

const spark = await wdk.getAccount("spark", 0)

const orchestra = new Orchestra(spark, {
  sourceChain: "spark",
  apiKey: process.env.FLASHNET_API_KEY,
  baseUrl: "https://orchestration.flashnet.xyz"
})
```

EVM token sources need token contract addresses. Common USDT source addresses are built in, but production wallets should pass their own allowlist.

```javascript
const arbitrum = await wdk.getAccount("arbitrum", 0)

const orchestra = new Orchestra(arbitrum, {
  sourceChain: "arbitrum",
  apiKey: process.env.FLASHNET_API_KEY,
  sourceTokenAddresses: {
    "arbitrum:USDT": "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9"
  }
})
```

## Quote

`quoteSwidge()` is side-effect-free. It calls Orchestra's estimate endpoint and does not reserve a deposit address.

```javascript
const quote = await orchestra.quoteSwidge({
  fromToken: "spark:BTC",
  toToken: "tron:USDT",
  fromTokenAmount: 7116n,
  recipient: "TRecipient...",
  slippage: 0.01
})

console.log(quote.fromTokenAmount)
console.log(quote.toTokenAmount)
console.log(quote.toTokenAmountMin)
console.log(quote.fees)
```

Use smallest units:

| Asset | Unit |
| --- | --- |
| BTC | sats |
| USDT | 6-decimal token units |
| EVM gas asset | wei |

## Execute With WDK Swidge

`swidge()` creates an Orchestra quote, sends the source payment from the WDK account, submits the transaction id to Orchestra, and returns the Orchestra order id.

```javascript
const result = await orchestra.swidge({
  fromToken: "spark:BTC",
  toToken: "tron:USDT",
  fromTokenAmount: 7116n,
  recipient: "TRecipient..."
}, {
  maxNetworkFeeBps: 20n,
  maxProtocolFeeBps: 100n
})

console.log(result.id)
console.log(result.hash)
console.log(result.transactions)
```

Use this one-call path only when the host app has its own crash recovery around the call. Wallet production flows should use the explicit persistence boundary below.

## Production Flow

Use `prepareSwap()` and `executeSwapIntent()` when funds are at risk. The split flow gives the host wallet a durable point between quote creation and source payment.

1. `prepareSwap()` creates an Orchestra quote and reserves a deposit address.
2. The app persists the returned intent.
3. `executeSwapIntent()` sends the source payment and submits the transfer id.
4. The app persists the submitted state.
5. The app tracks the order with `getOrderStatus()`, `getSwidgeStatus()`, `waitForCompletion()`, or SSE.

`saveSwap` and `saveOrderStatus` are not exported by this package. They are placeholders for your implementation. Back them with your own database, encrypted local storage, or backend API before moving real funds.

```javascript
const intent = await orchestra.prepareSwap({
  fromToken: "spark:BTC",
  toToken: "tron:USDT",
  fromTokenAmount: 7116n,
  recipient: "TRecipient..."
})

await saveSwap(intent)

const submitted = await orchestra.executeSwapIntent(intent)
await saveSwap(submitted)

const finalStatus = await orchestra.waitForCompletion(submitted, {
  onStatus: async (status) => {
    await saveOrderStatus(status)
  }
})
```

Persist the full object returned by every state transition. Do not store only the order id. Recovery may need the quote id, deposit address, source tx hash, read token, source chain, and submit idempotency key.

## Spark BTC To USDT

Spark signs the BTC transfer. Orchestra settles USDT on the destination chain.

```javascript
const spark = await wdk.getAccount("spark", 0)
const orchestra = new Orchestra(spark, {
  sourceChain: "spark",
  apiKey
})

const intent = await orchestra.prepareSwap({
  fromToken: "spark:BTC",
  toToken: "tron:USDT",
  fromTokenAmount: 7116n,
  recipient: "TRecipient..."
})

await saveSwap(intent)

const submitted = await orchestra.executeSwapIntent(intent)
await saveSwap(submitted)
```

The submitted state includes the Spark source transfer id, source wallet network fee, Orchestra order id, and read token when using a scoped client key.

```javascript
console.log(submitted.sourceTxHash)
console.log(submitted.sourceNetworkFee)
console.log(submitted.orderId)
console.log(submitted.readToken)
```

## USDT To Spark BTC

EVM token sources use WDK `transfer({ token, recipient, amount })`. The source account needs native gas for its chain.

```javascript
const bsc = await wdk.getAccount("bsc", 0)
const spark = await wdk.getAccount("spark", 0)

const orchestra = new Orchestra(bsc, {
  sourceChain: "bsc",
  apiKey,
  sourceTokenAddresses: {
    "bsc:USDT": "0x55d398326f99059ff775485246999027b3197955"
  }
})

const intent = await orchestra.prepareSwap({
  fromToken: "bsc:USDT",
  toToken: "spark:BTC",
  fromTokenAmount: 5_000_000n,
  recipient: await spark.getAddress()
})
```

## Bitcoin L1

Bitcoin L1 can be the source or destination.

### L1 BTC Source

```javascript
const bitcoin = await wdk.getAccount("bitcoin", 0)
const spark = await wdk.getAccount("spark", 0)

const orchestra = new Orchestra(bitcoin, {
  sourceChain: "bitcoin",
  apiKey
})

const intent = await orchestra.prepareSwap({
  fromToken: "bitcoin:BTC",
  toToken: "spark:BTC",
  fromTokenAmount: 100000n,
  recipient: await spark.getAddress()
})

await saveSwap(intent)

const submitted = await orchestra.executeSwapIntent(intent, {
  feeRate: 12n,
  confirmationTarget: 2
})
```

For Bitcoin sources, the package submits `bitcoinTxid` to Orchestra. It retries `tx_not_found` and `vout_not_found` submit responses with the same idempotency key because a newly broadcast Bitcoin transaction may need time to propagate.

### L1 BTC Destination

```javascript
const spark = await wdk.getAccount("spark", 0)
const bitcoin = await wdk.getAccount("bitcoin", 0)

const orchestra = new Orchestra(spark, {
  sourceChain: "spark",
  apiKey
})

const intent = await orchestra.prepareSwap({
  fromToken: "spark:BTC",
  toToken: "bitcoin:BTC",
  fromTokenAmount: 100000n,
  recipient: await bitcoin.getAddress()
})
```

Pass `recipient` for cross-account routes. A protocol constructed on a Spark account cannot infer the user's Bitcoin receive address.

## Lightning

Orchestra supports USDT-to-Lightning routes such as `bsc:USDT -> lightning:BTC` and `solana:USDT -> lightning:BTC`. A wallet can pay a BOLT11 invoice or Lightning Address using USDT from a supported chain.

```javascript
const bsc = await wdk.getAccount("bsc", 0)

const orchestra = new Orchestra(bsc, {
  sourceChain: "bsc",
  apiKey
})

const intent = await orchestra.prepareSwap({
  fromToken: "bsc:USDT",
  toToken: "lightning:BTC",
  fromTokenAmount: 5_000_000n,
  recipient: bolt11Invoice,
  refundChain: "bsc",
  refundAddress: await bsc.getAddress()
})
```

Current API behavior: Orchestra asks for `refundAddress` on Lightning destinations. The package forwards `refundChain` and `refundAddress`; it does not enforce the rule locally. If Orchestra removes that API requirement, this package does not need a public API change.

Lightning source routes, such as `lightning:BTC -> tron:USDT`, are also present in the route matrix. A Lightning source is not a WDK account send. The user pays an Orchestra Lightning receive invoice, then the app submits the receive request id to Orchestra.

## Auth

The package supports backend keys and scoped client keys.

Backend key:

```javascript
const orchestra = new Orchestra(account, {
  sourceChain: "spark",
  apiKey: process.env.FLASHNET_API_KEY,
  baseUrl: "https://orchestration.flashnet.xyz"
})
```

Scoped client key:

```javascript
const orchestra = new Orchestra(account, {
  sourceChain: "spark",
  apiKey: process.env.FLASHNET_CLIENT_KEY,
  authMode: "client"
})
```

Scoped client-key submissions return a `readToken`. The package stores it on the submitted state and uses it for status reads when the state object is passed back in.

```javascript
const submitted = await orchestra.executeSwapIntent(intent)

await orchestra.getOrderStatus({
  orderId: submitted.orderId,
  readToken: submitted.readToken
})
```

Backend proxy integrations can provide auth headers per request:

```javascript
const orchestra = new Orchestra(account, {
  sourceChain: "spark",
  baseUrl: "https://your-api.example.com/orchestra",
  getAuthHeaders: async () => ({
    Authorization: `Bearer ${await getSessionToken()}`
  })
})
```

Direct browser SSE needs a URL token because `EventSource` cannot set headers. Admin keys are never sent as URL tokens. For admin-key integrations, proxy SSE from your backend or provide a scoped SSE token through `sseToken` or `getSseToken`.

```javascript
const subscription = orchestra.subscribeOrder(submitted, {
  onStatus: (status) => {
    console.log(status)
  },
  onError: (err) => {
    console.error(err)
  }
})

subscription.close()
```

## State And Recovery

The app must persist every state transition that can affect funds.

```javascript
const orchestra = new Orchestra(account, {
  sourceChain: "spark",
  apiKey,
  onStateChange: async (event, state) => {
    await saveSwap(state)
  }
})
```

`saveSwap` must be your own implementation. It should write the complete state object durably enough that a process crash, browser tab close, mobile app restart, or backend deploy can resume from the latest known state.

State transitions:

| Event | Meaning |
| --- | --- |
| `intent_created` | Quote exists and has a deposit address. No source funds moved. |
| `source_payment_started` | The package is about to broadcast or send the source payment. Persist before this callback returns. |
| `source_payment_sent` | Source payment returned a transaction id. |
| `submitted` | Orchestra accepted the source transaction and created or updated the order. |

Recovery uses the most complete state you have:

```javascript
const next = await orchestra.resumeSwap(savedState)
```

Rules:

- If `orderId` exists, `resumeSwap()` reads order status.
- If `sourceTxHash` exists, `resumeSwap()` submits or re-submits the source transaction id.
- If only the intent exists, `resumeSwap()` refuses to send a fresh payment unless `allowNewSourcePayment: true` is set.

Use `allowNewSourcePayment: true` only after checking wallet history for a prior payment to the quote deposit address.

```javascript
await orchestra.resumeSwap(intentOnlyState, {
  allowNewSourcePayment: true
})
```

If submit fails after the source payment was sent, the thrown error is `OrchestraSubmitError`. Persist `error.state` before retrying.

```javascript
try {
  const submitted = await orchestra.executeSwapIntent(intent)
  await saveSwap(submitted)
  return submitted
} catch (err) {
  if (err.name !== "OrchestraSubmitError") throw err
  await saveSwap(err.state)
  return await orchestra.resumeSwap(err.state)
}
```

## Error Types

All package-specific errors extend `OrchestraError`.

| Error | When it is thrown | Useful fields |
| --- | --- | --- |
| `OrchestraError` | Base class for package-specific failures. | `code`, `details` |
| `OrchestraApiError` | Orchestra returns an API error or an invalid API response. | `code`, `status`, `details` |
| `OrchestraStateError` | Input state is incomplete, unsafe to resume, expired, or not compatible with the requested source payment. | `code`, `details` |
| `OrchestraSubmitError` | The source payment was sent, but submit or post-submit state persistence failed. Persist `state` before retrying. | `state`, `cause` |
| `OrchestraTimeoutError` | An HTTP request or wait operation exceeds its timeout. | `code`, `details` |

## Status Mapping

`getSwidgeStatus()` maps Orchestra order status into the WDK Swidge status enum.

| Orchestra status | WDK Swidge status |
| --- | --- |
| `processing` or unknown in-flight state | `pending` |
| `completed` | `completed` |
| `failed` | `failed` |
| `unfulfilled` | `failed` |
| `expired` | `expired` |
| `refunded` | `refunded` |

## Fee Mapping

Orchestra quote fees are route fees. Source wallet fees are only known after WDK sends the source payment.

| Source | WDK fee type | Included | When known |
| --- | --- | --- | --- |
| Orchestra `feeAmount` or `totalFeeAmount` | `protocol` | Yes | Quote and execution |
| WDK source payment `sourceNetworkFee` | `network` | No | After source payment |

`sourceNetworkFee` is the fee returned by WDK when this package sends the source transaction. It is not an Orchestra fee.

## Asset References

Use chain-qualified asset references in app code:

```javascript
fromToken: "bsc:USDT"
toToken: "spark:BTC"
```

Unqualified assets use the protocol `sourceChain`. Prefer explicit chain prefixes in wallet UI code.

Spark tokens other than BTC need token identifiers:

```javascript
const orchestra = new Orchestra(sparkAccount, {
  sourceChain: "spark",
  apiKey,
  sparkTokenIdentifiers: {
    USDB: "btkn1..."
  }
})
```

EVM tokens need token contract addresses:

```javascript
const orchestra = new Orchestra(bscAccount, {
  sourceChain: "bsc",
  apiKey,
  sourceTokenAddresses: {
    "bsc:USDT": "0x55d398326f99059ff775485246999027b3197955"
  }
})
```

## Live Test Harness

The repository includes a local harness for funded smoke tests. These commands move mainnet funds by default. The harness uses Arbitrum because gas cost is low and the WDK EVM wallet works with a public RPC. The route matrix remains the source of truth for supported chains.

The harness creates a random mnemonic, stores it in `.orchestra-live.env`, prints funding addresses, and stores order state in `.orchestra-live-state/`. Both paths are ignored by git.

```bash
npm install
npm run live:init
```

Set `FLASHNET_API_KEY` in `.orchestra-live.env` or pass it as an environment variable.

```bash
npm run live:addresses
```

Spark BTC to Arbitrum USDT:

```bash
npm run live:quote -- --direction spark-btc-to-arbitrum-usdt --amount 7116
npm run live:prepare -- --direction spark-btc-to-arbitrum-usdt --amount 7116 --out .orchestra-live-state/spark-to-arb.json
npm run live:execute -- --file .orchestra-live-state/spark-to-arb.json --yes
npm run live:wait -- --file .orchestra-live-state/spark-to-arb.json --timeoutMs 7200000
```

Arbitrum USDT to Spark BTC:

```bash
npm run live:quote -- --direction arbitrum-usdt-to-spark-btc --amount 5466162 --to spark1...
npm run live:prepare -- --direction arbitrum-usdt-to-spark-btc --amount 5466162 --to spark1... --out .orchestra-live-state/arb-to-spark.json
npm run live:execute -- --file .orchestra-live-state/arb-to-spark.json --yes
npm run live:wait -- --file .orchestra-live-state/arb-to-spark.json --timeoutMs 7200000
```

Bitcoin L1 to Arbitrum USDT:

```bash
npm run live:quote -- --direction btc-to-arbitrum-usdt --amount 10000
npm run live:prepare -- --direction btc-to-arbitrum-usdt --amount 10000 --out .orchestra-live-state/btc-to-arb.json
npm run live:execute -- --file .orchestra-live-state/btc-to-arb.json --feeRate 12 --confirmationTarget 2 --yes
npm run live:wait -- --file .orchestra-live-state/btc-to-arb.json --timeoutMs 7200000
```

Arbitrum USDT to Bitcoin L1:

```bash
npm run live:quote -- --direction arbitrum-usdt-to-btc --amount 5000000
npm run live:prepare -- --direction arbitrum-usdt-to-btc --amount 5000000 --out .orchestra-live-state/arb-to-btc.json
npm run live:execute -- --file .orchestra-live-state/arb-to-btc.json --yes
npm run live:wait -- --file .orchestra-live-state/arb-to-btc.json --timeoutMs 7200000
```

EVM source tests require native gas on the source account.

## API Surface

```typescript
class Orchestra extends SwidgeProtocol {
  quoteSwidge(options): Promise<SwidgeQuote>
  swidge(options, config?): Promise<SwidgeResult>
  getSwidgeStatus(id, options?): Promise<SwidgeStatusResult>
  getSupportedChains(): Promise<SwidgeSupportedChain[]>
  getSupportedTokens(options?): Promise<SwidgeSupportedToken[]>

  prepareSwap(options, requestOptions?): Promise<OrchestraSwapIntent>
  executeSwapIntent(intentOrState, options?): Promise<OrchestraSwapState>
  submitSourceTx(
    intentOrState,
    sourceTxHash,
    options?
  ): Promise<OrchestraSwapState>
  resumeSwap(state, options?): Promise<OrchestraSwapState | StatusResponse>
  getOrderStatus(target): Promise<StatusResponse>
  waitForCompletion(target, options?): Promise<StatusResponse>
  subscribeOrder(target, callbacks, options?): OrderSubscription
}
```

## Development

```bash
npm install
npm test
npm run lint
npm run build:types
npm pack --dry-run
```

## Support

Use [GitHub Issues](https://github.com/flashnetxyz/orchestra-wdk/issues) for package support. Partner integrations can also use their existing Flashnet partner channel.

## Security

Report vulnerabilities through [GitHub Security Advisories](https://github.com/flashnetxyz/orchestra-wdk/security/advisories/new). Do not open a public issue for a vulnerability. See [SECURITY.md](./SECURITY.md).

## License

Apache-2.0
