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
