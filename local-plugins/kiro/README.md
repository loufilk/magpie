# @magpie-community/opencode-kiro-auth

Signs in to a [Kiro](https://kiro.dev) subscription (Free, Pro, Pro+,
Power) and makes its requests, in OpenCode and in magpie. Provider id:
`kiro`.

## Pinned custom build

This local package combines custom Kiro commit
`780aa7a717bbab5a2e74a7f12e0cbd8b66d9a13a` with the Kiro changes in
[magpie-community/plugins at `fd40b20c3bad27144a9041839c6b2e0aa60ec203`](https://github.com/magpie-community/plugins/tree/fd40b20c3bad27144a9041839c6b2e0aa60ec203/packages/kiro).
Their common repository ancestor is
`ba9801c953948c6ff4d435dbc529f39916f3bdc9`; its latest Kiro change was
`9f6c4e8861260acdfb0b6849b0d05545c535ff53` (0.1.16).

The aligned package version is 0.1.18, not an unmodified npm build. It keeps
this fork's native effort, GPT Chat, unknown-cache and reported-zero input
behavior. The upstream additions are 0.1.17's numeric credit windows
(`amount`, `limit`, `unit`) for Magpie's remaining-credit display and
0.1.18's oversized-image handling described below. Use this pinned local
source, not the official npm package as a substitute for the custom code.

## Signing in

- **Kiro (Google, GitHub, AWS Builder ID, IAM Identity Center)**: the Kiro
  IDE's own sign-in.
  - Kiro's page (`app.kiro.dev/signin`) sends the browser back to one of
    the ports the IDE listens on (3128, 4649, 6588, 8008, 9091, 49153,
    50153–53153) on `127.0.0.1`. While the IDE is signing in, those ports
    may be busy.
  - Google and GitHub come back with a code. Kiro's auth service trades it
    for tokens.
  - Builder ID and Identity Center come back with an AWS sign-in URL and
    region. The plugin registers a client with AWS's OIDC service, sends
    the browser to AWS, and trades the code AWS returns.
  - The account is named by the email Kiro has for it (`Get-Usage-Limits`)
    and the way it was signed in to: `email (Google)`, `email (GitHub)`,
    `email (Builder ID)`, `email (IAM Identity Center)`, `email
    (Internal)`. Its plan is read from the same call, and its usage names
    it the same way.
  - Kiro keeps a Google, a GitHub, a Builder ID and an Identity Center
    sign-in of one email as different accounts. The sign-in carries a `uid`
    (`google`, `github`, `builderid`, `enterprise`), so magpie keeps each one
    beside the others, and a sign-in again the same way replaces only its
    own account. An account signed in before 0.1.13 is given its `uid`,
    and one named by its bare email before 0.1.14 its name, on its first
    request, model listing, usage read or renewal. Until then, a sign-in
    again the same way goes beside it rather than replacing it: magpie
    matches a sign-in by its name, and the plugin can't see the other
    accounts to match it by `uid`.
  - A company's own identity provider (`external_idp`) is not supported
    here. Sign in with `kiro-cli login` and use the next method instead.
- **Kiro CLI's or Kiro IDE's sign-in**: uses the account kiro-cli is signed
  in to, or else the Kiro IDE's. Nothing is copied. It is read each time
  from where they keep it:
  - kiro-cli: its SQLite database's `auth_kv` table.
    - macOS: `~/Library/Application Support/kiro-cli/data.sqlite3`
    - Linux: `~/.local/share/kiro-cli/data.sqlite3`
    - Windows: `%APPDATA%\kiro-cli\data.sqlite3`
  - The IDE: `~/.aws/sso/cache/kiro-auth-token.json`.

  kiro-cli refreshes its own token first (`kiro-cli debug refresh-auth-token`).
  A token the plugin refreshes itself is written back, so kiro-cli and the
  IDE go on with it.
- **Kiro API key (`ksk_…`)**: sent with `tokentype: API_KEY`, as kiro-cli
  sends it. `GetProfile` is asked in us-east-1, then eu-central-1, for the
  region the key's profile is in; a key it finds none for is used in
  us-east-1, as kiro-cli uses it. Its models are listed with the control
  plane's `ListAvailableModels` and its credits with `GetUsageLimits`, and
  no profile is named in its calls, as kiro-cli names none.

A browser sign-in is kept where OpenCode keeps sign-ins (`auth.json`; in
magpie, `plugin-auth.json`) as an `oauth` entry. The entry holds the
tokens, the profile ARN, the region and, for AWS, the registered client.
Refreshing such a sign-in:

- magpie renews the token 10 minutes before it expires, through the
  plugin's `auth.refresh`, once for the account and before its requests,
  models and usage need it. magpie saves the new token. A failed renewal,
  even one Kiro refused, doesn't mark the account: it is tried again.
- OpenCode doesn't call that hook: there the token is refreshed 2 minutes
  before it expires, before a request, and saved.
- Either way, a token Kiro turns down (a 403) is refreshed and the request
  tried once more.
- Only one refresh runs at a time, magpie's renewal included, and a token
  refreshed but not yet saved is used rather than spending the old refresh
  token again.
- kiro-cli's and the IDE's sign-ins aren't renewed by magpie: they are
  refreshed before a request, as above, and written back.

Tokens are refreshed through:

- Google/GitHub: through `prod.<region>.auth.desktop.kiro.dev/refreshToken`.
- Builder ID/Identity Center: through AWS's `oidc.<region>.amazonaws.com/token`.

## Requests

Kiro has no API OpenCode speaks. Claude and other models use Anthropic's
Messages (`@ai-sdk/anthropic`); catalog-confirmed GPT reasoning models use
Chat completions (`@ai-sdk/openai-compatible`). The plugin's `fetch`
handles each request:

- It sends the request to `runtime.<region>.kiro.dev/generateAssistantResponse`,
  the API kiro-cli uses, with kiro-cli's headers. The region is the one the
  profile ARN names.
- It turns the request into a Kiro conversation:
  - The system prompt goes at the head of the first message.
  - Tool calls and results are paired: an unanswered call gets an error
    result, and a result longer than 250,000 characters is cut.
  - Tool ids Kiro wouldn't take are rewritten. A tool name over 64
    characters (an MCP plugin's, in Claude Code) is sent shortened with a
    hash and its calls come back under the full name.
  - A tool's images (a screenshot, Codex's view_image) go with the
    message that answers the call, as Kiro's tool results hold text alone.
  - Only the latest images are sent.
  - An image Kiro would turn away for size (over 5 MiB as Base64, which is
    3.75 MiB of file) is made smaller on the request being sent: its long
    edge brought to 2000 pixels, then WebP or JPEG, smaller each try. One
    that can't be read or brought under is replaced by a short note, so the
    conversation goes on (#428). Smaller images are sent as they are.
  - Tools the history used but the request doesn't offer are declared.
- It turns the AWS event stream Kiro answers with back into the selected
  protocol's streamed events or one response. The reply includes text, thinking,
  tool calls and usage. When Kiro reports only how full the context is,
  input tokens are estimated from that.
- Native reasoning effort is sent in `additionalModelRequestFields`, at
  the path and exact level advertised by that account's model catalog.
  It is not converted into a prompt token budget (see below).
- Explicit legacy thinking on Claude and Auto still uses prompt tags.
  Thinking text, whether in tags or native reasoning events, comes back
  separately from the answer.
- Kiro's failures keep their meaning:
  - input too long → 400
  - no capacity → 503
  - usage limit → 429
  - throttling → "rate limited"

## Cache accounting

Caller cache marks are still forwarded as Kiro cache points. Their presence
or absence is not itself a measured cache hit or miss. When Kiro omits
`tokenUsage`, the plugin retains its input/context and output/text estimates
but does not invent cached-token counts: Messages omits
`cache_read_input_tokens` and `cache_creation_input_tokens`; Chat omits
`prompt_tokens_details`. Both set `usage.magpie_cache_unknown: true`.
Consumers must understand that marker rather than turn absent counts into a
zero-percent cache rate. Reported cache counts, including a reported zero,
remain numeric. Chat includes both `prompt_tokens_details.cached_tokens`
(reads) and `prompt_tokens_details.cache_write_tokens` (writes), while its
prompt total still includes uncached input, reads and writes exactly once.
Consumers need to preserve the write detail as well as the read detail.
Credits are not converted into made-up token counts.

A reported input count of zero is preserved; it is not replaced by the
legacy alias or a context-percentage estimate. Missing/null input counts
keep the existing alias/context fallback. This does not infer what an
undocumented alias includes or subtract cached tokens from it.

This is separate from the short-lived model capability catalog cache used
for native effort validation. The custom native-effort changes still need
the pinned fork commit; the upstream 0.1.18 package version alone does not
identify this custom build.

## Models

The `config` hook declares `auto` (Kiro picks the model). Once signed in,
the `provider.models` hook replaces it with the account's own list from
`List-Available-Models`, with the default first. Each model carries its
context window, output limit and whether it takes images. Native effort
variants are offered only when the model's
`additionalModelRequestFieldsSchema` advertises an effort enum. A model
name alone is not evidence of support; Auto has no native effort variants.

GPT models whose schema advertises `reasoning.effort` use
`@ai-sdk/openai-compatible` and Chat completions. Other models keep
Anthropic Messages. This preserves GPT's named effort before Magpie's
Anthropic conversion could collapse it into a token budget.

## Native effort and thinking

This fork implements the catalog-driven wire path; it has **not** been
tested against a real Kiro account. The schema layout was cross-checked
against the MIT-licensed [kirogo catalog implementation](https://github.com/jasminnanda/kirogo/blob/3b2ca22714c7296ad1a48133b3d7e0fe2ba2110e/internal/catalog/effort.go).
That third-party evidence and mocked tests do not prove Kiro will accept a
field or honor an effort internally. No GPL implementation was copied.

- Messages input accepts `output_config.effort`, `reasoning.effort` or
  `reasoning_effort`. These are input aliases, not support for the full
  OpenAI Responses API. Chat input normally uses `reasoning_effort`.
  Conflicting explicit values are rejected with HTTP 400.
- The catalog decides the outgoing path: commonly
  `additionalModelRequestFields.output_config.effort` for Claude or
  `additionalModelRequestFields.reasoning.effort` for GPT. Values are
  never clamped or inferred from a budget. `xhigh` and `max` stay
  distinct; `none` is sent only if this model explicitly lists it.
- A `model:level` suffix is a fallback, below an explicit request field.
  An exact catalog model ID wins over suffix interpretation. With no
  requested effort, no effort or schema default is injected; Kiro keeps
  its own default.
- Explicit effort requires a matching catalog model and schema. Missing
  support or an unsupported level is HTTP 400; a failed catalog read is
  HTTP 502 before generation, rather than a silent downgrade. A catalog
  403 renews credentials and reads the new account's schema once; at most
  one renewal is attempted across catalog and generation for a request.
  Ordinary Messages requests without effort do not depend on a catalog
  read.
- The catalog cache is private to each plugin instance and keyed by a
  hash of token type, token, region and profile. It holds at most 16
  entries for five minutes, coalesces concurrent reads, and caches no
  failed reads. A model with no effort schema is rechecked on its next
  effort request. `provider.models` explicitly refreshes it. Credential
  renewal revalidates native capability before retrying generation.
  Only normalized model fields and effort enums are retained, not raw
  catalog records.
- Effort does not select a legacy thinking budget. On native requests,
  `thinking.type: adaptive` or enabled without `budget_tokens` adds no
  default 20k prompt constraint. An explicit enabled `budget_tokens`
  remains an independent legacy Claude prompt budget. Without native
  effort, existing enabled/adaptive Claude/Auto requests keep the 20k
  fallback. These prompt tags are not native thinking fields.
- Disabled thinking plus non-`none` effort, or enabled/adaptive thinking
  plus `none`, is rejected as contradictory. Disabled thinking without
  effort only suppresses legacy prompt tags; it does not promise the
  server will stop reasoning. To request native `none`, explicitly send
  that effort and use a model whose schema allows it.
  `thinking.display: omitted`
  hides returned thinking locally; it neither changes effort nor promises
  the server did not reason. `summarized` leaves returned thinking visible.
- A GPT request already reduced to an Anthropic thinking budget is
  rejected clearly: the plugin cannot reconstruct its original level.
  Refresh the model list to select the GPT Chat route instead. Magpie can
  still normalize unsupported levels before the plugin sees them, and
  some host translations normalize `minimal` to `low`; this plugin
  guarantees only the value it actually receives and validates.

The narrow GPT Chat adapter shares the existing Kiro conversation builder,
authentication, history/tool pairing and event decoder. It supports text,
inline base64 images, function tools and results, prompt-based JSON-schema
format requests (not an enforced output guarantee), streamed/non-streamed replies, reasoning text and usage. Remote image URLs,
non-function tools, forced/disabled `tool_choice`, stop sequences,
`parallel_tool_calls: false` and `n` other than 1 are rejected rather than
silently discarded. Token/output caps (`max_tokens`,
`max_completion_tokens`), `temperature` and `top_p` keep the existing
Messages-to-Kiro limitation: this adapter does not forward or enforce
those controls. It does not add a general Responses adapter.
The existing tool-history and prompt-cache behavior is retained.

Validation uses synthetic credentials, a temporary HOME and mocked network
responses: `bun test packages/kiro`, `bun scripts/check.mjs kiro`, and
`node --check packages/kiro/index.mjs`. A real Kiro call, real Magpie
end-to-end execution, npm publishing and deployment are outside this
change's verification.

## Not included

- Usage and quota (credits, the monthly window).
- Switching between several accounts. OpenCode keeps one sign-in per
  provider.
- Signing in with a company's own identity provider in the browser (use
  kiro-cli's sign-in).
- magpie's web-search stand-in for Kiro.
