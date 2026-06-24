#!/usr/bin/env node
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

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import WDK from '@tetherto/wdk'
import WalletManagerBtc from '@tetherto/wdk-wallet-btc'
import WalletManagerEvm from '@tetherto/wdk-wallet-evm'
import WalletManagerSpark from '@tetherto/wdk-wallet-spark'

import Orchestra from '../index.js'

const ENV_FILE = '.orchestra-live.env'
const STATE_DIR = '.orchestra-live-state'
const DEFAULT_BASE_URL = 'https://orchestration.flashnet.xyz'
const ARBITRUM_USDT = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9'
const DIRECTIONS = Object.freeze({
  'spark-btc-to-arbitrum-usdt': {
    sourceWallet: 'spark',
    destinationWallet: 'arbitrum',
    sourceChain: 'spark',
    sourceAsset: 'BTC',
    destinationChain: 'arbitrum',
    destinationAsset: 'USDT',
    amountLabel: 'sats'
  },
  'btc-to-arbitrum-usdt': {
    sourceWallet: 'bitcoin',
    destinationWallet: 'arbitrum',
    sourceChain: 'bitcoin',
    sourceAsset: 'BTC',
    destinationChain: 'arbitrum',
    destinationAsset: 'USDT',
    amountLabel: 'sats'
  },
  'arbitrum-usdt-to-btc': {
    sourceWallet: 'arbitrum',
    destinationWallet: 'bitcoin',
    sourceChain: 'arbitrum',
    sourceAsset: 'USDT',
    destinationChain: 'bitcoin',
    destinationAsset: 'BTC',
    amountLabel: 'USDT smallest units'
  },
  'arbitrum-usdt-to-spark-btc': {
    sourceWallet: 'arbitrum',
    destinationWallet: 'spark',
    sourceChain: 'arbitrum',
    sourceAsset: 'USDT',
    destinationChain: 'spark',
    destinationAsset: 'BTC',
    amountLabel: 'USDT smallest units'
  }
})

function parseArgs (argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i]
    if (!item.startsWith('--')) {
      args._.push(item)
      continue
    }
    const key = item.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      args[key] = true
      continue
    }
    args[key] = next
    i += 1
  }
  return args
}

function unquote (value) {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function readEnvFile () {
  if (!fs.existsSync(ENV_FILE)) {
    throw new Error(`Missing ${ENV_FILE}. Run npm run live:init first.`)
  }
  const fileEnv = {}
  const text = fs.readFileSync(ENV_FILE, 'utf8')
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf('=')
    if (separator === -1) continue
    const key = trimmed.slice(0, separator).trim()
    fileEnv[key] = unquote(trimmed.slice(separator + 1))
  }
  const env = { ...process.env }
  for (const [key, value] of Object.entries(fileEnv)) {
    if (value !== '' || env[key] === undefined) env[key] = value
  }
  return env
}

function requireValue (env, key) {
  const value = env[key]
  if (!value) throw new Error(`${key} is required in ${ENV_FILE} or the process env.`)
  return value
}

function redactForOutput (value) {
  if (Array.isArray(value)) return value.map(redactForOutput)
  if (!value || typeof value !== 'object') return value
  const redacted = {}
  for (const [key, item] of Object.entries(value)) {
    if (key === 'readToken' && item) {
      redacted.hasReadToken = true
      continue
    }
    redacted[key] = redactForOutput(item)
  }
  return redacted
}

function writeJson (value) {
  console.log(JSON.stringify(redactForOutput(value), (_key, item) => {
    return typeof item === 'bigint' ? item.toString() : item
  }, 2))
}

function writeState (file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(state, (_key, value) => {
    return typeof value === 'bigint' ? value.toString() : value
  }, 2) + '\n', { mode: 0o600 })
}

function readState (file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function stateFileFor (direction) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return path.join(STATE_DIR, `${stamp}-${direction}.json`)
}

function directionConfig (name) {
  const config = DIRECTIONS[name]
  if (!config) {
    throw new Error(`Unknown direction '${name}'. Use one of: ${Object.keys(DIRECTIONS).join(', ')}`)
  }
  return config
}

