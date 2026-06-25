// Copyright 2026 Flashnet
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

'use strict'

import { SwidgeProtocol } from '@tetherto/wdk-wallet/protocols'

import { normalizeChain, parseAssetRef, stringifyAmount, toBigIntAmount } from './asset-refs.js'
import { OrchestraClient, isTerminalOrderStatus } from './orchestra-client.js'
import { OrchestraStateError, OrchestraSubmitError, OrchestraTimeoutError } from './errors.js'

/** @typedef {import('@tetherto/wdk-wallet').IWalletAccount} IWalletAccount */
/** @typedef {import('@tetherto/wdk-wallet').IWalletAccountReadOnly} IWalletAccountReadOnly */
/** @typedef {import('@tetherto/wdk-wallet/protocols').SwapOptions} SwapOptions */
/** @typedef {import('@tetherto/wdk-wallet/protocols').SwapResult} SwapResult */
/** @typedef {import('@tetherto/wdk-wallet/protocols').SwidgeOptions} SwidgeOptions */
/** @typedef {import('@tetherto/wdk-wallet/protocols').SwidgeQuote} SwidgeQuote */
/** @typedef {import('@tetherto/wdk-wallet/protocols').SwidgeResult} SwidgeResult */
/** @typedef {import('@tetherto/wdk-wallet/protocols').SwidgeProtocolConfig} SwidgeProtocolConfig */
/** @typedef {import('@tetherto/wdk-wallet/protocols').SwidgeStatusResult} SwidgeStatusResult */
/** @typedef {import('@tetherto/wdk-wallet/protocols').SwidgeSupportedChain} SwidgeSupportedChain */
/** @typedef {import('@tetherto/wdk-wallet/protocols').SwidgeSupportedToken} SwidgeSupportedToken */
/** @typedef {import('@tetherto/wdk-wallet/protocols').SwidgeSupportedTokensOptions} SwidgeSupportedTokensOptions */

const INTENT_VERSION = 1
const DEFAULT_POLL_INTERVAL_MS = 1_500
const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60_000
const DEFAULT_QUOTE_EXPIRY_SAFETY_MS = 15_000

const NATIVE_ASSETS = Object.freeze({
  arbitrum: 'ETH',
  avalanche: 'AVAX',
  base: 'ETH',
  bsc: 'BNB',
  ethereum: 'ETH',
  monad: 'MON',
  optimism: 'ETH',
  polygon: 'POL',
  solana: 'SOL',
  tron: 'TRX'
})

const CHAIN_METADATA = Object.freeze({
  arbitrum: { name: 'Arbitrum', type: 'evm', nativeToken: 'ETH' },
  avalanche: { name: 'Avalanche', type: 'evm', nativeToken: 'AVAX' },
  base: { name: 'Base', type: 'evm', nativeToken: 'ETH' },
  bitcoin: { name: 'Bitcoin', type: 'utxo', nativeToken: 'BTC' },
  bsc: { name: 'BNB Smart Chain', type: 'evm', nativeToken: 'BNB' },
  ethereum: { name: 'Ethereum', type: 'evm', nativeToken: 'ETH' },
  lightning: { name: 'Lightning', type: 'lightning', nativeToken: 'BTC' },
  monad: { name: 'Monad', type: 'evm', nativeToken: 'MON' },
  optimism: { name: 'Optimism', type: 'evm', nativeToken: 'ETH' },
  plasma: { name: 'Plasma', type: 'evm', nativeToken: 'XPL' },
  polygon: { name: 'Polygon', type: 'evm', nativeToken: 'POL' },
  solana: { name: 'Solana', type: 'svm', nativeToken: 'SOL' },
  spark: { name: 'Spark', type: 'spark', nativeToken: 'BTC' },
  ton: { name: 'TON', type: 'tvm', nativeToken: 'TON' },
  tron: { name: 'TRON', type: 'tvm', nativeToken: 'TRX' }
})

const TOKEN_DECIMALS = Object.freeze({
  BTC: 8,
  DAI: 18,
  ETH: 18,
  POL: 18,
  USDB: 6,
  USDC: 6,
  'USDC.e': 6,
  USDT: 6
})

const DEFAULT_TOKEN_ADDRESSES = Object.freeze({
  'arbitrum:USDC': '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  'arbitrum:USDT': '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
  'base:USDC': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'bsc:USDC': '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
  'bsc:USDT': '0x55d398326f99059ff775485246999027b3197955',
  'ethereum:DAI': '0x6B175474E89094C44Da98b954EedeAC495271d0F',
  'ethereum:USDC': '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  'ethereum:USDT': '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  'optimism:USDC': '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  'optimism:USDT': '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',
  'polygon:USDC': '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  'polygon:USDC.e': '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
  'polygon:USDT': '0xc2132d05d31c914a87c6611c10748aeb04b58e8f',
  'tron:USDT': 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
})

