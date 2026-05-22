# @flashnet/orchestra-wdk

`@flashnet/orchestra-wdk` is a WDK swap protocol for moving between BTC on Spark, Bitcoin L1, or Lightning and USDT (+ other assets) on Arbitrum, BSC, Ethereum, Optimism, Plasma, Polygon, Solana, TON, and Tron.

It lets a WDK wallet quote, fund, submit, and track Orchestra swaps from the wallet account that already holds the user's funds. WDK owns keys and transaction signing. Orchestra owns quote and order state. The host app owns local persistence.

```
WDK account -> Orchestra protocol -> Flashnet Orchestra API
     |                  |                    |
     | signs payment    | submits tx id      | routes and settles order
     |                  |                    |
     +---- app persists serializable intent -+
```

The package is intentionally small. It does not run a database, store keys, poll chains directly, or hide state transitions from the app.

## USDT Route Coverage

The live route matrix is available at [`/v1/orchestration/routes`](https://orchestration.flashnet.xyz/v1/orchestration/routes). Use it at runtime to decide what to show in a wallet UI.

Current USDT coverage for BTC routes against Ethereum, Tron, Arbitrum, Solana, BSC, Optimism, Plasma, Polygon, TON and many more.

Example route strings:

```javascript
const routeExamples = [
  "spark:BTC -> tron:USDT",
  "bitcoin:BTC -> ton:USDT",
  "lightning:BTC -> ethereum:USDT",
  "bsc:USDT -> spark:BTC",
  "solana:USDT -> lightning:BTC",
  "polygon:USDT -> bitcoin:BTC",
];
```

## Install

```bash
npm install @flashnet/orchestra-wdk @tetherto/wdk-wallet
```

Install the WDK wallet packages for the chains you support:

```bash
npm install @tetherto/wdk @tetherto/wdk-wallet-spark @tetherto/wdk-wallet-btc @tetherto/wdk-wallet-evm
```

## Supported Flow Shape

Use the split flow in production:

1. Quote and reserve a deposit address with `prepareSwap()`.
2. Persist the returned intent before moving funds.
3. Execute the source payment with `executeSwapIntent()`.
4. Persist the submitted state.
5. Track the order with `waitForCompletion()`, `getOrderStatus()`, or SSE.

`saveSwap` and `saveOrderStatus` in these examples are placeholders for your app's durable storage. This package does not export them. Implement them with your own database, encrypted local storage, or backend API before wiring the flow to real funds.

```javascript
const intent = await orchestra.prepareSwap({
  tokenIn: "spark:BTC",
  tokenOut: "tron:USDT",
  tokenInAmount: 7116n,
  to: "TRecipient...",
});

await saveSwap(intent);

const submitted = await orchestra.executeSwapIntent(intent);
await saveSwap(submitted);

const finalStatus = await orchestra.waitForCompletion(submitted, {
  onStatus: async (status) => {
    await saveOrderStatus(status);
  },
});
```

`swap()` exists for WDK surfaces that expect a one-call swap method, but it is disabled by default. Pass `allowOneShot: true` only for local tests or tightly controlled flows where losing the process after broadcast is acceptable.

## Register With WDK

Register one Orchestra protocol per source wallet. Set `sourceChain` explicitly. WDK constructs protocols as `new Protocol(account, config)` and does not pass the registered blockchain label to the protocol constructor.

```javascript
import WDK from "@tetherto/wdk";
import WalletManagerBtc from "@tetherto/wdk-wallet-btc";
import WalletManagerEvm from "@tetherto/wdk-wallet-evm";
import WalletManagerSpark from "@tetherto/wdk-wallet-spark";
import Orchestra from "@flashnet/orchestra-wdk";

const wdk = new WDK(seedPhrase)
  .registerWallet("spark", WalletManagerSpark, {
    network: "MAINNET",
    syncAndRetry: true,
  })
  .registerWallet("bitcoin", WalletManagerBtc, {
    network: "bitcoin",
    client: {
      type: "electrum",
      clientConfig: {
        host: "electrum.blockstream.info",
        port: 50001,
      },
    },
  })
  .registerWallet("arbitrum", WalletManagerEvm, {
    chainId: 42161,
    provider: process.env.ARBITRUM_RPC_URL,
  })
  .registerWallet("bsc", WalletManagerEvm, {
    chainId: 56,
    provider: process.env.BSC_RPC_URL,
  })
  .registerProtocol("spark", "orchestra", Orchestra, {
    sourceChain: "spark",
    apiKey: process.env.FLASHNET_API_KEY,
    baseUrl: "https://orchestration.flashnet.xyz",
  })
  .registerProtocol("bitcoin", "orchestra", Orchestra, {
    sourceChain: "bitcoin",
    apiKey: process.env.FLASHNET_API_KEY,
    baseUrl: "https://orchestration.flashnet.xyz",
  })
  .registerProtocol("arbitrum", "orchestra", Orchestra, {
    sourceChain: "arbitrum",
    apiKey: process.env.FLASHNET_API_KEY,
    baseUrl: "https://orchestration.flashnet.xyz",
    sourceTokenAddresses: {
      "arbitrum:USDT": "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
    },
  })
  .registerProtocol("bsc", "orchestra", Orchestra, {
    sourceChain: "bsc",
    apiKey: process.env.FLASHNET_API_KEY,
    baseUrl: "https://orchestration.flashnet.xyz",
    sourceTokenAddresses: {
      "bsc:USDT": "0x55d398326f99059ff775485246999027b3197955",
    },
  });
```

Get the protocol from the source account:

```javascript
const spark = await wdk.getAccount("spark", 0);
const orchestra = spark.getSwapProtocol("orchestra");
```

## Quote Without Side Effects

`quoteSwap()` calls Orchestra estimate. It does not reserve a deposit address and does not move funds.

```javascript
const quote = await orchestra.quoteSwap({
  tokenIn: "spark:BTC",
  tokenOut: "tron:USDT",
  tokenInAmount: 7116n,
  to: "TRecipient...",
});

console.log(quote.tokenInAmount); // 7116n
console.log(quote.tokenOutAmount); // quoted USDT smallest units
console.log(quote.fee); // fee smallest units for the route fee asset
```

Use smallest units everywhere:

| Asset         | Unit                  |
| ------------- | --------------------- |
| BTC           | sats                  |
| USDT          | 6-decimal token units |
| EVM gas asset | wei                   |

## Spark BTC To USDT

This is the standard Spark sell flow. Spark signs the BTC transfer, Orchestra swaps through its route, and the destination chain receives USDT.

```javascript
const spark = await wdk.getAccount("spark", 0);
const orchestra = spark.getSwapProtocol("orchestra");

const intent = await orchestra.prepareSwap({
  tokenIn: "spark:BTC",
  tokenOut: "tron:USDT",
  tokenInAmount: 7116n,
  to: "TRecipient...",
});

await saveSwap(intent);

const submitted = await orchestra.executeSwapIntent(intent);
await saveSwap(submitted);
```

The submitted state includes the Spark source transfer id, the source wallet's network fee, the Orchestra order id, and a read token when using a scoped client key. `sourceNetworkFee` is reported by WDK when the source payment is sent. Orchestra quote fees remain in `feeAmount`, `totalFeeAmount`, and `feeAsset`.

```javascript
console.log(submitted.sourceTxHash);
console.log(submitted.sourceNetworkFee);
console.log(submitted.orderId);
console.log(submitted.readToken);
```

## USDT To Spark BTC

EVM token sources use WDK `transfer({ token, recipient, amount })`. The source account needs native gas for its chain.

```javascript
const bsc = await wdk.getAccount("bsc", 0);
const spark = await wdk.getAccount("spark", 0);
const orchestra = bsc.getSwapProtocol("orchestra");

const intent = await orchestra.prepareSwap({
  tokenIn: "bsc:USDT",
  tokenOut: "spark:BTC",
  tokenInAmount: 5466162n,
  to: await spark.getAddress(),
});

await saveSwap(intent);

const submitted = await orchestra.executeSwapIntent(intent);
await saveSwap(submitted);
```

Default source token addresses are built in for common USDT routes. Production apps should still pass their own allowlist.

## Bitcoin L1

Bitcoin L1 can be the source or destination.

### L1 BTC Source

```javascript
const bitcoin = await wdk.getAccount("bitcoin", 0);
const spark = await wdk.getAccount("spark", 0);
const orchestra = bitcoin.getSwapProtocol("orchestra");

const intent = await orchestra.prepareSwap({
  tokenIn: "bitcoin:BTC",
  tokenOut: "spark:BTC",
  tokenInAmount: 100000n,
  to: await spark.getAddress(),
});

await saveSwap(intent);

const submitted = await orchestra.executeSwapIntent(intent, {
  feeRate: 12n,
  confirmationTarget: 2,
});
```

For Bitcoin sources, the package submits `bitcoinTxid` to Orchestra. It retries `tx_not_found` and `vout_not_found` submit responses with the same idempotency key because a freshly broadcast Bitcoin transaction may need time to propagate.

### L1 BTC Destination

```javascript
const spark = await wdk.getAccount("spark", 0);
const bitcoin = await wdk.getAccount("bitcoin", 0);
const orchestra = spark.getSwapProtocol("orchestra");

const intent = await orchestra.prepareSwap({
  tokenIn: "spark:BTC",
  tokenOut: "bitcoin:BTC",
  tokenInAmount: 100000n,
  to: await bitcoin.getAddress(),
});
```

Pass `to` for cross-account routes. A protocol registered on a Spark account cannot infer the user's Bitcoin receive address.

## Lightning

Orchestra route support includes `bsc:USDT -> lightning:BTC`, `solana:USDT -> lightning:BTC`, and other USDT-to-Lightning routes. A wallet can pay a BOLT11 invoice or Lightning Address using USDT from a supported chain.

```javascript
const bsc = await wdk.getAccount("bsc", 0);
const orchestra = bsc.getSwapProtocol("orchestra");

const intent = await orchestra.prepareSwap({
  tokenIn: "bsc:USDT",
  tokenOut: "lightning:BTC",
  tokenInAmount: 5000000n,
  to: bolt11Invoice,
  refundChain: "bsc",
  refundAddress: await bsc.getAddress(),
});
```

Current API behavior: Orchestra asks for `refundAddress` on Lightning destinations even though the payment flow does not inherently need one. The package only forwards `refundChain` and `refundAddress`; it does not enforce this rule locally. If the Orchestra API removes the requirement, no package API change is needed.

Lightning source routes, such as `lightning:BTC -> tron:USDT`, are also present. That flow is different from a WDK account send. The user pays an Orchestra Lightning receive invoice, and the app submits the receive request id rather than broadcasting from a WDK wallet account.

## Auth

The package supports backend keys and scoped client keys through `apiKey`.

```javascript
new Orchestra(account, {
  apiKey: process.env.FLASHNET_API_KEY,
  baseUrl: "https://orchestration.flashnet.xyz",
});
```

Scoped client keys receive a `readToken` from `/submit`. The package stores it on the submitted state and uses it for status requests.

```javascript
const submitted = await orchestra.executeSwapIntent(intent);

await orchestra.getOrderStatus({
  orderId: submitted.orderId,
  readToken: submitted.readToken,
});
```

Backend proxy integrations can pass auth headers per request:

```javascript
const orchestra = new Orchestra(account, {
  baseUrl: "https://your-api.example.com/orchestra",
  getAuthHeaders: async () => ({
    Authorization: `Bearer ${await getSessionToken()}`,
  }),
});
```

Direct SSE requires a token in the URL because browser `EventSource` cannot set headers. Admin keys are not used as URL tokens. For admin-key integrations, proxy SSE from your backend or provide a scoped SSE token with `sseToken` or `getSseToken`. Scoped client keys can be used directly when the protocol is configured with `authMode: "client"`.

```javascript
const orchestra = new Orchestra(account, {
  apiKey: process.env.FLASHNET_CLIENT_KEY,
  authMode: "client",
});

const subscription = orchestra.subscribeOrder(submitted, {
  onStatus: (status) => {
    console.log(status);
  },
  onError: (err) => {
    console.error(err);
  },
});

subscription.close();
```

## Persistence And Recovery

The app must persist every state transition that can affect funds.
`saveSwap` below is your implementation. It should write the full state object durably and atomically enough that the app can recover after a process crash, tab close, or mobile app restart.

```javascript
const orchestra = new Orchestra(account, {
  apiKey,
  sourceChain: "spark",
  onStateChange: async (event, state) => {
    await saveSwap(state);
  },
});
```

State transitions:

| Event                    | Meaning                                                                                             |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `intent_created`         | Quote exists and has a deposit address. No source funds moved.                                      |
| `source_payment_started` | The package is about to broadcast or send the source payment. Persist before this callback returns. |
| `source_payment_sent`    | Source payment returned a transaction id.                                                           |
| `submitted`              | Orchestra accepted the source transaction and created or updated the order.                         |

Recovery is driven by the most complete state you have:

```javascript
const next = await orchestra.resumeSwap(savedState);
```

Rules:

- If `orderId` exists, `resumeSwap()` reads order status.
- If `sourceTxHash` exists, `resumeSwap()` submits or re-submits the source transaction id.
- If only the intent exists, `resumeSwap()` refuses to send a fresh payment unless `allowNewSourcePayment: true` is set.

Use `allowNewSourcePayment: true` only after checking wallet history for a prior payment to the quote deposit address.

```javascript
await orchestra.resumeSwap(intentOnlyState, {
  allowNewSourcePayment: true,
});
```

If submit fails after the source payment was sent, the thrown error is `OrchestraSubmitError`. Persist `error.state` before retrying.

```javascript
try {
  const submitted = await orchestra.executeSwapIntent(intent);
  await saveSwap(submitted);
  return submitted;
} catch (err) {
  if (err.name !== "OrchestraSubmitError") throw err;
  await saveSwap(err.state);
  return await orchestra.resumeSwap(err.state);
}
```

## Asset References

Use chain-qualified asset references in app code:

```javascript
tokenIn: "bsc:USDT";
tokenOut: "spark:BTC";
```

Unqualified assets use the protocol `sourceChain`. This is convenient for a protocol registered on one source wallet, but production UI code should prefer explicit chain prefixes.

Spark tokens other than BTC need token identifiers:

```javascript
const orchestra = new Orchestra(sparkAccount, {
  apiKey,
  sourceChain: "spark",
  sparkTokenIdentifiers: {
    USDB: "btkn1...",
  },
});
```

EVM tokens need token contract addresses:

```javascript
const orchestra = new Orchestra(bscAccount, {
  apiKey,
  sourceChain: "bsc",
  sourceTokenAddresses: {
    "bsc:USDT": "0x55d398326f99059ff775485246999027b3197955",
  },
});
```

## Live Test Harness

The repository includes a local harness for funded smoke tests. These commands move mainnet funds by default. The harness uses Arbitrum because the gas cost is low and the WDK EVM wallet works with a public RPC. This is a harness choice, not a route limitation. The supported USDT route matrix is the source of truth.

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
class Orchestra extends SwapProtocol {
  quoteSwap(options): Promise<Omit<SwapResult, "hash">>;
  swap(options): Promise<OrchestraSwapResult>;
  prepareSwap(options, requestOptions?): Promise<OrchestraSwapIntent>;
  executeSwapIntent(intentOrState, options?): Promise<OrchestraSwapState>;
  submitSourceTx(
    intentOrState,
    sourceTxHash,
    options?
  ): Promise<OrchestraSwapState>;
  resumeSwap(state, options?): Promise<OrchestraSwapState | StatusResponse>;
  getOrderStatus(target): Promise<StatusResponse>;
  waitForCompletion(target, options?): Promise<StatusResponse>;
  subscribeOrder(target, callbacks, options?): OrderSubscription;
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

## License

Apache-2.0
