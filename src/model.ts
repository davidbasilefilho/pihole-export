import { Data, Schema } from "effect"

const OptionalText = Schema.optionalWith(Schema.String, { default: () => "" })

export const AuthMethod = Schema.Literal("password", "session", "none")
export type AuthMethod = typeof AuthMethod.Type

export const ConnectionForm = Schema.Struct({
  host: Schema.NonEmptyTrimmedString,
  scheme: Schema.Literal("http", "https"),
  port: OptionalText,
  authMethod: AuthMethod,
  secret: OptionalText,
  totp: OptionalText,
})
export type ConnectionForm = typeof ConnectionForm.Type

export const FilterForm = Schema.Struct({
  from: Schema.NonEmptyTrimmedString,
  until: Schema.NonEmptyTrimmedString,
  timezone: Schema.NonEmptyTrimmedString,
  disk: Schema.Boolean,
  domain: OptionalText,
  clientIp: OptionalText,
  clientName: OptionalText,
  upstream: OptionalText,
  type: OptionalText,
  status: OptionalText,
  reply: OptionalText,
  dnssec: OptionalText,
})
export type FilterForm = typeof FilterForm.Type

export const Session = Schema.Struct({
  valid: Schema.Boolean,
  totp: Schema.Boolean,
  sid: Schema.NullOr(Schema.String),
  csrf: Schema.optional(Schema.NullOr(Schema.String)),
  validity: Schema.Number,
  message: Schema.NullOr(Schema.String),
})
export const AuthResponse = Schema.Struct({ session: Session, took: Schema.optional(Schema.Number) })
export type Session = typeof Session.Type

export const ApiErrorResponse = Schema.Struct({
  error: Schema.Struct({
    key: Schema.String,
    message: Schema.String,
    hint: Schema.optional(Schema.Unknown),
  }),
  took: Schema.optional(Schema.Number),
})

export const Query = Schema.Struct({
  id: Schema.Number,
  time: Schema.Number,
  type: Schema.String,
  domain: Schema.String,
  cname: Schema.NullOr(Schema.String),
  status: Schema.NullOr(Schema.String),
  client: Schema.Struct({ ip: Schema.String, name: Schema.NullOr(Schema.String) }),
  dnssec: Schema.NullOr(Schema.String),
  reply: Schema.Struct({ type: Schema.NullOr(Schema.String), time: Schema.Number }),
  list_id: Schema.NullOr(Schema.Number),
  upstream: Schema.NullOr(Schema.String),
  ede: Schema.Struct({ code: Schema.Number, text: Schema.NullOr(Schema.String) }),
})
export type Query = typeof Query.Type

export const QueryResponse = Schema.Struct({
  queries: Schema.Array(Query),
  cursor: Schema.NullOr(Schema.Number),
  recordsTotal: Schema.Number,
  recordsFiltered: Schema.Number,
  draw: Schema.Number,
  earliest_timestamp: Schema.Number,
  earliest_timestamp_disk: Schema.Number,
  took: Schema.optional(Schema.Number),
})

const StringArray = Schema.Array(Schema.String)
export const SuggestionsResponse = Schema.Struct({
  suggestions: Schema.Struct({
    domain: StringArray,
    client_ip: StringArray,
    client_name: StringArray,
    upstream: StringArray,
    type: StringArray,
    status: StringArray,
    reply: StringArray,
    dnssec: StringArray,
  }),
  took: Schema.optional(Schema.Number),
})
export type Suggestions = typeof SuggestionsResponse.Type["suggestions"]

export class ValidationError extends Data.TaggedError("ValidationError")<{ readonly message: string }> {}
export class NetworkError extends Data.TaggedError("NetworkError")<{ readonly message: string }> {}
export class ApiError extends Data.TaggedError("ApiError")<{
  readonly status: number
  readonly key: string
  readonly message: string
}> {}
export class DecodeError extends Data.TaggedError("DecodeError")<{ readonly message: string }> {}
export class WriteError extends Data.TaggedError("WriteError")<{ readonly path: string; readonly message: string }> {}

export type AppError = ValidationError | NetworkError | ApiError | DecodeError | WriteError