function randomId () {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return `orchestra-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function nowIso () {
  return new Date().toISOString()
}

function readOrderId (target) {
  if (typeof target === 'string') return target
  return target.orderId ?? target.id
}

function readToken (target) {
  if (typeof target === 'string') return undefined
  return target.readToken
}

function stateAmount (amount, field) {
  return toBigIntAmount(amount, field).toString()
}

function optionalStateAmount (key, amount, field) {
  return amount === undefined || amount === null ? {} : { [key]: stateAmount(amount, field) }
}

function unixSeconds (iso) {
  const timestamp = Date.parse(iso)
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : undefined
}

function basisPoints (amount, inputAmount) {
  return inputAmount > 0n ? (amount * 10_000n) / inputAmount : 0n
}

function slippageToBps (slippage) {
  if (slippage === undefined || slippage === null) return undefined
  if (typeof slippage !== 'number' || !Number.isFinite(slippage) || slippage < 0) {
    throw new OrchestraStateError('slippage must be a non-negative decimal number.')
  }
  return Math.round(slippage * 10_000)
}

function applySlippageBps (amount, slippageBps) {
  if (slippageBps === undefined || slippageBps === null) return amount
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new OrchestraStateError('slippageBps must be an integer between 0 and 10000.')
  }
  return (amount * BigInt(10_000 - slippageBps)) / 10_000n
}

function normalizeSubmittedState (intent, transfer, submit) {
  const sourceNetworkFee = transfer.sourceNetworkFee ?? intent.sourceNetworkFee
  return {
    ...intent,
    sourceTxHash: transfer.sourceTxHash,
    ...optionalStateAmount('sourceNetworkFee', sourceNetworkFee, 'sourceNetworkFee'),
    sourceAddress: transfer.sourceAddress ?? intent.sourceAddress,
    sourceTxVout: transfer.sourceTxVout ?? intent.sourceTxVout,
    orderId: submit.orderId,
    status: submit.status,
    readToken: submit.readToken ?? intent.readToken,
    submittedAt: nowIso()
  }
}

function detectAccountChain (account) {
  const name = account?.constructor?.name?.toLowerCase?.()
  if (!name) return undefined
  if (name.includes('btc') || name.includes('bitcoin')) return 'bitcoin'
  if (name.includes('spark')) return 'spark'
  return undefined
}

function optionalObject (key, value) {
  return value === undefined || value === null ? {} : { [key]: value }
}

function assetKey (chain, asset) {
  return `${normalizeChain(chain)}:${asset}`
}

function readTransferHash (result, operation) {
  if (result && typeof result.hash === 'string' && result.hash.length > 0) {
    return result.hash
  }
  throw new OrchestraStateError(`${operation} returned without a transaction hash.`)
}

function routeStatusToSwidgeStatus (status) {
  if (status === 'completed') return 'completed'
  if (status === 'expired') return 'expired'
  if (status === 'refunded') return 'refunded'
  if (status === 'failed' || status === 'unfulfilled') return 'failed'
  return 'pending'
}

function routeFromParts (sourceChain, sourceAsset, destinationChain, destinationAsset) {
  return {
    sourceChain: normalizeChain(sourceChain),
    sourceAsset,
    destinationChain: normalizeChain(destinationChain),
    destinationAsset
  }
}

export default class Orchestra extends SwidgeProtocol {
  /**
   * Creates a discovery-only interface to Orchestra.
   *
   * @overload
   * @param {undefined} [account]
   * @param {OrchestraConfig} [config]
   */

  /**
   * Creates a new read-only interface to Orchestra.
   *
   * @overload
   * @param {IWalletAccountReadOnly} account
   * @param {OrchestraConfig} [config]
   */

  /**
   * Creates a new interface to Orchestra.
   *
   * @overload
   * @param {IWalletAccount} account
   * @param {OrchestraConfig} [config]
   */
  constructor (account, config = {}) {
    super(account, config)

    this._config = config
    this._client = config.client ?? new OrchestraClient(config)
    this._idempotencyKeyFactory = config.idempotencyKeyFactory ?? randomId
  }

  /**
   * Side-effect-free Swidge quote. This calls Orchestra's estimate endpoint
   * and does not reserve a deposit address.
   *
   * @param {OrchestraSwidgeOptions | SwidgeOptions} options
   * @returns {Promise<SwidgeQuote>}
   */
  async quoteSwidge (options) {
    const params = await this._normalizeSwapOptions(this._fromSwidgeOptions(options))
    const estimate = await this._client.estimate({
      sourceChain: params.sourceChain,
      sourceAsset: params.sourceAsset,
      destinationChain: params.destinationChain,
      destinationAsset: params.destinationAsset,
      amount: params.amount,
      amountMode: params.amountMode,
      recipientAddress: params.recipientAddress,
      slippageBps: params.slippageBps,
      appFees: params.appFees,
      affiliateId: params.affiliateId,
      affiliateIds: params.affiliateIds
    })

    return {
      fromTokenAmount: params.amountMode === 'exact_out'
        ? toBigIntAmount(estimate.requiredAmountIn ?? estimate.amountIn, 'requiredAmountIn')
        : toBigIntAmount(params.amount, 'fromTokenAmount'),
      toTokenAmount: params.amountMode === 'exact_out'
        ? toBigIntAmount(params.amount, 'toTokenAmount')
        : toBigIntAmount(estimate.estimatedOut, 'estimatedOut'),
      toTokenAmountMin: this._minimumToTokenAmount(estimate, params),
      fees: this._quoteFees(estimate, params),
      ...optionalObject('expiry', unixSeconds(estimate.expiresAt))
    }
  }

  /**
   * Executes an Orchestra swidge. Host apps can still use prepareSwap +
   * executeSwapIntent when they want an explicit persistence boundary between
   * quote creation and source payment.
   *
   * @param {OrchestraSwidgeOptions | SwidgeOptions} options
   * @param {SwidgeProtocolConfig & ExecuteSwapOptions} [config]
   * @returns {Promise<SwidgeResult>}
   */
  async swidge (options, config = {}) {
    this._assertWritableAccount()
    const mergedConfig = { ...this._config, ...config }
    const swapOptions = this._fromSwidgeOptions(options)
    const intent = await this.prepareSwap(swapOptions, {
      idempotencyKey: options.idempotencyKey,
      submitIdempotencyKey: options.submitIdempotencyKey
    })
    this._enforceFeeLimits(this._intentFees(intent), toBigIntAmount(intent.amountIn, 'amountIn'), mergedConfig)
    const submitted = await this.executeSwapIntent(intent, { ...options, ...config })
    let fees
    try {
      fees = this._stateFees(submitted)
      this._enforceFeeLimits(fees, toBigIntAmount(submitted.amountIn, 'amountIn'), mergedConfig, {
        requireNetworkFee: true
      })
    } catch (err) {
      throw new OrchestraSubmitError('Post-submit validation failed after Orchestra accepted the source payment.', submitted, err)
    }
    const transactions = submitted.sourceTxHash
      ? [{ hash: submitted.sourceTxHash, chain: submitted.sourceChain, type: 'source' }]
      : undefined
    return {
      id: submitted.orderId,
      hash: submitted.sourceTxHash,
      fees,
      ...optionalObject('transactions', transactions),
      fromTokenAmount: toBigIntAmount(submitted.amountIn, 'amountIn'),
      toTokenAmount: toBigIntAmount(submitted.estimatedOut, 'estimatedOut'),
      toTokenAmountMin: toBigIntAmount(submitted.estimatedOut, 'estimatedOut')
    }
  }

  /**
   * Retrieves the current Swidge status for an Orchestra order id.
   *
   * @param {string} id
   * @param {OrchestraSwidgeStatusOptions} [options]
   * @returns {Promise<SwidgeStatusResult>}
   */
  async getSwidgeStatus (id, options = {}) {
    const status = await this.getOrderStatus({ orderId: id, readToken: options.readToken })
    const order = status.order ?? status
    return {
      status: routeStatusToSwidgeStatus(order.status ?? status.status),
      transactions: this._statusTransactions(status, options)
    }
  }

  /**
   * Returns chains exposed by Orchestra's live route matrix.
   *
   * @returns {Promise<SwidgeSupportedChain[]>}
   */
  async getSupportedChains () {
    const routes = await this._routes()
    const chains = new Set()
    for (const route of routes) {
      if (route.sourceChain) chains.add(normalizeChain(route.sourceChain))
      if (route.destinationChain) chains.add(normalizeChain(route.destinationChain))
    }
    return [...chains].sort().map(chain => ({
      id: chain,
      name: CHAIN_METADATA[chain]?.name ?? chain,
      type: CHAIN_METADATA[chain]?.type ?? 'unknown',
      nativeToken: CHAIN_METADATA[chain]?.nativeToken ?? NATIVE_ASSETS[chain] ?? ''
    }))
  }

  /**
   * Returns tokens exposed by Orchestra's live route matrix.
   *
   * @param {SwidgeSupportedTokensOptions} [options]
   * @returns {Promise<SwidgeSupportedToken[]>}
   */
  async getSupportedTokens (options = {}) {
    const routes = await this._routes()
    const fromChain = normalizeChain(options.fromChain)
    const toChain = normalizeChain(options.toChain)
    const fromToken = options.fromToken
    const seen = new Set()
    const tokens = []
    const push = (chain, symbol) => {
      const normalizedChain = normalizeChain(chain)
      const key = `${normalizedChain}:${symbol}`
      if (!normalizedChain || !symbol || seen.has(key)) return
      seen.add(key)
      tokens.push({
        token: `${normalizedChain}:${symbol}`,
        chain: normalizedChain,
        symbol,
        decimals: this._tokenDecimals(normalizedChain, symbol),
        ...optionalObject('address', this._resolveSourceTokenAddress(normalizedChain, symbol))
      })
    }
    for (const route of routes) {
      const source = routeFromParts(route.sourceChain, route.sourceAsset, route.destinationChain, route.destinationAsset)
      if (fromChain && source.sourceChain !== fromChain) continue
      if (toChain && source.destinationChain !== toChain) continue
      if (fromToken) {
        const parsed = parseAssetRef(fromToken, source.sourceChain)
        if (source.sourceChain !== parsed.chain || source.sourceAsset !== parsed.asset) continue
      }
      push(source.sourceChain, source.sourceAsset)
      push(source.destinationChain, source.destinationAsset)
    }
    return tokens
  }

  /**
   * Creates a durable Orchestra quote and returns a serializable intent. Persist
   * this object before calling executeSwapIntent.
   *
   * @param {OrchestraSwapOptions | OrchestraSwidgeOptions | SwidgeOptions} options
   * @param {PrepareSwapOptions} [requestOptions]
   * @returns {Promise<OrchestraSwapIntent>}
   */
  async prepareSwap (options, requestOptions = {}) {
    const params = await this._normalizeSwapOptions(this._fromSwidgeOptions(options))
    const quoteIdempotencyKey = requestOptions.idempotencyKey ?? this._idempotencyKeyFactory()
    const submitIdempotencyKey = requestOptions.submitIdempotencyKey ?? this._idempotencyKeyFactory()
    const quote = await this._client.createQuote({
      sourceChain: params.sourceChain,
      sourceAsset: params.sourceAsset,
      destinationChain: params.destinationChain,
      destinationAsset: params.destinationAsset,
      amount: params.amount,
      amountMode: params.amountMode,
      recipientAddress: params.recipientAddress,
      refundChain: params.refundChain,
      refundAddress: params.refundAddress,
      slippageBps: params.slippageBps,
      appFees: params.appFees,
      affiliateId: params.affiliateId,
      affiliateIds: params.affiliateIds
    }, { idempotencyKey: quoteIdempotencyKey })

    const intent = {
      version: INTENT_VERSION,
      quoteId: quote.quoteId,
      sourceChain: params.sourceChain,
      sourceAsset: params.sourceAsset,
      destinationChain: params.destinationChain,
      destinationAsset: params.destinationAsset,
      recipientAddress: params.recipientAddress,
      refundChain: params.refundChain,
      refundAddress: params.refundAddress,
      amountMode: quote.amountMode ?? params.amountMode,
      amountIn: quote.amountIn,
      estimatedOut: quote.estimatedOut,
      depositAddress: quote.depositAddress,
      feeAmount: quote.feeAmount,
      totalFeeAmount: quote.totalFeeAmount,
      feeAsset: quote.feeAsset,
      route: quote.route,
      expiresAt: quote.expiresAt,
      sourceTokenIdentifier: params.sourceTokenIdentifier,
      sourceTokenAddress: params.sourceTokenAddress,
      quoteIdempotencyKey,
      submitIdempotencyKey,
      createdAt: nowIso()
    }

    await this._config.onIntent?.(intent)
    await this._emitState('intent_created', intent)
    return intent
  }

  /**
   * Sends the source payment and submits the resulting transfer id to
   * Orchestra. If submit fails after the source transfer, the thrown error
   * includes `error.state.sourceTxHash` so the app can resume.
   *
   * @param {OrchestraSwapIntent | OrchestraSwapState} intent
   * @param {ExecuteSwapOptions} [options]
   * @returns {Promise<OrchestraSwapState>}
   */
  async executeSwapIntent (intent, options = {}) {
    this._assertIntent(intent)
    if (!options.sourceTxHash && !intent.sourceTxHash) {
      this._assertWritableAccount()
    }
    const transfer = await this._resolveSourceTransfer(intent, options)
    const sourceNetworkFee = transfer.sourceNetworkFee ?? intent.sourceNetworkFee

    const fundedState = {
      ...intent,
      sourceTxHash: transfer.sourceTxHash,
      ...optionalStateAmount('sourceNetworkFee', sourceNetworkFee, 'sourceNetworkFee'),
      sourceAddress: transfer.sourceAddress ?? intent.sourceAddress,
      sourceTxVout: transfer.sourceTxVout ?? intent.sourceTxVout,
      sourcePaymentStartedAt: transfer.sourcePaymentStartedAt ?? intent.sourcePaymentStartedAt,
      fundedAt: intent.fundedAt ?? nowIso()
    }

    try {
      await this._emitState('source_payment_sent', fundedState)
      const submit = await this._submitTransfer(fundedState, transfer.sourceTxHash, options)
      const submittedState = normalizeSubmittedState(fundedState, transfer, submit)
      try {
        await this._emitState('submitted', submittedState)
      } catch (err) {
        throw new OrchestraSubmitError('State persistence failed after Orchestra accepted the source payment.', submittedState, err)
      }
      return submittedState
    } catch (err) {
      if (err instanceof OrchestraSubmitError) throw err
      throw new OrchestraSubmitError('Orchestra submit failed after the source payment was sent.', fundedState, err)
    }
  }

  async submitSourceTx (intent, sourceTxHash, options = {}) {
    this._assertIntent(intent)
    const submit = await this._submitTransfer(intent, sourceTxHash, options)
    return normalizeSubmittedState(intent, {
      sourceTxHash,
      sourceNetworkFee: options.sourceNetworkFee ?? intent.sourceNetworkFee,
      sourceAddress: options.sourceSparkAddress ?? options.sourceAddress ?? intent.sourceAddress,
      sourceTxVout: options.sourceTxVout ?? intent.sourceTxVout
    }, submit)
  }

  async _resolveSourceTransfer (intent, options) {
    if (options.sourceTxHash) {
      return {
        sourceTxHash: options.sourceTxHash,
        sourceNetworkFee: options.sourceNetworkFee,
        sourceAddress: options.sourceSparkAddress ?? options.sourceAddress,
        sourceTxVout: options.sourceTxVout
      }
    }
    if (intent.sourceTxHash) {
      return {
        sourceTxHash: intent.sourceTxHash,
        sourceNetworkFee: intent.sourceNetworkFee,
        sourceAddress: intent.sourceAddress,
        sourceTxVout: intent.sourceTxVout
      }
    }
    return await this._startAndSendSourcePayment(intent, options)
  }

  async resumeSwap (state, options = {}) {
    if (state.orderId) {
      return await this.getOrderStatus(state)
    }
    if (state.sourceTxHash || options.sourceTxHash) {
      return await this.submitSourceTx(state, options.sourceTxHash ?? state.sourceTxHash, options)
    }
    if (options.allowNewSourcePayment !== true) {
      throw new OrchestraStateError('Refusing to send a fresh source payment from resumeSwap(). Pass allowNewSourcePayment: true only after confirming no prior source payment was broadcast.')
    }
    return await this.executeSwapIntent(state, options)
  }

  async getOrderStatus (target) {
    const orderId = readOrderId(target)
    if (orderId) {
      return await this._client.getStatus({ id: orderId }, { readToken: readToken(target) })
    }
    if (target.quoteId) {
      return await this._client.getStatus({ quoteId: target.quoteId }, { readToken: readToken(target) })
    }
    if (target.sourceTxHash) {
      return await this._client.getStatus({
        txHash: target.sourceTxHash,
        sourceChain: normalizeChain(target.sourceChain) ?? this._defaultSourceChain()
      }, { readToken: readToken(target) })
    }
    throw new OrchestraStateError('Order status requires orderId, quoteId, or sourceTxHash.')
  }

  async waitForCompletion (target, options = {}) {
    const startedAt = Date.now()
    const timeoutMs = options.timeoutMs ?? this._config.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
    const pollIntervalMs = options.pollIntervalMs ?? this._config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS

    while (true) {
      const status = await this.getOrderStatus(target)
      await options.onStatus?.(status)
      await this._config.onOrderStatus?.(status)
      const orderStatus = status.order?.status ?? status.status
      if (isTerminalOrderStatus(orderStatus)) return status
      if (Date.now() - startedAt > timeoutMs) {
        throw new OrchestraTimeoutError(`Timed out waiting for Orchestra order after ${timeoutMs}ms.`, { target })
      }
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
    }
  }

  subscribeOrder (target, callbacks, options = {}) {
    const orderId = readOrderId(target)
    if (!orderId) throw new OrchestraStateError('SSE subscription requires an orderId.')
    return this._client.subscribeStatus(orderId, callbacks, {
      ...options,
      readToken: options.readToken ?? readToken(target)
    })
  }

  _fromSwidgeOptions (options) {
    if (!options.fromToken && !options.toToken) return options
    const sourceChain = normalizeChain(options.fromChain) ?? this._defaultSourceChain()
    const source = parseAssetRef(options.fromToken, sourceChain)
    const destinationChain = normalizeChain(options.toChain) ?? source.chain
    const destination = parseAssetRef(options.toToken, destinationChain)
    if (options.fromTokenAmount !== undefined && options.toTokenAmount !== undefined) {
      throw new OrchestraStateError('Specify only one of fromTokenAmount or toTokenAmount.')
    }
    return {
      ...options,
      tokenIn: `${source.chain}:${source.asset}`,
      tokenOut: `${destination.chain}:${destination.asset}`,
      tokenInAmount: options.fromTokenAmount,
      tokenOutAmount: options.toTokenAmount,
      to: options.recipient,
      refundChain: options.refundChain ?? source.chain,
      refundAddress: options.refundAddress,
      slippageBps: options.slippageBps ?? slippageToBps(options.slippage)
    }
  }

  _minimumToTokenAmount (quote, params) {
    if (params.amountMode === 'exact_out') return toBigIntAmount(params.amount, 'toTokenAmount')
    const quotedMinimum = quote.minAmountOut ??
      quote.minimumOut ??
      quote.minOut ??
      quote.guaranteedOut
    if (quotedMinimum !== undefined && quotedMinimum !== null) {
      return toBigIntAmount(quotedMinimum, 'toTokenAmountMin')
    }
    return applySlippageBps(toBigIntAmount(quote.estimatedOut, 'estimatedOut'), params.slippageBps)
  }

  _quoteFees (quote, params) {
    return [{
      type: 'protocol',
      amount: toBigIntAmount(quote.totalFeeAmount ?? quote.feeAmount ?? 0n, 'feeAmount'),
      token: quote.feeAsset ?? params.sourceAsset,
      included: true,
      description: 'Orchestra protocol fee'
    }]
  }

  _intentFees (intent) {
    return [{
      type: 'protocol',
      amount: toBigIntAmount(intent.totalFeeAmount ?? intent.feeAmount ?? 0n, 'feeAmount'),
      token: intent.feeAsset ?? intent.sourceAsset,
      included: true,
      description: 'Orchestra protocol fee'
    }]
  }

  _stateFees (state) {
    const sourceFee = state.sourceNetworkFee === undefined || state.sourceNetworkFee === null
      ? []
      : [{
          type: 'network',
          amount: toBigIntAmount(state.sourceNetworkFee, 'sourceNetworkFee'),
          token: CHAIN_METADATA[state.sourceChain]?.nativeToken ?? state.sourceAsset,
          chain: state.sourceChain,
          included: false,
          description: 'Source wallet network fee'
        }]
    return [
      ...sourceFee,
      ...this._intentFees(state)
    ]
  }

  _enforceFeeLimits (fees, inputAmount, config, options = {}) {
    const networkFees = fees.filter(fee => fee.type === 'network')
    if (options.requireNetworkFee && config.maxNetworkFeeBps !== undefined && config.maxNetworkFeeBps !== null && networkFees.length === 0) {
      throw new OrchestraStateError('Source network fee is required to enforce maxNetworkFeeBps.', {
        feeType: 'network',
        maxFeeBps: String(config.maxNetworkFeeBps)
      })
    }
    this._enforceFeeLimit(
      networkFees.reduce((total, fee) => total + fee.amount, 0n),
      inputAmount,
      config.maxNetworkFeeBps,
      'network'
    )
    this._enforceFeeLimit(
      fees.filter(fee => fee.type === 'protocol').reduce((total, fee) => total + fee.amount, 0n),
      inputAmount,
      config.maxProtocolFeeBps,
      'protocol'
    )
  }

  _enforceFeeLimit (feeAmount, inputAmount, maxBps, feeType) {
    if (maxBps === undefined || maxBps === null) return
    if (
      (typeof maxBps === 'number' && (!Number.isInteger(maxBps) || maxBps < 0)) ||
      (typeof maxBps === 'bigint' && maxBps < 0n) ||
      (typeof maxBps !== 'number' && typeof maxBps !== 'bigint')
    ) {
      throw new OrchestraStateError(`max${feeType[0].toUpperCase()}${feeType.slice(1)}FeeBps must be a non-negative integer.`)
    }
    const max = BigInt(maxBps)
    const actual = basisPoints(feeAmount, inputAmount)
    if (actual > max) {
      throw new OrchestraStateError(`Orchestra ${feeType} fee exceeds configured maximum.`, {
        feeType,
        feeBps: actual.toString(),
        maxFeeBps: max.toString()
      })
    }
  }

  async _routes () {
    const body = await this._client.getRoutes()
    return Array.isArray(body.routes) ? body.routes : []
  }

  _tokenDecimals (chain, symbol) {
    return this._config.tokenDecimals?.[`${normalizeChain(chain)}:${symbol}`] ??
      this._config.tokenDecimals?.[symbol] ??
      TOKEN_DECIMALS[symbol] ??
      0
  }

  _statusTransactions (status, options) {
    const order = status.order ?? status
    const transactions = []
    const sourceHash = order.sourceTxHash ?? order.txHash ?? order.depositTxHash ?? status.sourceTxHash
    const destinationHash = order.destinationTxHash ?? order.payoutTxHash ?? order.withdrawTxHash ?? status.destinationTxHash
    const refundHash = order.refundTxHash ?? status.refundTxHash
    const sourceChain = options.fromChain ?? order.sourceChain
    const destinationChain = options.toChain ?? order.destinationChain
    if (sourceHash) transactions.push({ hash: sourceHash, ...optionalObject('chain', sourceChain), type: 'source' })
    if (destinationHash) transactions.push({ hash: destinationHash, ...optionalObject('chain', destinationChain), type: 'destination' })
    if (refundHash) transactions.push({ hash: refundHash, ...optionalObject('chain', sourceChain), type: 'refund' })
    return transactions
  }

  _assertWritableAccount () {
    if (!this._account || (typeof this._account.sendTransaction !== 'function' && typeof this._account.transfer !== 'function')) {
      throw new OrchestraStateError('A writable WDK account is required to execute Orchestra swidge operations.')
    }
  }

  async _normalizeSwapOptions (options) {
    const tokenInRef = options.source
      ? `${options.source.chain}:${options.source.asset}`
      : options.sourceChain && options.sourceAsset
        ? `${options.sourceChain}:${options.sourceAsset}`
        : options.tokenIn
    const tokenOutRef = options.destination
      ? `${options.destination.chain}:${options.destination.asset}`
      : options.destinationChain && options.destinationAsset
        ? `${options.destinationChain}:${options.destinationAsset}`
        : options.tokenOut

    const source = parseAssetRef(tokenInRef, this._defaultSourceChain())
    const destination = parseAssetRef(tokenOutRef, options.destinationChain)
    if (source.chain === 'bitcoin' && source.asset !== 'BTC') {
      throw new OrchestraStateError('Bitcoin source swaps only support BTC.')
    }
    if (options.tokenInAmount !== undefined && options.tokenOutAmount !== undefined) {
      throw new OrchestraStateError('Specify only one of tokenInAmount or tokenOutAmount.')
    }

    const amountMode = options.amountMode ?? (options.tokenOutAmount !== undefined ? 'exact_out' : 'exact_in')
    if (amountMode !== 'exact_in' && amountMode !== 'exact_out') {
      throw new OrchestraStateError("amountMode must be 'exact_in' or 'exact_out'.")
    }
    const amount = amountMode === 'exact_out'
      ? stringifyAmount(options.tokenOutAmount ?? options.amount, 'tokenOutAmount')
      : stringifyAmount(options.tokenInAmount ?? options.amount, 'tokenInAmount')
    const recipientAddress = options.recipientAddress ??
      options.destination?.address ??
      options.to ??
      await this._defaultRecipientAddress(destination.chain)
    if (!recipientAddress) {
      throw new OrchestraStateError('recipientAddress or to is required when the destination is not this WDK account.')
    }

    return {
      sourceChain: source.chain,
      sourceAsset: source.asset,
      destinationChain: destination.chain,
      destinationAsset: destination.asset,
      recipientAddress,
      amountMode,
      amount,
      refundChain: options.refundChain,
      refundAddress: options.refundAddress,
      slippageBps: options.slippageBps ?? this._config.slippageBps,
      appFees: options.appFees,
      affiliateId: options.affiliateId,
      affiliateIds: options.affiliateIds,
      sourceTokenIdentifier: source.chain === 'spark'
        ? options.sourceTokenIdentifier ?? this._resolveSparkTokenIdentifier(source.asset)
        : undefined,
      sourceTokenAddress: source.chain !== 'spark' && !this._isNativeAsset(source.chain, source.asset)
        ? options.sourceTokenAddress ?? this._resolveSourceTokenAddress(source.chain, source.asset)
        : undefined
    }
  }

  _defaultSourceChain () {
    return normalizeChain(
      this._config.sourceChain ??
      this._config.defaultSourceChain ??
      this._config.chain
    ) ?? detectAccountChain(this._account)
  }

  async _defaultRecipientAddress (destinationChain) {
    if (!this._account) return undefined
    if (normalizeChain(destinationChain) !== this._defaultSourceChain()) return undefined
    return await this._account.getAddress()
  }

  _resolveSparkTokenIdentifier (sourceAsset) {
    if (sourceAsset === 'BTC') return undefined
    return this._config.sparkTokenIdentifiers?.[sourceAsset] ??
      this._config.tokenIdentifiers?.[sourceAsset]
  }

  _resolveSourceTokenAddress (sourceChain, sourceAsset) {
    const key = assetKey(sourceChain, sourceAsset)
    return this._config.sourceTokenAddresses?.[key] ??
      this._config.tokenAddresses?.[key] ??
      this._config.assetAddresses?.[key] ??
      DEFAULT_TOKEN_ADDRESSES[key]
  }

  _isNativeAsset (sourceChain, sourceAsset) {
    return this._config.nativeAssets?.[normalizeChain(sourceChain)] === sourceAsset ||
      NATIVE_ASSETS[normalizeChain(sourceChain)] === sourceAsset
  }

  async _sendSourcePayment (intent, options) {
    if (intent.sourceChain === 'bitcoin') return await this._sendBitcoinPayment(intent, options)
    if (intent.sourceChain === 'spark') return await this._sendSparkPayment(intent, options)
    return await this._sendAccountPayment(intent, options)
  }

  async _startAndSendSourcePayment (intent, options) {
    this._assertCanSendSourcePayment(intent, options)
    if (intent.sourcePaymentStartedAt && options.allowNewSourcePayment !== true) {
      throw new OrchestraStateError('Source payment may already have been started. Pass sourceTxHash if known, or allowNewSourcePayment: true only after wallet-history recovery.')
    }
    const startedState = {
      ...intent,
      sourcePaymentStartedAt: intent.sourcePaymentStartedAt ?? nowIso()
    }
    await this._emitState('source_payment_started', startedState)
    const transfer = await this._sendSourcePayment(startedState, options)
    return {
      ...transfer,
      sourcePaymentStartedAt: startedState.sourcePaymentStartedAt
    }
  }

  _assertCanSendSourcePayment (intent, options) {
    if (!intent.expiresAt || options.ignoreQuoteExpiry === true) return
    const expiresAt = Date.parse(intent.expiresAt)
    if (!Number.isFinite(expiresAt)) {
      throw new OrchestraStateError('Quote expiresAt must be a valid ISO timestamp before moving funds.')
    }
    const safetyMs = options.quoteExpirySafetyMs ?? this._config.quoteExpirySafetyMs ?? DEFAULT_QUOTE_EXPIRY_SAFETY_MS
    if (Date.now() + safetyMs >= expiresAt) {
      throw new OrchestraStateError('Quote is expired or too close to expiry to safely send a new source payment.', {
        expiresAt: intent.expiresAt,
        quoteExpirySafetyMs: safetyMs
      })
    }
  }

  async _sendBitcoinPayment (intent, options) {
    if (intent.sourceAsset !== 'BTC') {
      throw new OrchestraStateError('Bitcoin source swaps only support BTC.')
    }
    if (typeof this._account.sendTransaction !== 'function') {
      throw new OrchestraStateError('A writable Bitcoin account is required to send BTC.')
    }
    const sourceAddress = await this._account.getAddress()
    const tx = {
      to: intent.depositAddress,
      value: BigInt(intent.amountIn),
      ...optionalObject('feeRate', options.feeRate),
      ...optionalObject('confirmationTarget', options.confirmationTarget)
    }
    const result = await this._account.sendTransaction(tx, options.broadcastTimeoutMs)
    const sourceTxHash = readTransferHash(result, 'Bitcoin sendTransaction')
    return {
      sourceTxHash,
      sourceNetworkFee: result.fee,
      sourceAddress
    }
  }

  async _sendSparkPayment (intent, options) {
    const sourceAddress = await this._account.getAddress()
    if (intent.sourceAsset === 'BTC') {
      if (typeof this._account.sendTransaction !== 'function') {
        throw new OrchestraStateError('A writable Spark account is required to send BTC.')
      }
      const result = await this._account.sendTransaction({
        to: intent.depositAddress,
        value: BigInt(intent.amountIn)
      })
      return { sourceTxHash: readTransferHash(result, 'Spark sendTransaction'), sourceNetworkFee: result.fee, sourceAddress }
    }

    if (typeof this._account.transfer !== 'function') {
      throw new OrchestraStateError(`A writable Spark account is required to send ${intent.sourceAsset}.`)
    }
    const token = options.sourceTokenIdentifier ??
      intent.sourceTokenIdentifier ??
      this._resolveSparkTokenIdentifier(intent.sourceAsset)
    if (!token) {
      throw new OrchestraStateError(`Spark token identifier is required for ${intent.sourceAsset}.`, { sourceAsset: intent.sourceAsset })
    }
    const result = await this._account.transfer({
      token,
      recipient: intent.depositAddress,
      amount: BigInt(intent.amountIn)
    })
    return { sourceTxHash: readTransferHash(result, 'Spark transfer'), sourceNetworkFee: result.fee, sourceAddress }
  }

  async _sendAccountPayment (intent, options) {
    const sourceAddress = await this._account.getAddress()
    if (this._isNativeAsset(intent.sourceChain, intent.sourceAsset)) {
      if (typeof this._account.sendTransaction !== 'function') {
        throw new OrchestraStateError(`A writable ${intent.sourceChain} account is required to send ${intent.sourceAsset}.`)
      }
      const result = await this._account.sendTransaction({
        to: intent.depositAddress,
        value: BigInt(intent.amountIn)
      })
      return { sourceTxHash: readTransferHash(result, `${intent.sourceChain} sendTransaction`), sourceNetworkFee: result.fee, sourceAddress }
    }

    if (typeof this._account.transfer !== 'function') {
      throw new OrchestraStateError(`A writable ${intent.sourceChain} account is required to send ${intent.sourceAsset}.`)
    }
    const token = options.sourceTokenAddress ?? intent.sourceTokenAddress ??
      this._resolveSourceTokenAddress(intent.sourceChain, intent.sourceAsset)
    if (!token) {
      throw new OrchestraStateError(`Token address is required for ${intent.sourceChain}:${intent.sourceAsset}.`, {
        sourceChain: intent.sourceChain,
        sourceAsset: intent.sourceAsset
      })
    }
    const result = await this._account.transfer({
      token,
      recipient: intent.depositAddress,
      amount: BigInt(intent.amountIn)
    })
    return { sourceTxHash: readTransferHash(result, `${intent.sourceChain} transfer`), sourceNetworkFee: result.fee, sourceAddress }
  }

  async _submitTransfer (intent, sourceTxHash, options) {
    return await this._client.submit(await this._submitBody(intent, sourceTxHash, options), {
      idempotencyKey: options.submitIdempotencyKey ?? intent.submitIdempotencyKey ?? this._idempotencyKeyFactory()
    })
  }

  async _submitBody (intent, sourceTxHash, options) {
    if (intent.sourceChain === 'spark') {
      const sourceSparkAddress = options.sourceSparkAddress ??
        options.sourceAddress ??
        intent.sourceAddress ??
        await this._account?.getAddress?.()
      if (!sourceSparkAddress) {
        throw new OrchestraStateError('Spark submit requires sourceSparkAddress, sourceAddress, intent.sourceAddress, or an account with getAddress().')
      }
      return {
        quoteId: intent.quoteId,
        sparkTxHash: sourceTxHash,
        sourceSparkAddress
      }
    }
    if (intent.sourceChain === 'bitcoin') {
      return {
        quoteId: intent.quoteId,
        bitcoinTxid: sourceTxHash,
        ...optionalObject('sourceAddress', options.sourceAddress ?? intent.sourceAddress),
        ...optionalObject('bitcoinVout', options.sourceTxVout ?? intent.sourceTxVout)
      }
    }
    return {
      quoteId: intent.quoteId,
      txHash: sourceTxHash,
      ...optionalObject('sourceAddress', options.sourceAddress ?? intent.sourceAddress)
    }
  }

  _assertIntent (intent) {
    if (!intent || intent.version !== INTENT_VERSION || !intent.quoteId || !intent.depositAddress || !intent.amountIn) {
      throw new OrchestraStateError('Invalid Orchestra swap intent.')
    }
  }

  async _emitState (event, state) {
    await this._config.onStateChange?.(event, state)
  }
}

/**
 * @typedef {Object} OrchestraConfig
 * @property {string} [apiKey] Admin API key, backend key, or scoped client key.
 * @property {string} [baseUrl]
 * @property {typeof fetch} [fetch]
 * @property {() => (Record<string, string> | Headers | Promise<Record<string, string> | Headers>)} [getAuthHeaders]
 * @property {string} [sseToken]
 * @property {() => (string | Promise<string>)} [getSseToken]
 * @property {'admin' | 'client' | 'auto'} [authMode]
 * @property {'spark' | 'bitcoin' | string} [sourceChain] Default source chain for unprefixed tokenIn values.
 * @property {'spark' | 'bitcoin' | string} [defaultSourceChain] Alias for sourceChain.
 * @property {'spark' | 'bitcoin' | string} [chain] Alias for sourceChain.
 * @property {Record<string, string>} [sparkTokenIdentifiers] Spark token identifiers keyed by Orchestra asset symbol.
 * @property {Record<string, string>} [tokenIdentifiers] Alias for sparkTokenIdentifiers.
 * @property {Record<string, string>} [sourceTokenAddresses] Token addresses keyed by '<chain>:<asset>'.
 * @property {Record<string, string>} [tokenAddresses] Alias for sourceTokenAddresses.
 * @property {Record<string, string>} [assetAddresses] Alias for sourceTokenAddresses.
 * @property {Record<string, string>} [nativeAssets] Native asset symbols keyed by chain.
 * @property {Record<string, number>} [tokenDecimals] Token decimals keyed by '<chain>:<asset>' or asset symbol.
 * @property {number} [slippageBps]
 * @property {number | bigint} [maxNetworkFeeBps]
 * @property {number | bigint} [maxProtocolFeeBps]
 * @property {number} [timeoutMs]
 * @property {number} [maxRetries]
 * @property {number} [retryDelayMs]
 * @property {number} [submitMaxRetries]
 * @property {number} [submitRetryDelayMs]
 * @property {number} [quoteExpirySafetyMs]
 * @property {number} [pollIntervalMs]
 * @property {number} [waitTimeoutMs]
 * @property {() => string} [idempotencyKeyFactory]
 * @property {(intent: OrchestraSwapIntent) => void | Promise<void>} [onIntent]
 * @property {(event: string, state: OrchestraSwapIntent | OrchestraSwapState) => void | Promise<void>} [onStateChange]
 * @property {(status: Object) => void | Promise<void>} [onOrderStatus]
 * @property {OrchestraClient} [client]
 */

/**
 * @typedef {SwapOptions & Object} OrchestraSwapOptions
 * @property {{ chain: string, asset: string }} [source]
 * @property {{ chain: string, asset: string, address?: string }} [destination]
 * @property {string} [sourceChain]
 * @property {string} [sourceAsset]
 * @property {string} [destinationChain]
 * @property {string} [destinationAsset]
 * @property {string} [recipientAddress]
 * @property {string} [refundChain]
 * @property {string} [refundAddress]
 * @property {'exact_in' | 'exact_out'} [amountMode]
 * @property {number | bigint | string} [amount]
 * @property {number} [slippageBps]
 * @property {string} [sourceTokenIdentifier]
 * @property {string} [sourceTokenAddress]
 * @property {Array<{ recipient: string, fee: number }>} [appFees]
 * @property {string} [affiliateId]
 * @property {string[]} [affiliateIds]
 */

/**
 * @typedef {SwidgeOptions & Object} OrchestraSwidgeOptions
 * @property {string | number} [fromChain]
 * @property {string} [refundChain]
 * @property {number} [slippageBps]
 * @property {string} [idempotencyKey]
 * @property {string} [submitIdempotencyKey]
 * @property {string} [sourceTxHash]
 * @property {bigint | number | string} [sourceNetworkFee]
 * @property {string} [sourceAddress]
 * @property {number} [sourceTxVout]
 * @property {string} [sourceSparkAddress]
 * @property {string} [sourceTokenIdentifier]
 * @property {string} [sourceTokenAddress]
 * @property {number | bigint} [feeRate]
 * @property {number} [confirmationTarget]
 * @property {number} [broadcastTimeoutMs]
 * @property {boolean} [allowNewSourcePayment]
 * @property {boolean} [ignoreQuoteExpiry]
 * @property {number} [quoteExpirySafetyMs]
 * @property {Array<{ recipient: string, fee: number }>} [appFees]
 * @property {string} [affiliateId]
 * @property {string[]} [affiliateIds]
 */

/**
 * @typedef {Object} OrchestraSwidgeStatusOptions
 * @property {string | number} [fromChain]
 * @property {string | number} [toChain]
 * @property {string} [readToken]
 */

/**
 * @typedef {Object} PrepareSwapOptions
 * @property {string} [idempotencyKey]
 * @property {string} [submitIdempotencyKey]
 */

/**
 * @typedef {Object} ExecuteSwapOptions
 * @property {string} [sourceTxHash]
 * @property {bigint | number | string} [sourceNetworkFee]
 * @property {string} [sourceAddress]
 * @property {number} [sourceTxVout]
 * @property {string} [sourceSparkAddress]
 * @property {string} [sourceTokenIdentifier]
 * @property {string} [sourceTokenAddress]
 * @property {number | bigint} [feeRate]
 * @property {number} [confirmationTarget]
 * @property {number} [broadcastTimeoutMs]
 * @property {string} [submitIdempotencyKey]
 * @property {boolean} [allowNewSourcePayment]
 * @property {boolean} [ignoreQuoteExpiry]
 * @property {number} [quoteExpirySafetyMs]
 */

/**
 * @typedef {Object} OrchestraSwapIntent
 * @property {1} version
 * @property {string} quoteId
 * @property {string} sourceChain
 * @property {string} sourceAsset
 * @property {string} destinationChain
 * @property {string} destinationAsset
 * @property {string} recipientAddress
 * @property {'exact_in' | 'exact_out'} amountMode
 * @property {string} amountIn
 * @property {string} estimatedOut
 * @property {string} depositAddress
 * @property {string} expiresAt
 * @property {string} [sourceTokenAddress]
 * @property {string} [sourceAddress]
 * @property {number} [sourceTxVout]
 * @property {string} quoteIdempotencyKey
 * @property {string} submitIdempotencyKey
 * @property {string} [sourcePaymentStartedAt]
 */

/**
 * @typedef {OrchestraSwapIntent & Object} OrchestraSwapState
 * @property {string} [sourceTxHash]
 * @property {string} [sourceNetworkFee]
 * @property {string} [orderId]
 * @property {string} [status]
 * @property {string} [readToken]
 * @property {string} [sourcePaymentStartedAt]
 */

/**
 * @typedef {SwapResult & Object} OrchestraSwapResult
 * @property {string} quoteId
 * @property {string} orderId
 * @property {string} status
 * @property {string} [readToken]
 */
