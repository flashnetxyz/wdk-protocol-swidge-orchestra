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

/** @typedef {import('@tetherto/wdk-wallet/protocols').SwidgeOptions} SwidgeOptions */
/** @typedef {import('@tetherto/wdk-wallet/protocols').SwidgeResult} SwidgeResult */

/** @typedef {import('./src/orchestra.js').OrchestraConfig} OrchestraConfig */
/** @typedef {import('./src/orchestra.js').OrchestraSwapIntent} OrchestraSwapIntent */
/** @typedef {import('./src/orchestra.js').OrchestraSwapState} OrchestraSwapState */

export { default, default as Orchestra } from './src/orchestra.js'
export { OrchestraClient, isTerminalOrderStatus } from './src/orchestra-client.js'
export {
  OrchestraApiError,
  OrchestraError,
  OrchestraStateError,
  OrchestraSubmitError,
  OrchestraTimeoutError
} from './src/errors.js'
