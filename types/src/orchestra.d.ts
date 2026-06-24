import type { IWalletAccount, IWalletAccountReadOnly } from '@tetherto/wdk-wallet'
import { SwidgeProtocol } from '@tetherto/wdk-wallet/protocols'
import type {
  SwapOptions,
  SwapResult,
  SwidgeOptions,
  SwidgeProtocolConfig,
  SwidgeQuote,
  SwidgeResult,
  SwidgeStatusOptions,
  SwidgeStatusResult,
  SwidgeSupportedChain,
  SwidgeSupportedToken,
  SwidgeSupportedTokensOptions
} from '@tetherto/wdk-wallet/protocols'
import type { OrchestraClient } from './orchestra-client.js'

export type AuthMode = 'admin' | 'client' | 'auto'

export type OrchestraAuthHeaders =
  | Record<string, string>
  | Headers
  | Promise<Record<string, string> | Headers>

export interface OrchestraConfig extends SwidgeProtocolConfig {
  apiKey?: string
  baseUrl?: string
  fetch?: typeof fetch
  getAuthHeaders?: () => OrchestraAuthHeaders
  sseToken?: string
  getSseToken?: () => string | Promise<string>
  authMode?: AuthMode
  sourceChain?: 'spark' | 'bitcoin' | string
  defaultSourceChain?: 'spark' | 'bitcoin' | string
  chain?: 'spark' | 'bitcoin' | string
  sparkTokenIdentifiers?: Record<string, string>
  tokenIdentifiers?: Record<string, string>
  sourceTokenAddresses?: Record<string, string>
  tokenAddresses?: Record<string, string>
  assetAddresses?: Record<string, string>
  nativeAssets?: Record<string, string>
  tokenDecimals?: Record<string, number>
  slippageBps?: number
  timeoutMs?: number
  maxRetries?: number
  retryDelayMs?: number
  submitMaxRetries?: number
  submitRetryDelayMs?: number
  quoteExpirySafetyMs?: number
  pollIntervalMs?: number
  waitTimeoutMs?: number
  idempotencyKeyFactory?: () => string
  onIntent?: (intent: OrchestraSwapIntent) => void | Promise<void>
  onStateChange?: (
    event: string,
    state: OrchestraSwapIntent | OrchestraSwapState
  ) => void | Promise<void>
  onOrderStatus?: (status: StatusResponse) => void | Promise<void>
  client?: OrchestraClient
}

export interface AssetRef {
  chain: string
  asset: string
}

export interface DestinationRef extends AssetRef {
  address?: string
}

export interface AppFee {
  recipient: string
  fee: number
}

export type OrchestraSwapOptions = SwapOptions & {
  source?: AssetRef
  destination?: DestinationRef
  sourceChain?: string
  sourceAsset?: string
  destinationChain?: string
  destinationAsset?: string
  recipientAddress?: string
  refundChain?: string
  refundAddress?: string
  amountMode?: 'exact_in' | 'exact_out'
  amount?: number | bigint | string
  slippageBps?: number
  sourceTokenIdentifier?: string
  sourceTokenAddress?: string
  appFees?: AppFee[]
  affiliateId?: string
  affiliateIds?: string[]
}

export type OrchestraAmount = number | bigint | string

export type OrchestraSwidgeOptions = Omit<SwidgeOptions, 'fromTokenAmount' | 'toTokenAmount'> & (
  | { fromTokenAmount: OrchestraAmount, toTokenAmount?: undefined }
  | { fromTokenAmount?: undefined, toTokenAmount: OrchestraAmount }
) & {
  fromChain?: string | number
  refundChain?: string
  slippageBps?: number
  idempotencyKey?: string
  submitIdempotencyKey?: string
  sourceTxHash?: string
  sourceNetworkFee?: bigint | number | string
  sourceAddress?: string
  sourceTxVout?: number
  sourceSparkAddress?: string
  sourceTokenIdentifier?: string
  sourceTokenAddress?: string
  feeRate?: number | bigint
  confirmationTarget?: number
  broadcastTimeoutMs?: number
  allowNewSourcePayment?: boolean
  ignoreQuoteExpiry?: boolean
  quoteExpirySafetyMs?: number
  appFees?: AppFee[]
  affiliateId?: string
  affiliateIds?: string[]
}

export type OrchestraSwidgeStatusOptions = SwidgeStatusOptions & {
  readToken?: string
}

export interface PrepareSwapOptions {
  idempotencyKey?: string
  submitIdempotencyKey?: string
}

