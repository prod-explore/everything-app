# 0022 — Retries live in the adapter, streams are retried as streams, cut-short replies are kept

**Status:** accepted

**Context.** Free tiers and busy providers answer "not now" often: 429 with a per-minute quota, 503 at peak hours, an error event in the middle of a stream. The first version retried twice within about three seconds, while a provider typically asks for 30 to 60 seconds. On a failed streamed request it repeated the whole prompt as a plain request, which retried again: one failure cost four requests against the same per-minute quota and the answer, when it came, arrived all at once. A reply that broke off, or that the user stopped, was thrown away together with the text already on screen.

**Decision.**

- **One retry loop in the provider adapter**, shared by streamed and plain requests. Transient failures (429, 502, 503, 504, a dropped connection, an in-stream error before anything was produced) are retried for a time budget, 2 minutes by default and set per provider (`0` = off). A server's `Retry-After`, or the `retry_after_s` a gateway puts in the body, decides the pause; when it is longer than what is left of the budget the request fails at once with the time to retry. A used-up quota or budget is never retried and its message says when it comes back.
- **A stream is retried as a stream.** No fallback to a plain request on an HTTP error, so each attempt is one request and the answer still streams after a retry.
- **An error after the first token is not retried**: the text already shown is kept, the reply is marked interrupted and the person chooses Continue, Retry or another model.
- **Retries are visible where they happen.** The countdown goes only to the chat that waits; the Stop button cancels the wait.
- **Background calls stay out of the way.** Titles, compaction and image descriptions use the helper model, preferably a different free model than the chat's, with two quick retries only; a failing helper is skipped for five minutes and the title falls back to the first words of the message.
- **Pacing belongs to the gateway.** The app does not count a provider's requests or tokens per minute; a gateway in front of a quota-limited provider (MindGate's `rpm`/`tpm`) makes bursts wait instead of fail.

**Consequences.** A busy provider costs time, not requests, and a turn can sit in a countdown for up to the budget before it fails. The countdown is not restored after a page reload; the next attempt brings it back. Pacing needs a gateway; without one, bursts against a small quota still fail after the budget.

## Addendum: models that think for minutes

**Context.** A thinking model behind a gateway (a subscription wrapper at a high thinking level, 90-140k tokens of prompt) says nothing for more than 90 seconds and then answers. A single "nothing for 90 s" limit cut those turns off and the person had to type "continue"; raising it to minutes would make a really hung request cost minutes as well.

**Decision.**

- **Two limits instead of one.** The *idle* limit (`FIRST_BYTE_TIMEOUT_S`, 90 s) runs from the last byte received; every byte restarts it, SSE comments included (the agy bridge and MindGate send `: keep-alive` while a model thinks), so a live model may think as long as its gateway allows. The *first-content* limit (`FIRST_CONTENT_TIMEOUT_S`, 10 min) is a hard stop on the time to the first text or reasoning, whatever keep-alives arrive; it is what ends a request that a gateway keeps "alive" for a model that never answers. Both stop at the first text or reasoning, neither runs while the adapter backs off before its own retry, and both are off for scheduled (unattended) runs. A provider that sends no keep-alives behaves as before: idle is then the old first-byte limit.
- **The adapter reports activity.** `StreamOptions.onActivity` is called for every chunk read from the network, before any parsing; the turn loop restarts the idle clock from it. A client without it (a test double) keeps the plain first-byte behaviour.
- **One automatic repeat of the request** (`modelRetries`, default 1) when it ends with either limit before any text, or with an empty answer (no text, no tool call; reasoning alone is not an answer). Only that request is made again: tools that ran in earlier steps are in the history and never run twice, a request that already streamed text is never repeated (the person has read it, the reply is kept as cut short), the stop button wins, and the response that was thrown away is still counted in the usage ledger. The chat shows it with the same notice as a provider retry (`provider:retry` with `status: "timeout"` or `"empty"`, no delay), and the reasoning of the failed request is closed so the second one starts a new part. When the repeat fails too the error says so ("already retried once automatically") and names the limit that was hit.

**Consequences.** A long-thinking model costs time instead of an error, a hung one is still cut after 90 s (no keep-alives) or 10 min (keep-alives), and an empty or silent response costs at most one extra request. The hard limit is a trade: a model that really needs longer than 10 minutes to start must have `FIRST_CONTENT_TIMEOUT_S` raised or set to 0. Needs no change in a gateway that sends no keep-alives; with MindGate and the agy bridge it needs their heartbeats (MindGate's own comment every 10 s covers it even when the bridge is old).
