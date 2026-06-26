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

import { OrchestraApiError, OrchestraTimeoutError } from './errors.js'

const DEFAULT_BASE_URL = 'https://orchestration.flashnet.xyz'
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RETRIES = 2
const DEFAULT_RETRY_DELAY_MS = 400
const MAX_RETRY_DELAY_MS = 10_000
const RETRYABLE_STATUS_CODES = new Set([408, 409, 425, 429, 500, 502, 503, 504])

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function randomId () {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return `orchestra-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function makeQuery (query) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue
    params.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
  }
  const encoded = params.toString()
  return encoded ? `?${encoded}` : ''
}

function headersToObject (headers) {
  if (!headers) return {}
  if (headers instanceof Headers) return Object.fromEntries(headers.entries())
  if (Array.isArray(headers)) return Object.fromEntries(headers)
  return { ...headers }
}

async function parseErrorBody (response) {
  try {
    const body = await response.json()
    const error = body && typeof body === 'object' ? body.error : null
    if (error && typeof error === 'object') {
      return {
        code: typeof error.code === 'string' ? error.code : 'api_error',
        message: typeof error.message === 'string' ? error.message : `HTTP ${response.status}`,
        body
      }
    }
    return { code: 'api_error', message: `HTTP ${response.status}`, body }
  } catch {
    return { code: 'api_error', message: `HTTP ${response.status}`, body: null }
  }
}

function retryDelayMs (attempt, baseDelayMs, response) {
  const retryAfter = response?.headers?.get('retry-after')
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS)
    const retryAt = Date.parse(retryAfter)
    if (Number.isFinite(retryAt)) return Math.min(Math.max(0, retryAt - Date.now()), MAX_RETRY_DELAY_MS)
  }
  const exponential = Math.min(baseDelayMs * (2 ** attempt), MAX_RETRY_DELAY_MS)
  return exponential + Math.floor(Math.random() * Math.min(100, exponential))
}

function retryCount (value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer.`)
  }
  return value
}

export function isTerminalOrderStatus (status) {
  return status === 'completed' ||
    status === 'failed' ||
    status === 'expired' ||
    status === 'unfulfilled' ||
    status === 'refunded'
}

export class OrchestraClient {
  constructor (config = {}) {
    this._apiKey = config.apiKey
    this._baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this._fetch = config.fetch ?? globalThis.fetch
    this._getAuthHeaders = config.getAuthHeaders
    this._timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this._maxRetries = retryCount(config.maxRetries ?? DEFAULT_MAX_RETRIES, 'maxRetries')
    this._retryDelayMs = config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
    this._submitMaxRetries = retryCount(config.submitMaxRetries ?? Math.max(this._maxRetries, 6), 'submitMaxRetries')
    this._submitRetryDelayMs = config.submitRetryDelayMs ?? this._retryDelayMs
    this._sseToken = config.sseToken
    this._getSseToken = config.getSseToken
    this._authMode = config.authMode

    if (typeof this._fetch !== 'function') {
      throw new Error('A fetch implementation is required.')
    }
  }

  async estimate (params) {
    return await this._requestJson('GET', '/v1/orchestration/estimate', { query: params })
  }

  async createQuote (params, options = {}) {
    return await this._requestJson('POST', '/v1/orchestration/quote', {
      body: params,
      idempotencyKey: options.idempotencyKey ?? randomId()
    })
  }

  async submit (params, options = {}) {
    return await this._requestJson('POST', '/v1/orchestration/submit', {
      body: params,
      idempotencyKey: options.idempotencyKey ?? randomId(),
      maxRetries: options.maxRetries ?? this._submitMaxRetries,
      retryDelayMs: options.retryDelayMs ?? this._submitRetryDelayMs,
      retryErrorCodes: new Set(['tx_not_found', 'vout_not_found'])
    })
  }

  async getStatus (params, options = {}) {
    return await this._requestJson('GET', '/v1/orchestration/status', {
      query: params,
      readToken: options.readToken
    })
  }

  async getRoutes () {
    return await this._requestJson('GET', '/v1/orchestration/routes')
  }

  subscribeStatus (orderId, callbacks, options = {}) {
    const controller = new AbortController()
    let closed = false

    const close = () => {
      if (closed) return
      closed = true
      controller.abort()
      callbacks.onClose?.()
    }

    this._runSse(orderId, callbacks, {
      ...options,
      signal: controller.signal,
      close
    }).then(close, err => {
      if (!closed) callbacks.onError?.(err)
      close()
    })

    return { close }
  }