export interface ExecuteSwapOptions {
  sourceTxHash?: string
  sourceNetworkFee?: bigint | number | string
  sourceAddress?: string
  sourceTxVout?: number
  sourceSparkAddress?: string
  sourceTokenIdentifier?: string
  sourceTokenAddress?: string
  feeRate?: number | bigint
  confirmationTarget?: number
  broadcastTimeoutMs?: number
  submitIdempotencyKey?: string
  allowNewSourcePayment?: boolean
  ignoreQuoteExpiry?: boolean
  quoteExpirySafetyMs?: number
}

export interface OrchestraSwapIntent {
  version: 1
  quoteId: string
  sourceChain: string
  sourceAsset: string
  destinationChain: string
  destinationAsset: string
  recipientAddress: string
  refundChain?: string
  refundAddress?: string
  amountMode: 'exact_in' | 'exact_out'
  amountIn: string
  estimatedOut: string
  depositAddress: string
  feeAmount?: string
  totalFeeAmount?: string
  feeAsset?: string
  route?: string[]
  expiresAt: string
  sourceTokenIdentifier?: string
  sourceTokenAddress?: string
  sourceAddress?: string
  sourceTxVout?: number
  sourcePaymentStartedAt?: string
  quoteIdempotencyKey: string
  submitIdempotencyKey: string
  createdAt: string
}

export interface OrchestraSwapState extends OrchestraSwapIntent {
  sourceTxHash?: string
  sourceNetworkFee?: string
  orderId?: string
  status?: string
  readToken?: string
  sourcePaymentStartedAt?: string
  fundedAt?: string
  submittedAt?: string
}

export interface OrchestraSwapResult extends SwapResult {
  quoteId: string
  orderId: string
  status: string
  readToken?: string
}

export interface StatusTarget {
  id?: string
  orderId?: string
  quoteId?: string
  sourceTxHash?: string
  sourceChain?: string
  readToken?: string
}

export interface OrderProjection {
  id: string
  status: string
  [key: string]: unknown
}

export interface StatusResponse {
  order?: OrderProjection
  stages?: unknown[]
  status?: string
  [key: string]: unknown
}

export interface WaitForCompletionOptions {
  timeoutMs?: number
  pollIntervalMs?: number
  onStatus?: (status: StatusResponse) => void | Promise<void>
}

export interface OrderSubscription {
  close: () => void
}

export interface OrderSubscriptionCallbacks {
  onStatus?: (status: string, event?: unknown) => void
  onError?: (error: Error) => void
  onClose?: () => void
}

export default class Orchestra extends SwidgeProtocol {
  constructor(account?: undefined, config?: OrchestraConfig)
  constructor(account: IWalletAccountReadOnly, config?: OrchestraConfig)
  constructor(account: IWalletAccount, config?: OrchestraConfig)

  quoteSwidge(options: OrchestraSwidgeOptions | SwidgeOptions): Promise<SwidgeQuote>
  swidge(
    options: OrchestraSwidgeOptions | SwidgeOptions,
    config?: SwidgeProtocolConfig & ExecuteSwapOptions
  ): Promise<SwidgeResult>
  getSwidgeStatus(
    id: string,
    options?: OrchestraSwidgeStatusOptions
  ): Promise<SwidgeStatusResult>
  getSupportedChains(): Promise<SwidgeSupportedChain[]>
  getSupportedTokens(options?: SwidgeSupportedTokensOptions): Promise<SwidgeSupportedToken[]>
  prepareSwap(
    options: OrchestraSwapOptions | SwapOptions | OrchestraSwidgeOptions | SwidgeOptions,
    requestOptions?: PrepareSwapOptions
  ): Promise<OrchestraSwapIntent>
  executeSwapIntent(
    intent: OrchestraSwapIntent | OrchestraSwapState,
    options?: ExecuteSwapOptions
  ): Promise<OrchestraSwapState>
  submitSourceTx(
    intent: OrchestraSwapIntent | OrchestraSwapState,
    sourceTxHash: string,
    options?: ExecuteSwapOptions
  ): Promise<OrchestraSwapState>
  resumeSwap(
    state: OrchestraSwapIntent | OrchestraSwapState,
    options?: ExecuteSwapOptions
  ): Promise<OrchestraSwapState | StatusResponse>
  getOrderStatus(target: string | StatusTarget | OrchestraSwapState): Promise<StatusResponse>
  waitForCompletion(
    target: string | StatusTarget | OrchestraSwapState,
    options?: WaitForCompletionOptions
  ): Promise<StatusResponse>
  subscribeOrder(
    target: string | StatusTarget | OrchestraSwapState,
    callbacks: OrderSubscriptionCallbacks,
    options?: { readToken?: string }
  ): OrderSubscription
}
