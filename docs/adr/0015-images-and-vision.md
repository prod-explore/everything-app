# ADR 0015 — Images: models that cannot see, and pictures that tools return

Status: accepted

## Context

Two gaps showed up together. A model that cannot read images (a subscription wrapper, a small local model) simply lost every picture the user attached, with a one-line "omitted" note. And tools could only answer in text, so the browser agent could not show what a page looks like — a chart, a canvas, a layout that looks broken — and a future tool that captures the user's own screen would have had the same problem.

## Decision

1. **Vision subagent** (`vision.ts`). A request for a model without `vision` is rewritten just before it is sent: every image is described once by a model that can see, and the description replaces the image in the text the blind model receives. The chat keeps the original image; only the copy sent to the blind model changes. Descriptions are cached by the image's hash, at most 8 new images are described per request, and an image that could not be described stays as it is, so the adapter writes its usual "omitted" note and the turn never fails because of it. The describer is chosen per call: the helper slot if it can see, else a `free` model that can, else one tagged `vision`, else any. A model that runs locally is only ever helped by another local one, so a private chat's images never go to a cloud model. Descriptions are labelled as such and, like any model output built from outside data, are content to read, not instructions.
2. **Images in tool results** (`tool-images.ts`). An MCP result can carry `image` blocks (PNG, JPEG, WebP, GIF; at most 4 per result, 4 MB each — anything else is left out with a note in the text). They travel inside the `tool_result` next to its text, are stored with the history like an attached image, and reach a vision model on the next request. On chat-completions a tool message can only hold text, so the adapter says "image — attached in the next message" there and sends the pictures in the user message that follows. A model that cannot see gets the description from point 1, because the describer also looks inside tool results.
3. **Only the newest two tool pictures are sent** (`dropOldToolImages`, applied to the per-request view before trimming). Older ones become a one-line note; the stored history keeps every picture, so the chat still shows them. Pictures the user attached are never dropped. A failed tool call carries no picture.
4. **`browser_screenshot`** (playwright-mcp) is the first producer: the visible window of the active tab, or the whole page with `full_page` (cut at 6000 px, and said so), as a JPEG. It is read-only, so it is auto-approved and stays allowed after a page looked like a prompt injection, like `browser_observe`. Text in the picture is page content: the tool says so in its description and in every result.
5. **The chat** shows the pictures of a tool call as thumbnails in its card (click to enlarge). They appear when the turn ends and the stored version replaces the live one.

## Consequences

- A blind model can still work with screenshots and photos, at the price of a describer call per new image (counted like any other model call) and of what words cannot carry — exact pixels and fine layout. For those, give the chat a model that can see.
- A screenshot costs roughly the tokens of one attached image on a vision model; keeping only the newest two bounds a long browsing session.
- Anything that can return an MCP `image` block now works the same way, which is what a later tool that captures the user's screen will use.