  async _runSse (orderId, callbacks, options) {
    const token = await this._resolveSseToken()
    const query = {}
    if (options.readToken) query.readToken = options.readToken
    const url = `${this._baseUrl}/v1/sse/operations/${encodeURIComponent(orderId)}${makeQuery(query)}`
    const headers = await this._headers(options)
    headers.Authorization = `Bearer ${token}`
    headers.Accept = 'text/event-stream'
    const response = await this._fetch(url, {
      method: 'GET',
      headers,
      signal: options.signal
    })

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
    if (!response.ok || !response.body || !contentType.includes('text/event-stream')) {
      throw new OrchestraApiError('sse_connection_failed', `SSE connection failed: HTTP ${response.status}`, response.status)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let event = ''
    let data = ''

    try {
      while (!options.signal.aborted) {
        const { done, value } = await reader.read()
        if (done) {
          throw new OrchestraApiError('sse_connection_closed', 'SSE connection closed before a terminal order status.', 0)
        }
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const rawLine of lines) {
          const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) data += `${data ? '\n' : ''}${line.slice(5).trim()}`
          else if (line === '') {
            if (event === 'status' && data) {
              const parsed = JSON.parse(data)
              callbacks.onStatus?.(parsed.status, parsed)
              if (isTerminalOrderStatus(parsed.status)) {
                options.close()
                await reader.cancel()
                return
              }
            }
            event = ''
            data = ''
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  async _requestJson (method, path, options = {}) {
    let lastError
    const maxRetries = retryCount(options.maxRetries ?? this._maxRetries, 'maxRetries')
    const retryDelay = options.retryDelayMs ?? this._retryDelayMs
    const retryErrorCodes = options.retryErrorCodes ?? new Set()
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), this._timeoutMs)

      try {
        const response = await this._fetch(`${this._baseUrl}${path}${makeQuery(options.query)}`, {
          method,
          headers: await this._headers(options),
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: controller.signal
        })
        clearTimeout(timeout)

        if (response.ok) return await response.json()

        const error = await parseErrorBody(response)
        const apiError = new OrchestraApiError(error.code, error.message, response.status, error.body)
        const retryableConflict = response.status === 409 && error.code === 'idempotency_in_progress'
        const retryableStatus = RETRYABLE_STATUS_CODES.has(response.status) && (response.status !== 409 || retryableConflict)
        const retryableCode = retryErrorCodes.has(error.code)
        if (attempt < maxRetries && (retryableStatus || retryableCode)) {
          lastError = apiError
          await sleep(retryDelayMs(attempt, retryDelay, response))
          continue
        }
        throw apiError
      } catch (err) {
        clearTimeout(timeout)
        if (err instanceof OrchestraApiError) throw err
        if (attempt < maxRetries) {
          lastError = err
          await sleep(retryDelayMs(attempt, retryDelay))
          continue
        }
        if (err?.name === 'AbortError') {
          throw new OrchestraTimeoutError(`Request timed out: ${method} ${path}`)
        }
        throw err
      }
    }
    throw lastError
  }

  async _resolveSseToken () {
    const resolved = this._getSseToken ? await this._getSseToken() : undefined
    const token = resolved ?? this._sseToken
    if (token) return token
    if (this._authMode === 'admin') {
      throw new OrchestraApiError(
        'sse_token_required',
        'Direct SSE with an admin key is disabled. Pass sseToken/getSseToken or proxy SSE from a backend.',
        0
      )
    }
    if (this._authMode !== 'client' && this._authMode !== 'auto') {
      throw new OrchestraApiError(
        'sse_token_required',
        "SSE requires sseToken/getSseToken unless authMode is explicitly set to 'client' or 'auto'.",
        0
      )
    }
    if (!this._apiKey) {
      throw new OrchestraApiError('sse_token_required', 'Client-key SSE requires apiKey, sseToken, or getSseToken.', 0)
    }
    return this._apiKey
  }

  async _headers (options) {
    const headers = {
      Accept: 'application/json'
    }
    if (options.body !== undefined) headers['Content-Type'] = 'application/json'
    if (this._apiKey) headers.Authorization = `Bearer ${this._apiKey}`
    if (options.idempotencyKey) headers['X-Idempotency-Key'] = options.idempotencyKey
    if (options.readToken) headers['X-Read-Token'] = options.readToken
    return {
      ...headers,
      ...headersToObject(await this._getAuthHeaders?.())
    }
  }
}