function makeWdk (env) {
  const electrumHost = env.BITCOIN_ELECTRUM_HOST || 'electrum.blockstream.info'
  const electrumPort = Number(env.BITCOIN_ELECTRUM_PORT || '50001')
  const bitcoinWalletConfig = {
    network: env.BITCOIN_NETWORK || 'bitcoin',
    client: {
      type: 'electrum',
      clientConfig: { host: electrumHost, port: electrumPort }
    }
  }
  const arbitrumWalletConfig = {
    chainId: 42161,
    ...(env.ARBITRUM_RPC_URL ? { provider: env.ARBITRUM_RPC_URL } : {})
  }

  return new WDK(requireValue(env, 'ORCHESTRA_MNEMONIC'))
    .registerWallet('bitcoin', WalletManagerBtc, bitcoinWalletConfig)
    .registerWallet('spark', WalletManagerSpark, {
      network: env.SPARK_NETWORK || 'MAINNET',
      syncAndRetry: true
    })
    .registerWallet('arbitrum', WalletManagerEvm, arbitrumWalletConfig)
}

async function accounts (env) {
  const wdk = makeWdk(env)
  const [bitcoin, spark, arbitrum] = await Promise.all([
    wdk.getAccount('bitcoin', 0),
    wdk.getAccount('spark', 0),
    wdk.getAccount('arbitrum', 0)
  ])
  return { wdk, bitcoin, spark, arbitrum }
}

function protocolConfig (env, sourceChain, onStateChange) {
  return {
    sourceChain,
    apiKey: env.FLASHNET_API_KEY || undefined,
    baseUrl: env.ORCHESTRA_BASE_URL || DEFAULT_BASE_URL,
    onStateChange,
    ...(sourceChain === 'arbitrum'
      ? {
          sourceTokenAddresses: {
            'arbitrum:USDT': env.ARBITRUM_USDT_ADDRESS || ARBITRUM_USDT
          }
        }
      : {})
  }
}

async function swapContext (env, directionName, onStateChange, recipientAddress) {
  const direction = directionConfig(directionName)
  const wdk = makeWdk(env)
  const sourceAccount = await wdk.getAccount(direction.sourceWallet, 0)
  const destinationAddress = recipientAddress ?? await (await wdk.getAccount(direction.destinationWallet, 0)).getAddress()
  return {
    wdk,
    protocol: new Orchestra(sourceAccount, protocolConfig(env, direction.sourceChain, onStateChange)),
    direction,
    options: {
      fromToken: `${direction.sourceChain}:${direction.sourceAsset}`,
      toToken: `${direction.destinationChain}:${direction.destinationAsset}`,
      recipient: destinationAddress
    }
  }
}

async function init () {
  if (fs.existsSync(ENV_FILE)) {
    throw new Error(`${ENV_FILE} already exists. Move it away before creating a new funded test wallet.`)
  }
  const mnemonic = WDK.getRandomSeedPhrase(12)
  const text = [
    '# Local live-test wallet. Do not commit this file.',
    `ORCHESTRA_MNEMONIC='${mnemonic}'`,
    'FLASHNET_API_KEY=',
    `ORCHESTRA_BASE_URL=${DEFAULT_BASE_URL}`,
    'BITCOIN_NETWORK=bitcoin',
    'BITCOIN_ELECTRUM_HOST=electrum.blockstream.info',
    'BITCOIN_ELECTRUM_PORT=50001',
    'SPARK_NETWORK=MAINNET',
    'ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc',
    `ARBITRUM_USDT_ADDRESS=${ARBITRUM_USDT}`,
    ''
  ].join('\n')
  fs.writeFileSync(ENV_FILE, text, { mode: 0o600 })
  await showAddresses()
}

