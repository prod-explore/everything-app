# web

The EverythingApp UI: React 19, Vite, Tailwind 4, [assistant-ui](https://www.assistant-ui.com) for the chat primitives. It talks to the orchestrator in [`../cli`](../cli) over REST and SSE with a session cookie; there is no token in `localStorage` or in URLs.

```bash
npm ci
npm run dev                          # Vite on :5173, proxies /api to http://localhost:3000
API_TARGET=http://localhost:3100 npm run dev   # …or to another backend
npm run typecheck && npm run lint && npm test
npm run build                        # tsc -b && vite build → dist/ (served by the orchestrator)
```

`npm run lint` is `oxlint --deny-warnings`: a new warning fails CI.

## Layout

| Path | What lives there |
|---|---|
| `src/App.tsx` | Shell: sidebar (chats, projects), chat, side panels |
| `src/components/chat` | Messages, composer, the effort/context controls, blocking questions |
| `src/components/approval` | Inline approval cards |
| `src/components/{agents,gazeta,browser,files,scm,git,github,workspace}` | Side panels: workers, inbox, live browser view, file explorer, source control |
| `src/components/settings` | Providers, model slots, usage, connectors, web access, notifications, skills |
| `src/hooks` | Data hooks: conversations, SSE stream, approvals, models, settings |
| `src/api.ts` | Typed fetch layer; every call goes through one place that handles auth expiry |

The live browser view streams JPEG frames from `playwright-mcp` over a WebSocket that the orchestrator relays (same origin, cookie-authenticated, no second port). You can watch, or take control; the panel reports its size so the remote viewport matches it.
