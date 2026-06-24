import Orchestra from './src/orchestra.js'

export default Orchestra
export {
  default as Orchestra
} from './src/orchestra.js'
export type {
  AppFee,
  AssetRef,
  AuthMode,
  DestinationRef,
  ExecuteSwapOptions,
  OrchestraAmount,
  OrchestraAuthHeaders,
  OrchestraConfig,
  OrchestraSwapIntent,
  OrchestraSwapOptions,
  OrchestraSwapResult,
  OrchestraSwapState,
  OrchestraSwidgeOptions,
  OrchestraSwidgeStatusOptions,
  OrderSubscription,
  OrderSubscriptionCallbacks,
  OrderProjection,
  PrepareSwapOptions,
  StatusResponse,
  StatusTarget,
  WaitForCompletionOptions
} from './src/orchestra.js'
export {
  isTerminalOrderStatus,
  OrchestraClient
} from './src/orchestra-client.js'
export type {
  OrchestraClientConfig,
  RequestOptions,
  SubmitOptions
} from './src/orchestra-client.js'
export {
  OrchestraApiError,
  OrchestraError,
  OrchestraStateError,
  OrchestraSubmitError,
  OrchestraTimeoutError
} from './src/errors.js'
