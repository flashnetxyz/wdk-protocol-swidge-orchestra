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

import { OrchestraStateError } from './errors.js'

const ASSET_ALIASES = Object.freeze({
  'USDC.E': 'USDC.e',
  USDC_E: 'USDC.e',
  PATHUSD: 'PathUSD',
  CBBTC: 'cbBTC',
  TBTC: 'tBTC'
})

export function normalizeChain (chain) {
  if (typeof chain !== 'string' || chain.trim() === '') return undefined
  const normalized = chain.trim().toLowerCase()
  if (normalized === 'btc') return 'bitcoin'
  return normalized
}

export function normalizeAssetSymbol (asset) {
  if (typeof asset !== 'string' || asset.trim() === '') {
    throw new OrchestraStateError('Asset must be a non-empty string.')
  }
  const trimmed = asset.trim()
  return ASSET_ALIASES[trimmed.toUpperCase()] ?? trimmed.toUpperCase()
}

export function parseAssetRef (value, defaultChain) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new OrchestraStateError('Token reference must be a non-empty string.')
  }

  const trimmed = value.trim()
  const separator = trimmed.indexOf(':')
  if (separator === -1) {
    if (!defaultChain) {
      throw new OrchestraStateError(`Token reference '${trimmed}' must include a chain prefix.`)
    }
    return { chain: normalizeChain(defaultChain), asset: normalizeAssetSymbol(trimmed) }
  }

  const chain = normalizeChain(trimmed.slice(0, separator))
  const asset = trimmed.slice(separator + 1).trim()
  if (!chain || !asset) {
    throw new OrchestraStateError(`Token reference '${trimmed}' must use '<chain>:<asset>'.`)
  }
  return { chain, asset: normalizeAssetSymbol(asset) }
}

export function stringifyAmount (amount, field) {
  if (amount === undefined || amount === null) {
    throw new OrchestraStateError(`${field} is required.`)
  }
  const value = parseIntegerAmount(amount, field)
  if (value <= 0n) {
    throw new OrchestraStateError(`${field} must be positive.`)
  }
  return value.toString()
}

export function toBigIntAmount (amount, field) {
  if (amount === undefined || amount === null) {
    throw new OrchestraStateError(`${field} is required.`)
  }
  const value = parseIntegerAmount(amount, field)
  if (value < 0n) {
    throw new OrchestraStateError(`${field} cannot be negative.`)
  }
  return value
}

function parseIntegerAmount (amount, field) {
  if (typeof amount === 'bigint') return amount
  if (typeof amount === 'number') {
    if (!Number.isSafeInteger(amount)) {
      throw new OrchestraStateError(`${field} must be a safe integer when passed as a number.`)
    }
    return BigInt(amount)
  }
  if (typeof amount === 'string' && /^-?\d+$/.test(amount.trim())) {
    return BigInt(amount.trim())
  }
  throw new OrchestraStateError(`${field} must be an integer bigint, safe integer number, or decimal string.`)
}
