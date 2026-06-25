import { beforeEach, describe, expect, jest, test } from '@jest/globals'
import { SwidgeProtocol } from '@tetherto/wdk-wallet/protocols'

import Orchestra, {
  OrchestraApiError,
  OrchestraClient,
  OrchestraStateError,
  OrchestraSubmitError
} from '../index.js'

const QUOTE = {
  quoteId: 'quo_123',
  depositAddress: 'sp1deposit',
  amountIn: '1000',
  estimatedOut: '990000',
  feeAmount: '5',
  totalFeeAmount: '10',
  feeAsset: 'USDC',
  route: ['BTC->USDB', 'USDB->USDC', 'USDC->USDT'],
  expiresAt: '2099-01-01T00:00:00.000Z',
  amountMode: 'exact_in'
}

const SUBMIT_CLIENT = {
  orderId: 'ord_123',
  status: 'processing',
  readToken: 'read_client_token'
}

const ROUTES = {
  routes: [
    { sourceChain: 'spark', sourceAsset: 'BTC', destinationChain: 'tron', destinationAsset: 'USDT' },
    { sourceChain: 'bsc', sourceAsset: 'USDT', destinationChain: 'spark', destinationAsset: 'BTC' },
    { sourceChain: 'bitcoin', sourceAsset: 'BTC', destinationChain: 'ton', destinationAsset: 'USDT' }
  ]
}

function jsonResponse (body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function sseResponse (events, options = {}) {
  const encoder = new TextEncoder()
  const lineEnding = options.lineEnding ?? '\n'
  const stream = new ReadableStream({
    start (controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`event: status${lineEnding}data: ${JSON.stringify(event)}${lineEnding}${lineEnding}`))
      }
      if (options.close !== false) controller.close()
    }
  })

  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  })
}

function createFetch (responses) {
  return jest.fn(async () => {
    const next = responses.shift()
    if (!next) throw new Error('unexpected fetch')
    return jsonResponse(next.body, next.status ?? 200)
  })
}

function readJsonBody (call) {
  return JSON.parse(call[1].body)
}

async function waitWithTimeout (promise, ms, message) {
  let timeout
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), ms)
      })
    ])
  } finally {
    clearTimeout(timeout)
  }
}

