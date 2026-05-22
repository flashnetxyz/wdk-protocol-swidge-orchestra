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

export class OrchestraError extends Error {
  constructor (code, message, details) {
    super(message)
    this.name = 'OrchestraError'
    this.code = code
    this.details = details
  }
}

export class OrchestraApiError extends OrchestraError {
  constructor (code, message, status, details) {
    super(code, message, details)
    this.name = 'OrchestraApiError'
    this.status = status
  }
}

export class OrchestraTimeoutError extends OrchestraError {
  constructor (message, details) {
    super('timeout', message, details)
    this.name = 'OrchestraTimeoutError'
  }
}

export class OrchestraStateError extends OrchestraError {
  constructor (message, details) {
    super('invalid_state', message, details)
    this.name = 'OrchestraStateError'
  }
}

export class OrchestraSubmitError extends OrchestraError {
  constructor (message, state, cause) {
    super('submit_failed_after_source_payment', message, { state })
    this.name = 'OrchestraSubmitError'
    this.state = state
    this.cause = cause
  }
}
