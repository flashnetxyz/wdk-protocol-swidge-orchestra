export interface OrchestraClientConfig {
  apiKey?: string
  baseUrl?: string
  fetch?: typeof fetch
  getAuthHeaders?: () => Record<string, string> | Headers | Promise<Record<string, string> | Headers>
  sseToken?: string
  getSseToken?: () => string | Promise<string>
  authMode?: 'admin' | 'client' | 'auto'
  timeoutMs?: number
  maxRetries?: number
  retryDelayMs?: number
  submitMaxRetries?: number
  submitRetryDelayMs?: number
}

export interface RequestOptions {
  idempotencyKey?: string
  readToken?: string
}

export interface SubmitOptions extends RequestOptions {
  maxRetries?: number
  retryDelayMs?: number
}

export interface OrderSubscription {
  close: () => void
}

export interface OrderSubscriptionCallbacks {
  onStatus?: (status: string, event?: unknown) => void
  onError?: (error: Error) => void
  onClose?: () => void
}

export function isTerminalOrderStatus(status: string): boolean

export class OrchestraClient {
  constructor(config?: OrchestraClientConfig)
  estimate<T extends object = Record<string, unknown>>(params: object): Promise<T>
  createQuote<T extends object = Record<string, unknown>>(
    params: object,
    options?: RequestOptions
  ): Promise<T>
  submit<T extends object = Record<string, unknown>>(
    params: object,
    options?: SubmitOptions
  ): Promise<T>
  getStatus<T extends object = Record<string, unknown>>(
    params: object,
    options?: RequestOptions
  ): Promise<T>
  subscribeStatus(
    orderId: string,
    callbacks: OrderSubscriptionCallbacks,
    options?: { readToken?: string }
  ): OrderSubscription
}