describe('Orchestra', () => {
  let account
  let ids

  beforeEach(() => {
    account = {
      getAddress: jest.fn().mockResolvedValue('sp1sender'),
      sendTransaction: jest.fn().mockResolvedValue({ hash: 'spark_transfer_btc', fee: 0n }),
      transfer: jest.fn().mockResolvedValue({ hash: 'spark_transfer_token', fee: 0n })
    }
    ids = ['quote-idem', 'submit-idem', 'extra-idem']
  })

  test('quoteSwap uses the side-effect-free estimate endpoint', async () => {
    const fetch = createFetch([
      { body: { estimatedOut: '990000', feeAmount: '10', feeBps: 100, feeAsset: 'USDC', route: 'BTC->USDT' } }
    ])
    const protocol = new Orchestra(account, {
      apiKey: 'fn_admin_key',
      fetch,
      sourceChain: 'spark'
    })

    const quote = await protocol.quoteSwap({
      tokenIn: 'BTC',
      tokenOut: 'tron:USDT',
      tokenInAmount: 1000n,
      to: 'TRecipient'
    })

    expect(quote).toEqual({
      fee: 10n,
      tokenInAmount: 1000n,
      tokenOutAmount: 990000n
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(String(fetch.mock.calls[0][0])).toContain('/v1/orchestration/estimate?')
    expect(String(fetch.mock.calls[0][0])).toContain('sourceChain=spark')
    expect(String(fetch.mock.calls[0][0])).toContain('destinationChain=tron')
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer fn_admin_key')
  })

  test('quoteSwidge maps Orchestra estimates to Swidge quotes', async () => {
    const fetch = createFetch([
      { body: { estimatedOut: '990000', feeAmount: '5', totalFeeAmount: '10', feeAsset: 'USDT', expiresAt: '2099-01-01T00:00:00.000Z' } }
    ])
    const protocol = new Orchestra(account, {
      apiKey: 'fn_admin_key',
      fetch,
      sourceChain: 'spark'
    })

    const quote = await protocol.quoteSwidge({
      fromToken: 'BTC',
      toToken: 'tron:USDT',
      fromTokenAmount: 1000n,
      recipient: 'TRecipient',
      slippage: 0.01
    })

    expect(quote).toEqual({
      fromTokenAmount: 1000n,
      toTokenAmount: 990000n,
      toTokenAmountMin: 980100n,
      expiry: 4070908800,
      fees: [{
        type: 'protocol',
        amount: 10n,
        token: 'USDT',
        included: true,
        description: 'Orchestra protocol fee'
      }]
    })
    expect(String(fetch.mock.calls[0][0])).toContain('sourceChain=spark')
    expect(String(fetch.mock.calls[0][0])).toContain('destinationChain=tron')
    expect(String(fetch.mock.calls[0][0])).toContain('slippageBps=100')
  })

  test('quoteSwidge exact-out maps toTokenAmount and amountMode', async () => {
    const fetch = createFetch([
      {
        body: {
          requiredAmountIn: '1000',
          estimatedOut: '990000',
          totalFeeAmount: '10',
          feeAsset: 'USDT',
          expiresAt: '2099-01-01T00:00:00.000Z'
        }
      }
    ])
    const protocol = new Orchestra(account, {
      apiKey: 'fn_admin_key',
      fetch,
      sourceChain: 'spark'
    })

    const quote = await protocol.quoteSwidge({
      fromToken: 'BTC',
      toToken: 'tron:USDT',
      toTokenAmount: 990000n,
      recipient: 'TRecipient'
    })
    const url = new URL(String(fetch.mock.calls[0][0]))

    expect(quote).toMatchObject({
      fromTokenAmount: 1000n,
      toTokenAmount: 990000n,
      toTokenAmountMin: 990000n
    })
    expect(url.searchParams.get('amount')).toBe('990000')
    expect(url.searchParams.get('amountMode')).toBe('exact_out')
  })

  test('swidge executes through Orchestra and returns a Swidge result', async () => {
    account.sendTransaction.mockResolvedValueOnce({ hash: 'spark_transfer_btc', fee: 2n })
    const fetch = createFetch([
      { body: QUOTE },
      { body: SUBMIT_CLIENT }
    ])
    const protocol = new Orchestra(account, {
      apiKey: 'fn_client_key',
      fetch,
      sourceChain: 'spark',
      idempotencyKeyFactory: () => ids.shift()
    })

    const result = await protocol.swidge({
      fromToken: 'BTC',
      toToken: 'tron:USDT',
      fromTokenAmount: 1000n,
      recipient: 'TRecipient',
      slippage: 0.01
    })

    expect(result).toEqual({
      id: 'ord_123',
      hash: 'spark_transfer_btc',
      fees: [
        {
          type: 'network',
          amount: 2n,
          token: 'BTC',
          chain: 'spark',
          included: false,
          description: 'Source wallet network fee'
        },
        {
          type: 'protocol',
          amount: 10n,
          token: 'USDC',
          included: true,
          description: 'Orchestra protocol fee'
        }
      ],
      transactions: [{ hash: 'spark_transfer_btc', chain: 'spark', type: 'source' }],
      fromTokenAmount: 1000n,
      toTokenAmount: 990000n,
      toTokenAmountMin: 980100n
    })
  })

  test('swidge returns Orchestra minimum output when provided', async () => {
    account.sendTransaction.mockResolvedValueOnce({ hash: 'spark_transfer_btc', fee: 2n })
    const fetch = createFetch([
      { body: { ...QUOTE, minAmountOut: '970000' } },
      { body: SUBMIT_CLIENT }
    ])
    const protocol = new Orchestra(account, {
      apiKey: 'fn_client_key',
      fetch,
      sourceChain: 'spark',
      idempotencyKeyFactory: () => ids.shift()
    })

    const result = await protocol.swidge({
      fromToken: 'BTC',
      toToken: 'tron:USDT',
      fromTokenAmount: 1000n,
      recipient: 'TRecipient',
      slippage: 0.01
    })

    expect(result.toTokenAmount).toBe(990000n)
    expect(result.toTokenAmountMin).toBe(970000n)
  })

  test('swidge throws with read-only and undefined accounts', async () => {
    const fetch = createFetch([])
    const readOnlyProtocol = new Orchestra({
      getAddress: jest.fn().mockResolvedValue('sp1sender')
    }, {
      fetch,
      sourceChain: 'spark'
    })
    const accountlessProtocol = new Orchestra(undefined, {
      fetch,
      sourceChain: 'spark'
    })
    const options = {
      fromToken: 'BTC',
      toToken: 'tron:USDT',
      fromTokenAmount: 1000n,
      recipient: 'TRecipient'
    }

    await expect(readOnlyProtocol.swidge(options)).rejects.toBeInstanceOf(OrchestraStateError)
    await expect(accountlessProtocol.swidge(options)).rejects.toBeInstanceOf(OrchestraStateError)
    expect(fetch).not.toHaveBeenCalled()
  })

  test('executeSwapIntent throws before fresh source payment without a writable account', async () => {
    const fetch = createFetch([])
    const readOnlyProtocol = new Orchestra({
      getAddress: jest.fn().mockResolvedValue('sp1sender')
    }, {
      fetch,
      sourceChain: 'spark'
    })
    const accountlessProtocol = new Orchestra(undefined, {
      fetch,
      sourceChain: 'spark'
    })
    const intent = {
      ...QUOTE,
      version: 1,
      sourceChain: 'spark',
      sourceAsset: 'BTC',
      destinationChain: 'tron',
      destinationAsset: 'USDT',
      recipientAddress: 'TRecipient',
      quoteIdempotencyKey: 'quote-idem',
      submitIdempotencyKey: 'submit-idem',
      createdAt: '2026-01-01T00:00:00.000Z'
    }

    await expect(readOnlyProtocol.executeSwapIntent(intent)).rejects.toBeInstanceOf(OrchestraStateError)
    await expect(accountlessProtocol.executeSwapIntent(intent)).rejects.toBeInstanceOf(OrchestraStateError)
    expect(fetch).not.toHaveBeenCalled()
  })

  test('swidge rejects when protocol fees exceed maxProtocolFeeBps', async () => {
    const fetch = createFetch([{ body: QUOTE }])
    const protocol = new Orchestra(account, {
      apiKey: 'fn_client_key',
      fetch,
      sourceChain: 'spark',
      maxProtocolFeeBps: 99,
      idempotencyKeyFactory: () => ids.shift()
    })

    await expect(protocol.swidge({
      fromToken: 'BTC',
      toToken: 'tron:USDT',
      fromTokenAmount: 1000n,
      recipient: 'TRecipient'
    })).rejects.toMatchObject({
      name: 'OrchestraStateError',
      details: {
        feeType: 'protocol',
        feeBps: '100',
        maxFeeBps: '99'
      }
    })

    expect(account.sendTransaction).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  test('swidge rejects when source network fee exceeds maxNetworkFeeBps', async () => {
    account.sendTransaction.mockResolvedValueOnce({ hash: 'spark_transfer_btc', fee: 11n })
    const fetch = createFetch([
      { body: QUOTE },
      { body: SUBMIT_CLIENT }
    ])
    const protocol = new Orchestra(account, {
      apiKey: 'fn_client_key',
      fetch,
      sourceChain: 'spark',
      maxNetworkFeeBps: 100,
      idempotencyKeyFactory: () => ids.shift()
    })

    await expect(protocol.swidge({
      fromToken: 'BTC',
      toToken: 'tron:USDT',
      fromTokenAmount: 1000n,
      recipient: 'TRecipient'
    })).rejects.toMatchObject({
      name: 'OrchestraSubmitError',
      state: {
        sourceTxHash: 'spark_transfer_btc',
        sourceNetworkFee: '11',
        sourceChain: 'spark',
        sourceAsset: 'BTC',
        orderId: 'ord_123',
        readToken: 'read_client_token'
      },
      details: {
        state: {
          sourceTxHash: 'spark_transfer_btc',
          sourceNetworkFee: '11',
          sourceChain: 'spark',
          sourceAsset: 'BTC',
          orderId: 'ord_123',
          readToken: 'read_client_token'
        }
      },
      cause: {
        name: 'OrchestraStateError',
        details: {
          feeType: 'network',
          feeBps: '110',
          maxFeeBps: '100'
        }
      }
    })

    expect(account.sendTransaction).toHaveBeenCalledTimes(1)
    expect(readJsonBody(fetch.mock.calls[1]).sparkTxHash).toBe('spark_transfer_btc')
  })

  test('swidge rejects with recovery state when source network fee is unknown and capped', async () => {
    account.sendTransaction.mockResolvedValueOnce({ hash: 'spark_transfer_btc' })
    const fetch = createFetch([
      { body: QUOTE },
      { body: SUBMIT_CLIENT }
    ])
    const protocol = new Orchestra(account, {
      apiKey: 'fn_client_key',
      fetch,
      sourceChain: 'spark',
      maxNetworkFeeBps: 100,
      idempotencyKeyFactory: () => ids.shift()
    })

    let thrown
    try {
      await protocol.swidge({
        fromToken: 'BTC',
        toToken: 'tron:USDT',
        fromTokenAmount: 1000n,
        recipient: 'TRecipient'
      })
    } catch (err) {
      thrown = err
    }

    expect(thrown).toMatchObject({
      name: 'OrchestraSubmitError',
      state: {
        sourceTxHash: 'spark_transfer_btc',
        sourceChain: 'spark',
        sourceAsset: 'BTC',
        orderId: 'ord_123',
        readToken: 'read_client_token'
      },
      cause: {
        name: 'OrchestraStateError',
        details: {
          feeType: 'network',
          maxFeeBps: '100'
        }
      }
    })
    expect(thrown.state).not.toHaveProperty('sourceNetworkFee')
    expect(account.sendTransaction).toHaveBeenCalledTimes(1)
    expect(readJsonBody(fetch.mock.calls[1]).sparkTxHash).toBe('spark_transfer_btc')
  })

  test('inherited swap delegates through swidge', async () => {
    account.sendTransaction.mockResolvedValueOnce({ hash: 'spark_transfer_btc', fee: 2n })
    const fetch = createFetch([
      { body: QUOTE },
      { body: SUBMIT_CLIENT }
    ])
    const protocol = new Orchestra(account, {
      apiKey: 'fn_client_key',
      fetch,
      sourceChain: 'spark',
      idempotencyKeyFactory: () => ids.shift()
    })

    const result = await protocol.swap({
      tokenIn: 'BTC',
      tokenOut: 'tron:USDT',
      tokenInAmount: 1000n,
      to: 'TRecipient'
    })

    expect(result).toEqual({
      hash: 'ord_123',
      fee: 12n,
      tokenInAmount: 1000n,
      tokenOutAmount: 990000n
    })
  })

  test('inherited quoteBridge delegates through quoteSwidge fee mapping', async () => {
    const fetch = createFetch([
      { body: { estimatedOut: '990000', feeAmount: '5', totalFeeAmount: '10', feeAsset: 'USDT' } }
    ])
    const protocol = new Orchestra(account, {
      apiKey: 'fn_admin_key',
      fetch,
      sourceChain: 'bsc'
    })

    const result = await protocol.quoteBridge({
      token: 'USDT',
      targetChain: 'tron',
      recipient: 'TRecipient',
      amount: 1000n
    })

    expect(result).toEqual({ fee: 0n, bridgeFee: 10n })
    expect(String(fetch.mock.calls[0][0])).toContain('sourceChain=bsc')
    expect(String(fetch.mock.calls[0][0])).toContain('destinationChain=tron')
  })

  test('implements the WDK SwidgeProtocol identity', async () => {
    const protocol = new Orchestra(account, { sourceChain: 'spark' })

    expect(protocol).toBeInstanceOf(Orchestra)
    expect(protocol).toBeInstanceOf(SwidgeProtocol)
  })

  test('prepareSwap creates a durable intent with quote and submit idempotency keys', async () => {
    const fetch = createFetch([{ body: QUOTE }])
    const protocol = new Orchestra(account, {
      apiKey: 'fn_admin_key',
      fetch,
      idempotencyKeyFactory: () => ids.shift()
    })

    const intent = await protocol.prepareSwap({
      source: { chain: 'spark', asset: 'BTC' },
      destination: { chain: 'tron', asset: 'USDT', address: 'TRecipient' },
      amount: 1000n
    })

    expect(intent).toMatchObject({
      version: 1,
      quoteId: 'quo_123',
      sourceChain: 'spark',
      sourceAsset: 'BTC',
      destinationChain: 'tron',
      destinationAsset: 'USDT',
      depositAddress: 'sp1deposit',
      amountIn: '1000',
      estimatedOut: '990000',
      quoteIdempotencyKey: 'quote-idem',
      submitIdempotencyKey: 'submit-idem'
    })
    expect(fetch.mock.calls[0][1].headers['X-Idempotency-Key']).toBe('quote-idem')
    expect(readJsonBody(fetch.mock.calls[0])).toMatchObject({
      sourceChain: 'spark',
      sourceAsset: 'BTC',
      destinationChain: 'tron',
      destinationAsset: 'USDT',
      recipientAddress: 'TRecipient',
      amount: '1000'
    })
  })

  test('quoteSwap can route from Bitcoin L1', async () => {
    const fetch = createFetch([
      { body: { estimatedOut: '995', feeAmount: '5', feeBps: 50, feeAsset: 'BTC', route: 'bitcoin:BTC->spark:BTC' } }
    ])
    const protocol = new Orchestra(account, {
      apiKey: 'fn_admin_key',
      fetch,
      sourceChain: 'bitcoin'
    })

    await protocol.quoteSwap({
      tokenIn: 'BTC',
      tokenOut: 'spark:BTC',
      tokenInAmount: 1000n,
      to: 'sp1recipient'
    })

    expect(String(fetch.mock.calls[0][0])).toContain('sourceChain=bitcoin')
    expect(String(fetch.mock.calls[0][0])).toContain('destinationChain=spark')
  })

  test('quoteSwap normalizes btc asset refs to Bitcoin L1', async () => {
    const fetch = createFetch([
      { body: { estimatedOut: '995', feeAmount: '5', feeBps: 50, feeAsset: 'BTC', route: 'bitcoin:BTC->spark:BTC' } }
    ])
    const protocol = new Orchestra(account, {
      apiKey: 'fn_admin_key',
      fetch
    })

    await protocol.quoteSwap({
      tokenIn: 'btc:BTC',
      tokenOut: 'spark:BTC',
      tokenInAmount: 1000n,
      to: 'sp1recipient'
    })

    expect(String(fetch.mock.calls[0][0])).toContain('sourceChain=bitcoin')
  })

  test('executeSwapIntent sends Spark BTC and submits the transfer id', async () => {
    const fetch = createFetch([
      { body: QUOTE },
      { body: SUBMIT_CLIENT }
    ])
    const protocol = new Orchestra(account, {
      apiKey: 'fn_client_key',
      fetch,
      idempotencyKeyFactory: () => ids.shift()
    })
    const intent = await protocol.prepareSwap({
      tokenIn: 'spark:BTC',
      tokenOut: 'tron:USDT',
      tokenInAmount: 1000n,
      to: 'TRecipient'
    })

    const state = await protocol.executeSwapIntent(intent)

    expect(account.sendTransaction).toHaveBeenCalledWith({ to: 'sp1deposit', value: 1000n })
    expect(readJsonBody(fetch.mock.calls[1])).toEqual({
      quoteId: 'quo_123',
      sparkTxHash: 'spark_transfer_btc',
      sourceSparkAddress: 'sp1sender'
    })
    expect(fetch.mock.calls[1][1].headers['X-Idempotency-Key']).toBe('submit-idem')
    expect(state).toMatchObject({
      sourceTxHash: 'spark_transfer_btc',
      orderId: 'ord_123',
      readToken: 'read_client_token'
    })
  })

  test('executeSwapIntent sends Bitcoin L1 BTC and submits the txid', async () => {
    const bitcoinQuote = {
      ...QUOTE,
      depositAddress: 'bc1deposit',
      route: 'bitcoin:BTC->spark:BTC'
    }
    const fetch = createFetch([
      { body: bitcoinQuote },
      { body: SUBMIT_CLIENT }
    ])
    const bitcoinAccount = {
      getAddress: jest.fn().mockResolvedValue('bc1sender'),
      sendTransaction: jest.fn().mockResolvedValue({ hash: 'l1_txid', fee: 123n })
    }
    const protocol = new Orchestra(bitcoinAccount, {
      apiKey: 'fn_client_key',
      fetch,
      sourceChain: 'bitcoin',
      idempotencyKeyFactory: () => ids.shift()
    })

    const intent = await protocol.prepareSwap({
      tokenIn: 'BTC',
      tokenOut: 'spark:BTC',
      tokenInAmount: 1000n,
      to: 'sp1recipient'
    })
    const state = await protocol.executeSwapIntent(intent, {
      feeRate: 12n,
      confirmationTarget: 2,
      broadcastTimeoutMs: 5000
    })

    expect(bitcoinAccount.sendTransaction).toHaveBeenCalledWith({
      to: 'bc1deposit',
      value: 1000n,
      feeRate: 12n,
      confirmationTarget: 2
    }, 5000)
    expect(readJsonBody(fetch.mock.calls[1])).toEqual({
      quoteId: 'quo_123',
      bitcoinTxid: 'l1_txid',
      sourceAddress: 'bc1sender'
    })
    expect(state).toMatchObject({
      sourceTxHash: 'l1_txid',
      sourceNetworkFee: '123',
      sourceAddress: 'bc1sender',
      orderId: 'ord_123'
    })
  })

  test('executeSwapIntent retries Bitcoin submit while the tx propagates', async () => {
    const bitcoinQuote = {
      ...QUOTE,
      depositAddress: 'bc1deposit',
      route: ['bitcoin:BTC->spark:BTC']
    }
    const fetch = createFetch([
      { body: bitcoinQuote },
      { status: 400, body: { error: { code: 'tx_not_found', message: 'not propagated yet' } } },
      { body: SUBMIT_CLIENT }
    ])
    const bitcoinAccount = {
      getAddress: jest.fn().mockResolvedValue('bc1sender'),
      sendTransaction: jest.fn().mockResolvedValue({ hash: 'l1_txid', fee: 123n })
    }
    const protocol = new Orchestra(bitcoinAccount, {
      apiKey: 'fn_client_key',
      fetch,
      sourceChain: 'bitcoin',
      submitRetryDelayMs: 1,
      idempotencyKeyFactory: () => ids.shift()
    })

    const intent = await protocol.prepareSwap({
      tokenIn: 'BTC',
      tokenOut: 'spark:BTC',
      tokenInAmount: 1000n,
      to: 'sp1recipient'
    })
    const state = await protocol.executeSwapIntent(intent)

    expect(fetch).toHaveBeenCalledTimes(3)
    expect(readJsonBody(fetch.mock.calls[1])).toEqual(readJsonBody(fetch.mock.calls[2]))
    expect(fetch.mock.calls[1][1].headers['X-Idempotency-Key']).toBe('submit-idem')
    expect(fetch.mock.calls[2][1].headers['X-Idempotency-Key']).toBe('submit-idem')
    expect(state.orderId).toBe('ord_123')
  })

  test('executeSwapIntent sends EVM tokens and submits the tx hash', async () => {
    const evmQuote = {
      ...QUOTE,
      depositAddress: '0xDeposit',
      amountIn: '2500000',
      route: 'arbitrum:USDT->bitcoin:BTC'
    }
    const fetch = createFetch([
      { body: evmQuote },
      { body: SUBMIT_CLIENT }
    ])
    const evmAccount = {
      getAddress: jest.fn().mockResolvedValue('0xSender'),
      transfer: jest.fn().mockResolvedValue({ hash: '0xevmtx', fee: 12n })
    }
    const protocol = new Orchestra(evmAccount, {
      apiKey: 'fn_client_key',
      fetch,
      sourceChain: 'arbitrum',
      idempotencyKeyFactory: () => ids.shift()
    })

    const intent = await protocol.prepareSwap({
      tokenIn: 'USDT',
      tokenOut: 'bitcoin:BTC',
      tokenInAmount: 2500000n,
      to: 'bc1recipient'
    })
    const state = await protocol.executeSwapIntent(intent)

    expect(evmAccount.transfer).toHaveBeenCalledWith({
      token: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
      recipient: '0xDeposit',
      amount: 2500000n
    })
    expect(readJsonBody(fetch.mock.calls[1])).toEqual({
      quoteId: 'quo_123',
      txHash: '0xevmtx',
      sourceAddress: '0xSender'
    })
    expect(state).toMatchObject({
      sourceTxHash: '0xevmtx',
      sourceNetworkFee: '12',
      sourceAddress: '0xSender',
      orderId: 'ord_123'
    })
  })

  test('executeSwapIntent sends Spark tokens through transfer with configured token id', async () => {
    const fetch = createFetch([
      { body: { ...QUOTE, amountIn: '2500000' } },
      { body: { orderId: 'ord_usdb', status: 'processing' } }
    ])
    const protocol = new Orchestra(account, {
      apiKey: 'fn_admin_key',
      fetch,
      sparkTokenIdentifiers: { USDB: 'btkn1usdb' },
      sourceChain: 'spark',
      idempotencyKeyFactory: () => ids.shift()
    })
    const intent = await protocol.prepareSwap({
      tokenIn: 'USDB',
      tokenOut: 'bitcoin:BTC',
      tokenInAmount: 2500000n,
      to: 'bc1recipient'
    })

    await protocol.executeSwapIntent(intent)

    expect(account.transfer).toHaveBeenCalledWith({
      token: 'btkn1usdb',
      recipient: 'sp1deposit',
      amount: 2500000n
    })
  })

  test('client-key status follows orders with the read token header', async () => {
    const fetch = createFetch([
      { body: { order: { id: 'ord_123', status: 'processing' }, stages: [] } }
    ])
    const protocol = new Orchestra(account, {
      apiKey: 'fn_client_key',
      fetch
    })

    await protocol.getOrderStatus({ orderId: 'ord_123', readToken: 'read_client_token' })

    expect(String(fetch.mock.calls[0][0])).toContain('/v1/orchestration/status?id=ord_123')
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer fn_client_key')
    expect(fetch.mock.calls[0][1].headers['X-Read-Token']).toBe('read_client_token')
  })

  test('admin-key status does not require a read token', async () => {
    const fetch = createFetch([
      { body: { order: { id: 'ord_123', status: 'processing' }, stages: [] } }
    ])
    const protocol = new Orchestra(account, {
      apiKey: 'fn_admin_key',
      fetch
    })

    await protocol.getOrderStatus({ orderId: 'ord_123' })

    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer fn_admin_key')
    expect(fetch.mock.calls[0][1].headers['X-Read-Token']).toBeUndefined()
  })

  test('getSwidgeStatus maps Orchestra order status to Swidge status', async () => {
    const fetch = createFetch([
      { body: { order: { id: 'ord_123', status: 'processing', sourceTxHash: 'spark_transfer_btc' }, stages: [] } },
      { body: { order: { id: 'ord_123', status: 'completed', sourceTxHash: 'spark_transfer_btc', destinationTxHash: '0xdest' }, stages: [] } }
    ])
    const protocol = new Orchestra(account, {
      apiKey: 'fn_admin_key',
      fetch
    })

    await expect(protocol.getSwidgeStatus('ord_123', { fromChain: 'spark', toChain: 'tron' })).resolves.toEqual({
      status: 'pending',
      transactions: [{ hash: 'spark_transfer_btc', chain: 'spark', type: 'source' }]
    })
    await expect(protocol.getSwidgeStatus('ord_123', { fromChain: 'spark', toChain: 'tron' })).resolves.toEqual({
      status: 'completed',
      transactions: [
        { hash: 'spark_transfer_btc', chain: 'spark', type: 'source' },
        { hash: '0xdest', chain: 'tron', type: 'destination' }
      ]
    })
  })

  test('getSwidgeStatus maps failed, expired, and refunded terminal statuses', async () => {
    const fetch = createFetch([
      { body: { order: { id: 'ord_failed', status: 'failed' }, stages: [] } },
      { body: { order: { id: 'ord_unfulfilled', status: 'unfulfilled' }, stages: [] } },
      { body: { order: { id: 'ord_expired', status: 'expired' }, stages: [] } },
      { body: { order: { id: 'ord_refunded', status: 'refunded' }, stages: [] } }
    ])
    const protocol = new Orchestra(account, {
      apiKey: 'fn_admin_key',
      fetch
    })

    await expect(protocol.getSwidgeStatus('ord_failed')).resolves.toEqual({ status: 'failed', transactions: [] })
    await expect(protocol.getSwidgeStatus('ord_unfulfilled')).resolves.toEqual({ status: 'failed', transactions: [] })
    await expect(protocol.getSwidgeStatus('ord_expired')).resolves.toEqual({ status: 'expired', transactions: [] })
    await expect(protocol.getSwidgeStatus('ord_refunded')).resolves.toEqual({ status: 'refunded', transactions: [] })
  })

  test('getSwidgeStatus propagates unknown id API errors', async () => {
    const fetch = createFetch([
      { status: 404, body: { error: { code: 'order_not_found', message: 'Order not found.' } } }
    ])
    const protocol = new Orchestra(account, {
      apiKey: 'fn_admin_key',
      fetch
    })

    try {
      await protocol.getSwidgeStatus('ord_missing')
      throw new Error('expected getSwidgeStatus to fail')
    } catch (err) {
      expect(err).toBeInstanceOf(OrchestraApiError)
      expect(err).toMatchObject({
        code: 'order_not_found',
        status: 404
      })
    }
  })

  test('getSwidgeStatus throws for an empty id', async () => {
    const fetch = createFetch([])
    const protocol = new Orchestra(account, {
      apiKey: 'fn_admin_key',
      fetch
    })

    await expect(protocol.getSwidgeStatus('')).rejects.toBeInstanceOf(OrchestraStateError)
    expect(fetch).not.toHaveBeenCalled()
  })

  test('subscribeOrder streams SSE status updates and closes on terminal status', async () => {
    const fetch = jest.fn(async () => sseResponse([
      { status: 'processing', order: { id: 'ord_123', status: 'processing' } },
      { status: 'completed', order: { id: 'ord_123', status: 'completed' } }
    ], { lineEnding: '\r\n', close: false }))
    const protocol = new Orchestra(account, {
      apiKey: 'fn_client_key',
      authMode: 'client',
      fetch,
      getAuthHeaders: () => ({ 'X-Proxy-Auth': 'proxy-token' })
    })
    const statuses = []
    const payloads = []
    const closed = new Promise((resolve, reject) => {
      protocol.subscribeOrder({ orderId: 'ord_123', readToken: 'read_client_token' }, {
        onStatus: (status, payload) => {
          statuses.push(status)
          payloads.push(payload)
        },
        onClose: resolve,
        onError: reject
      })
    })

    await waitWithTimeout(closed, 1000, 'SSE subscription did not close on terminal CRLF frame')
    const url = new URL(String(fetch.mock.calls[0][0]))

    expect(statuses).toEqual(['processing', 'completed'])
    expect(payloads[1].order.status).toBe('completed')
    expect(url.pathname).toBe('/v1/sse/operations/ord_123')
    expect(url.searchParams.get('token')).toBeNull()
    expect(url.searchParams.get('readToken')).toBe('read_client_token')
    expect(fetch.mock.calls[0][1].headers.Accept).toBe('text/event-stream')
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer fn_client_key')
    expect(fetch.mock.calls[0][1].headers['X-Read-Token']).toBe('read_client_token')
    expect(fetch.mock.calls[0][1].headers['X-Proxy-Auth']).toBe('proxy-token')
  })

  test('subscribeOrder reports an error when SSE closes before terminal status', async () => {
    const fetch = jest.fn(async () => sseResponse([
      { status: 'processing', order: { id: 'ord_123', status: 'processing' } }
    ]))
    const protocol = new Orchestra(account, {
      apiKey: 'fn_client_key',
      authMode: 'client',
      fetch
    })
    const statuses = []
    const events = []
    const failed = new Promise(resolve => {
      protocol.subscribeOrder({ orderId: 'ord_123' }, {
        onStatus: status => statuses.push(status),
        onError: resolve,
        onClose: () => events.push('close')
      })
    })

    const err = await waitWithTimeout(failed, 1000, 'SSE subscription did not error on early close')

    expect(statuses).toEqual(['processing'])
    expect(err).toMatchObject({
      name: 'OrchestraApiError',
      code: 'sse_connection_closed'
    })
    expect(events).toEqual(['close'])
  })

  test('subscribeOrder rejects successful non-SSE responses', async () => {
    const fetch = jest.fn(async () => jsonResponse({ error: 'not an event stream' }))
    const client = new OrchestraClient({
      apiKey: 'fn_client_key',
      authMode: 'client',
      fetch
    })
    const controller = new AbortController()

    await expect(client._runSse('ord_123', {
      onStatus: jest.fn()
    }, {
      signal: controller.signal,
      close: jest.fn()
    })).rejects.toMatchObject({
      name: 'OrchestraApiError',
      code: 'sse_connection_failed',
      status: 200
    })
  })

  test('getSupportedChains and getSupportedTokens read the Orchestra route matrix', async () => {
    const fetch = createFetch([
      { body: ROUTES },
      { body: ROUTES }
    ])
    const protocol = new Orchestra(account, {
      apiKey: 'fn_admin_key',
      fetch
    })

    await expect(protocol.getSupportedChains()).resolves.toEqual([
      { id: 'bitcoin', name: 'Bitcoin', type: 'utxo', nativeToken: 'BTC' },
      { id: 'bsc', name: 'BNB Smart Chain', type: 'evm', nativeToken: 'BNB' },
      { id: 'spark', name: 'Spark', type: 'spark', nativeToken: 'BTC' },
      { id: 'ton', name: 'TON', type: 'tvm', nativeToken: 'TON' },
      { id: 'tron', name: 'TRON', type: 'tvm', nativeToken: 'TRX' }
    ])
    await expect(protocol.getSupportedTokens({ fromChain: 'spark', toChain: 'tron' })).resolves.toEqual([
      { token: 'spark:BTC', chain: 'spark', symbol: 'BTC', decimals: 8 },
      { token: 'tron:USDT', chain: 'tron', symbol: 'USDT', decimals: 6, address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' }
    ])
  })

  test('waitForCompletion polls until a terminal status', async () => {
    const fetch = createFetch([
      { body: { order: { id: 'ord_123', status: 'processing' }, stages: [] } },
      { body: { order: { id: 'ord_123', status: 'completed' }, stages: [] } }
    ])
    const statuses = []
    const protocol = new Orchestra(account, {
      apiKey: 'fn_admin_key',
      fetch
    })

    const final = await protocol.waitForCompletion({ orderId: 'ord_123' }, {
      pollIntervalMs: 1,
      timeoutMs: 100,
      onStatus: status => statuses.push(status.order.status)
    })

    expect(statuses).toEqual(['processing', 'completed'])
    expect(final.order.status).toBe('completed')
  })

  test('resumeSwap submits an already-sent source transfer without sending again', async () => {
    const fetch = createFetch([{ body: SUBMIT_CLIENT }])
    const protocol = new Orchestra(account, {
      apiKey: 'fn_client_key',
      fetch
    })

    const state = await protocol.resumeSwap({
      ...QUOTE,
      version: 1,
      sourceChain: 'spark',
      sourceAsset: 'BTC',
      destinationChain: 'tron',
      destinationAsset: 'USDT',
      recipientAddress: 'TRecipient',
      quoteIdempotencyKey: 'quote-idem',
      submitIdempotencyKey: 'submit-idem',
      sourceTxHash: 'spark_transfer_existing',
      createdAt: '2026-01-01T00:00:00.000Z'
    })

    expect(account.sendTransaction).not.toHaveBeenCalled()
    expect(state.orderId).toBe('ord_123')
    expect(readJsonBody(fetch.mock.calls[0]).sparkTxHash).toBe('spark_transfer_existing')
  })

  test('submitSourceTx submits an existing source transaction directly', async () => {
    const fetch = createFetch([{ body: SUBMIT_CLIENT }])
    const events = []
    const protocol = new Orchestra(undefined, {
      apiKey: 'fn_client_key',
      fetch,
      onStateChange: async (event, state) => {
        events.push({ event, state })
      }
    })

    const state = await protocol.submitSourceTx({
      ...QUOTE,
      version: 1,
      sourceChain: 'spark',
      sourceAsset: 'BTC',
      destinationChain: 'tron',
      destinationAsset: 'USDT',
      recipientAddress: 'TRecipient',
      quoteIdempotencyKey: 'quote-idem',
      submitIdempotencyKey: 'submit-idem',
      sourceAddress: 'sp1sender',
      createdAt: '2026-01-01T00:00:00.000Z'
    }, 'spark_transfer_direct', {
      sourceNetworkFee: 3n
    })

    expect(state).toMatchObject({
      sourceTxHash: 'spark_transfer_direct',
      sourceNetworkFee: '3',
      sourceAddress: 'sp1sender',
      orderId: 'ord_123',
      readToken: 'read_client_token'
    })
    expect(readJsonBody(fetch.mock.calls[0])).toEqual({
      quoteId: 'quo_123',
      sparkTxHash: 'spark_transfer_direct',
      sourceSparkAddress: 'sp1sender'
    })
    expect(events).toEqual([{
      event: 'submitted',
      state: expect.objectContaining({
        sourceTxHash: 'spark_transfer_direct',
        sourceNetworkFee: '3',
        orderId: 'ord_123',
        readToken: 'read_client_token'
      })
    }])
    expect(fetch.mock.calls[0][1].headers['X-Idempotency-Key']).toBe('submit-idem')
  })

  test('submitSourceTx preserves unknown source network fee', async () => {
    const fetch = createFetch([{ body: SUBMIT_CLIENT }])
    const protocol = new Orchestra(undefined, {
      apiKey: 'fn_client_key',
      fetch
    })

    const state = await protocol.submitSourceTx({
      ...QUOTE,
      version: 1,
      sourceChain: 'spark',
      sourceAsset: 'BTC',
      destinationChain: 'tron',
      destinationAsset: 'USDT',
      recipientAddress: 'TRecipient',
      quoteIdempotencyKey: 'quote-idem',
      submitIdempotencyKey: 'submit-idem',
      sourceAddress: 'sp1sender',
      createdAt: '2026-01-01T00:00:00.000Z'
    }, 'spark_transfer_direct')

    expect(state).not.toHaveProperty('sourceNetworkFee')
    expect(state).toMatchObject({
      sourceTxHash: 'spark_transfer_direct',
      sourceAddress: 'sp1sender',
      orderId: 'ord_123',
      readToken: 'read_client_token'
    })
  })

  test('submitSourceTx failure exposes resumable source state', async () => {
    const fetch = createFetch([
      { status: 400, body: { error: { code: 'submit_failed', message: 'Submit failed.' } } }
    ])
    const protocol = new Orchestra(undefined, {
      apiKey: 'fn_client_key',
      fetch
    })

    await expect(protocol.submitSourceTx({
      ...QUOTE,
      version: 1,
      sourceChain: 'spark',
      sourceAsset: 'BTC',
      destinationChain: 'tron',
      destinationAsset: 'USDT',
      recipientAddress: 'TRecipient',
      quoteIdempotencyKey: 'quote-idem',
      submitIdempotencyKey: 'submit-idem',
      sourceAddress: 'sp1sender',
      createdAt: '2026-01-01T00:00:00.000Z'
    }, 'spark_transfer_direct', {
      sourceNetworkFee: 3n
    })).rejects.toMatchObject({
      name: 'OrchestraSubmitError',
      state: {
        sourceTxHash: 'spark_transfer_direct',
        sourceNetworkFee: '3',
        sourceAddress: 'sp1sender',
        quoteId: 'quo_123'
      },
      cause: {
        name: 'OrchestraApiError',
        code: 'submit_failed',
        status: 400
      }
    })
  })

  test('resumeSwap refuses to send a new source payment unless explicitly allowed', async () => {
    const fetch = createFetch([])
    const protocol = new Orchestra(account, {
      apiKey: 'fn_client_key',
      fetch,
      sourceChain: 'spark'
    })

    await expect(protocol.resumeSwap({
      ...QUOTE,
      version: 1,
      sourceChain: 'spark',
      sourceAsset: 'BTC',
      destinationChain: 'tron',
      destinationAsset: 'USDT',
      recipientAddress: 'TRecipient',
      quoteIdempotencyKey: 'quote-idem',
      submitIdempotencyKey: 'submit-idem',
      createdAt: '2026-01-01T00:00:00.000Z'
    })).rejects.toBeInstanceOf(OrchestraStateError)

    expect(account.sendTransaction).not.toHaveBeenCalled()
  })

  test('executeSwapIntent emits source_payment_started before broadcasting', async () => {
    const fetch = createFetch([
      { body: QUOTE },
      { body: SUBMIT_CLIENT }
    ])
    const events = []
    const protocol = new Orchestra(account, {
      apiKey: 'fn_client_key',
      fetch,
      sourceChain: 'spark',
      idempotencyKeyFactory: () => ids.shift(),
      onStateChange: async (event, state) => {
        events.push({ event, state })
      }
    })
    const intent = await protocol.prepareSwap({
      tokenIn: 'BTC',
      tokenOut: 'tron:USDT',
      tokenInAmount: 1000n,
      to: 'TRecipient'
    })

    await protocol.executeSwapIntent(intent)

    const started = events.find(item => item.event === 'source_payment_started')
    expect(started.state.sourcePaymentStartedAt).toEqual(expect.any(String))
    expect(account.sendTransaction).toHaveBeenCalledTimes(1)
  })

  test('executeSwapIntent emits JSON-safe source and submitted states', async () => {
    const fetch = createFetch([
      { body: QUOTE },
      { body: SUBMIT_CLIENT }
    ])
    const events = []
    const protocol = new Orchestra(account, {
      apiKey: 'fn_client_key',
      fetch,
      sourceChain: 'spark',
      idempotencyKeyFactory: () => ids.shift(),
      onStateChange: async (event, state) => {
        JSON.stringify(state)
        events.push(event)
      }
    })
    const intent = await protocol.prepareSwap({
      tokenIn: 'BTC',
      tokenOut: 'tron:USDT',
      tokenInAmount: 1000n,
      to: 'TRecipient'
    })

    const state = await protocol.executeSwapIntent(intent)

    expect(state.sourceNetworkFee).toBe('0')
    expect(events).toEqual([
      'intent_created',
      'source_payment_started',
      'source_payment_sent',
      'submitted'
    ])
  })

  test('executeSwapIntent preserves unknown source network fee in funded and submitted states', async () => {
    const fetch = createFetch([
      { body: QUOTE },
      { body: SUBMIT_CLIENT }
    ])
    const events = []
    const unknownFeeAccount = {
      getAddress: jest.fn().mockResolvedValue('sp1sender'),
      sendTransaction: jest.fn().mockResolvedValue({ hash: 'spark_transfer_btc' })
    }
    const protocol = new Orchestra(unknownFeeAccount, {
      apiKey: 'fn_client_key',
      fetch,
      sourceChain: 'spark',
      idempotencyKeyFactory: () => ids.shift(),
      onStateChange: async (event, state) => {
        JSON.stringify(state)
        events.push({ event, state })
      }
    })
    const intent = await protocol.prepareSwap({
      tokenIn: 'BTC',
      tokenOut: 'tron:USDT',
      tokenInAmount: 1000n,
      to: 'TRecipient'
    })

    const state = await protocol.executeSwapIntent(intent)
    const funded = events.find(item => item.event === 'source_payment_sent')
    const submitted = events.find(item => item.event === 'submitted')

    expect(state).not.toHaveProperty('sourceNetworkFee')
    expect(funded.state).not.toHaveProperty('sourceNetworkFee')
    expect(submitted.state).not.toHaveProperty('sourceNetworkFee')
    expect(state).toMatchObject({
      sourceTxHash: 'spark_transfer_btc',
      orderId: 'ord_123',
      readToken: 'read_client_token'
    })
  })

  test('executeSwapIntent submits Spark source address captured before broadcast', async () => {
    const fetch = createFetch([
      { body: QUOTE },
      { body: SUBMIT_CLIENT }
    ])
    const sparkAccount = {
      getAddress: jest.fn()
        .mockResolvedValueOnce('sp1sender')
        .mockRejectedValue(new Error('address lookup should not be repeated')),
      sendTransaction: jest.fn().mockResolvedValue({ hash: 'spark_transfer_btc', fee: 0n })
    }
    const protocol = new Orchestra(sparkAccount, {
      apiKey: 'fn_client_key',
      fetch,
      idempotencyKeyFactory: () => ids.shift()
    })
    const intent = await protocol.prepareSwap({
      tokenIn: 'spark:BTC',
      tokenOut: 'tron:USDT',
      tokenInAmount: 1000n,
      to: 'TRecipient'
    })

    const state = await protocol.executeSwapIntent(intent)

    expect(sparkAccount.getAddress).toHaveBeenCalledTimes(1)
    expect(readJsonBody(fetch.mock.calls[1]).sourceSparkAddress).toBe('sp1sender')
    expect(state.sourceAddress).toBe('sp1sender')
  })

  test('submitted state callback failures keep order recovery fields', async () => {
    const fetch = createFetch([
      { body: QUOTE },
      { body: SUBMIT_CLIENT }
    ])
    const protocol = new Orchestra(account, {
      apiKey: 'fn_client_key',
      fetch,
      sourceChain: 'spark',
      idempotencyKeyFactory: () => ids.shift(),
      onStateChange: async (event) => {
        if (event === 'submitted') throw new Error('persistence unavailable')
      }
    })
    const intent = await protocol.prepareSwap({
      tokenIn: 'BTC',
      tokenOut: 'tron:USDT',
      tokenInAmount: 1000n,
      to: 'TRecipient'
    })

    await expect(protocol.executeSwapIntent(intent)).rejects.toMatchObject({
      name: 'OrchestraSubmitError',
      state: {
        sourceTxHash: 'spark_transfer_btc',
        orderId: 'ord_123',
        readToken: 'read_client_token'
      }
    })
  })

  test('executeSwapIntent rejects expired intents before moving funds', async () => {
    const fetch = createFetch([])
    const protocol = new Orchestra(account, {
      apiKey: 'fn_client_key',
      fetch,
      sourceChain: 'spark'
    })

    await expect(protocol.executeSwapIntent({
      ...QUOTE,
      version: 1,
      sourceChain: 'spark',
      sourceAsset: 'BTC',
      destinationChain: 'tron',
      destinationAsset: 'USDT',
      recipientAddress: 'TRecipient',
      expiresAt: '2000-01-01T00:00:00.000Z',
      quoteIdempotencyKey: 'quote-idem',
      submitIdempotencyKey: 'submit-idem',
      createdAt: '2026-01-01T00:00:00.000Z'
    })).rejects.toBeInstanceOf(OrchestraStateError)

    expect(account.sendTransaction).not.toHaveBeenCalled()
  })

  test('resumeSwap submits an existing Bitcoin L1 tx without sending again', async () => {
    const fetch = createFetch([{ body: SUBMIT_CLIENT }])
    const bitcoinAccount = {
      getAddress: jest.fn().mockResolvedValue('bc1sender'),
      sendTransaction: jest.fn()
    }
    const protocol = new Orchestra(bitcoinAccount, {
      apiKey: 'fn_client_key',
      fetch,
      sourceChain: 'bitcoin'
    })

    const state = await protocol.resumeSwap({
      ...QUOTE,
      version: 1,
      sourceChain: 'bitcoin',
      sourceAsset: 'BTC',
      destinationChain: 'spark',
      destinationAsset: 'BTC',
      recipientAddress: 'sp1recipient',
      depositAddress: 'bc1deposit',
      quoteIdempotencyKey: 'quote-idem',
      submitIdempotencyKey: 'submit-idem',
      sourceTxHash: 'l1_existing_txid',
      sourceAddress: 'bc1sender',
      sourceTxVout: 1,
      createdAt: '2026-01-01T00:00:00.000Z'
    })

    expect(bitcoinAccount.sendTransaction).not.toHaveBeenCalled()
    expect(state.orderId).toBe('ord_123')
    expect(readJsonBody(fetch.mock.calls[0])).toEqual({
      quoteId: 'quo_123',
      bitcoinTxid: 'l1_existing_txid',
      sourceAddress: 'bc1sender',
      bitcoinVout: 1
    })
    expect(state).toMatchObject({
      sourceAddress: 'bc1sender',
      sourceTxVout: 1
    })
  })

  test('submit failure after source payment exposes resumable state', async () => {
    const fetch = createFetch([
      { body: QUOTE },
      { status: 503, body: { error: { code: 'service_unavailable', message: 'temporary outage' } } }
    ])
    const protocol = new Orchestra(account, {
      apiKey: 'fn_admin_key',
      fetch,
      maxRetries: 0,
      submitMaxRetries: 0,
      sourceChain: 'spark',
      idempotencyKeyFactory: () => ids.shift()
    })
    const intent = await protocol.prepareSwap({
      tokenIn: 'BTC',
      tokenOut: 'tron:USDT',
      tokenInAmount: 1000n,
      to: 'TRecipient'
    })

    try {
      await protocol.executeSwapIntent(intent)
      throw new Error('expected executeSwapIntent to fail')
    } catch (err) {
      expect(err).toBeInstanceOf(OrchestraSubmitError)
      expect(err.state.sourceTxHash).toBe('spark_transfer_btc')
    }
  })

  test('normalizes canonical asset aliases without uppercasing mixed-case symbols', async () => {
    const fetch = createFetch([
      { body: { estimatedOut: '995', totalFeeAmount: '5', route: ['polygon:USDC.e->bitcoin:BTC'] } }
    ])
    const protocol = new Orchestra(account, {
      apiKey: 'fn_admin_key',
      fetch
    })

    await protocol.quoteSwap({
      tokenIn: 'polygon:USDC.e',
      tokenOut: 'bitcoin:BTC',
      tokenInAmount: '1000',
      to: 'bc1recipient'
    })

    expect(String(fetch.mock.calls[0][0])).toContain('sourceAsset=USDC.e')
  })
})

describe('OrchestraClient', () => {
  test('adds idempotency keys to direct mutating calls', async () => {
    const fetch = createFetch([
      { body: QUOTE },
      { body: SUBMIT_CLIENT }
    ])
    const client = new OrchestraClient({
      apiKey: 'fn_admin_key',
      fetch
    })

    await client.createQuote({ sourceChain: 'spark' })
    await client.submit({ quoteId: 'quo_123', sparkTxHash: 'spark_tx' })

    expect(fetch.mock.calls[0][1].headers['X-Idempotency-Key']).toMatch(/^orchestra-|^[0-9a-f-]{36}$/)
    expect(fetch.mock.calls[1][1].headers['X-Idempotency-Key']).toMatch(/^orchestra-|^[0-9a-f-]{36}$/)
  })

  test('uses bearer auth without leaking the SSE token into the URL', async () => {
    const fetch = jest.fn()
    const defaultClient = new OrchestraClient({
      apiKey: 'fn_admin_key',
      fetch
    })
    const scopedClient = new OrchestraClient({
      apiKey: 'client_key_for_test',
      authMode: 'client',
      fetch
    })
    const autoClient = new OrchestraClient({
      apiKey: 'client_key_for_auto_mode',
      authMode: 'auto',
      fetch
    })

    await expect(defaultClient._resolveSseToken()).rejects.toMatchObject({ code: 'sse_token_required' })
    await expect(scopedClient._resolveSseToken()).resolves.toBe('client_key_for_test')
    await expect(autoClient._resolveSseToken()).resolves.toBe('client_key_for_auto_mode')
  })
})