async function showAddresses () {
  const env = readEnvFile()
  const resolved = await accounts(env)
  try {
    const { bitcoin, spark, arbitrum } = resolved
    writeJson({
      envFile: path.resolve(ENV_FILE),
      warning: 'Mnemonic is stored locally in envFile and intentionally not printed.',
      funding: {
        bitcoin: {
          address: await bitcoin.getAddress(),
          asset: 'BTC',
          unit: 'sats'
        },
        spark: {
          address: await spark.getAddress(),
          asset: 'BTC',
          unit: 'sats'
        },
        arbitrum: {
          address: await arbitrum.getAddress(),
          assets: [
            { asset: 'USDT', token: env.ARBITRUM_USDT_ADDRESS || ARBITRUM_USDT, unit: '6-decimal smallest units' },
            { asset: 'ETH', purpose: 'gas' }
          ]
        }
      },
      directions: DIRECTIONS
    })
  } finally {
    resolved.wdk.dispose()
  }
}

async function quote (args) {
  const env = readEnvFile()
  requireValue(env, 'FLASHNET_API_KEY')
  const directionName = String(args.direction || 'btc-to-arbitrum-usdt')
  const amount = requireArg(args, 'amount')
  await preflightRoute(env, directionConfig(directionName))
  const context = await swapContext(env, directionName, undefined, args.to ? String(args.to) : undefined)
  try {
    const result = await context.protocol.quoteSwidge({
      ...context.options,
      fromTokenAmount: BigInt(amount)
    })
    writeJson({ direction: directionName, amount, amountUnit: context.direction.amountLabel, quote: result })
  } finally {
    context.wdk.dispose()
  }
}

async function prepare (args) {
  const env = readEnvFile()
  requireValue(env, 'FLASHNET_API_KEY')
  const directionName = String(args.direction || 'btc-to-arbitrum-usdt')
  const amount = requireArg(args, 'amount')
  await preflightRoute(env, directionConfig(directionName))
  const context = await swapContext(env, directionName, undefined, args.to ? String(args.to) : undefined)
  try {
    const intent = await context.protocol.prepareSwap({
      ...context.options,
      fromTokenAmount: BigInt(amount)
    })
    const file = String(args.out || stateFileFor(directionName))
    writeState(file, intent)
    writeJson({ file: path.resolve(file), intent })
  } finally {
    context.wdk.dispose()
  }
}

async function execute (args) {
  if (args.yes !== true) {
    throw new Error('execute moves funds. Re-run with --yes after checking the saved intent.')
  }
  const env = readEnvFile()
  requireValue(env, 'FLASHNET_API_KEY')
  const file = requireArg(args, 'file')
  const state = readState(file)
  const direction = directionConfig(routeNameFromState(state))
  const outputFile = String(args.out || file)
  assertExecutionEnv(env, direction)
  await preflightRoute(env, direction)
  const context = await swapContext(env, routeNameFromState(state), async (_event, nextState) => {
    writeState(outputFile, nextState)
  }, state.recipientAddress)
  try {
    const submitted = await context.protocol.executeSwapIntent(state, {
      ...(args.feeRate ? { feeRate: BigInt(args.feeRate) } : {}),
      ...(args.confirmationTarget ? { confirmationTarget: Number(args.confirmationTarget) } : {}),
      ...((args['allow-new-source-payment'] === true) ? { allowNewSourcePayment: true } : {})
    })
    writeState(outputFile, submitted)
    writeJson({ file: path.resolve(outputFile), submitted })
  } finally {
    context.wdk.dispose()
  }
}

async function resume (args) {
  const env = readEnvFile()
  requireValue(env, 'FLASHNET_API_KEY')
  const file = requireArg(args, 'file')
  const state = readState(file)
  const sourceTxHash = args['source-tx-hash'] ? String(args['source-tx-hash']) : undefined
  if (!state.orderId && !state.sourceTxHash && !sourceTxHash && args['allow-new-source-payment'] !== true) {
    throw new Error('resume would send a fresh source payment. Pass --source-tx-hash if a payment was broadcast, or pass --allow-new-source-payment --yes only after wallet-history recovery.')
  }
  if (args['allow-new-source-payment'] === true && args.yes !== true) {
    throw new Error('Fresh source payment replay requires --yes.')
  }
  const direction = directionConfig(routeNameFromState(state))
  const outputFile = String(args.out || file)
  assertExecutionEnv(env, direction)
  await preflightRoute(env, direction)
  const context = await swapContext(env, routeNameFromState(state), async (_event, nextState) => {
    writeState(outputFile, nextState)
  }, state.recipientAddress)
  try {
    const next = await context.protocol.resumeSwap(state, {
      ...(sourceTxHash ? { sourceTxHash } : {}),
      ...((args['allow-new-source-payment'] === true) ? { allowNewSourcePayment: true } : {})
    })
    writeState(outputFile, next)
    writeJson({ file: path.resolve(outputFile), state: next })
  } finally {
    context.wdk.dispose()
  }
}

