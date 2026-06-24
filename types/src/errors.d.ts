export class OrchestraError extends Error {
  code: string
  details?: unknown
  constructor(code: string, message: string, details?: unknown)
}

export class OrchestraApiError extends OrchestraError {
  status: number
  constructor(code: string, message: string, status: number, details?: unknown)
}

export class OrchestraTimeoutError extends OrchestraError {
  constructor(message: string, details?: unknown)
}

export class OrchestraStateError extends OrchestraError {
  constructor(message: string, details?: unknown)
}

export class OrchestraSubmitError extends OrchestraError {
  state: unknown
  cause?: unknown
  constructor(message: string, state: unknown, cause?: unknown)
}