async function status (args) {
  const env = readEnvFile()
  requireValue(env, 'FLASHNET_API_KEY')
  const file = requireArg(args, 'file')
  const state = readState(file)
  const context = await swapContext(env, routeNameFromState(state), undefined, state.recipientAddress)
  try {
    writeJson(await context.protocol.getOrderStatus(state))
  } finally {
    context.wdk.dispose()
  }
}

async function wait (args) {
  const env = readEnvFile()
  requireValue(env, 'FLASHNET_API_KEY')
  const file = requireArg(args, 'file')
  const state = readState(file)
  const context = await swapContext(env, routeNameFromState(state), undefined, state.recipientAddress)
  try {
    const final = await context.protocol.waitForCompletion(state, {
      pollIntervalMs: args.pollIntervalMs ? Number(args.pollIntervalMs) : 1500,
      timeoutMs: args.timeoutMs ? Number(args.timeoutMs) : 600000,
      onStatus: (event) => {
        const status = event.order?.status ?? event.status ?? 'unknown'
        console.error(`status=${status}`)
      }
    })
    writeJson(final)
  } finally {
    context.wdk.dispose()
  }
}

function routeNameFromState (state) {
  const source = `${state.sourceChain}:${state.sourceAsset}`
  const destination = `${state.destinationChain}:${state.destinationAsset}`
  if (source === 'bitcoin:BTC' && destination === 'arbitrum:USDT') return 'btc-to-arbitrum-usdt'
  if (source === 'spark:BTC' && destination === 'arbitrum:USDT') return 'spark-btc-to-arbitrum-usdt'
  if (source === 'arbitrum:USDT' && destination === 'bitcoin:BTC') return 'arbitrum-usdt-to-btc'
  if (source === 'arbitrum:USDT' && destination === 'spark:BTC') return 'arbitrum-usdt-to-spark-btc'
  throw new Error(`No live harness route for ${source}->${destination}`)
}

async function preflightRoute (env, direction) {
  const url = `${String(env.ORCHESTRA_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '')}/v1/orchestration/routes`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Route preflight failed: HTTP ${response.status} from ${url}`)
  }
  const body = await response.json()
  const routes = Array.isArray(body.routes) ? body.routes : []
  const enabled = routes.some(route => {
    return route.sourceChain === direction.sourceChain &&
      route.sourceAsset === direction.sourceAsset &&
      route.destinationChain === direction.destinationChain &&
      route.destinationAsset === direction.destinationAsset
  })
  if (!enabled) {
    throw new Error(`Route preflight failed: ${direction.sourceChain}:${direction.sourceAsset}->${direction.destinationChain}:${direction.destinationAsset} is not currently enabled.`)
  }
}

function assertExecutionEnv (env, direction) {
  if (direction.sourceWallet === 'arbitrum') {
    requireValue(env, 'ARBITRUM_RPC_URL')
  }
}

function requireArg (args, key) {
  const value = args[key]
  if (value === undefined || value === true || value === '') {
    throw new Error(`--${key} is required.`)
  }
  return String(value)
}

async function main () {
  const [command, ...rest] = process.argv.slice(2)
  const args = parseArgs(rest)
  if (command === 'init') return await init()
  if (command === 'addresses') return await showAddresses()
  if (command === 'quote') return await quote(args)
  if (command === 'prepare') return await prepare(args)
  if (command === 'execute') return await execute(args)
  if (command === 'resume') return await resume(args)
  if (command === 'status') return await status(args)
  if (command === 'wait') return await wait(args)
  throw new Error(`Unknown command '${command ?? ''}'.`)
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
