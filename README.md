# DisQord

DisQord is a self-hosted QQ ↔ Discord bridge with three fixed programs:

- `central-server`: authoritative routing, PostgreSQL state, Web control plane, LLM
  translation/moderation, image-card rendering, reviews, and logs.
- `qq-node`: NapCat / OneBot 11 adapter, local SQLite outbox, and local node panel.
- `discord-node`: Discord Bot adapter, local SQLite outbox, and local node panel.

The nodes only make outbound WSS connections to the central server. They never connect to each
other and cannot exchange roles. Every forwarded platform message is a rendered PNG card. Text
and images are supported; other message types produce a bilingual unsupported-message card.
Translated text is primary, the source text appears in a translucent panel, and native reply
references are preserved when a mapping exists.

## Implemented

- One-time, node-type-bound pairing; Ed25519 signed requests; persisted, hashed central sessions.
- HMAC authenticated WSS frames, replay protection, heartbeats, reconnects, acknowledgements,
  deduplication, and local SQLite retry queues.
- NapCat group discovery, message normalization, verification messages, PNG sends, and QQ replies.
- Discord channel discovery, `MESSAGE_CONTENT` handling, verification messages, PNG sends, and
  native replies.
- OpenAI-compatible structured translation and moderation, prompt versioning, fixed prompt
  injection boundary, vision capability gate, timeout/retry handling, and manual-review fallback.
- Server-side PNG rendering with avatar, reply block, translated text, source text, images,
  pagination, and unsupported-message cards.
- Administrator login, encrypted LLM API-key storage, session verification, blueprint editor,
  review decisions, trace logs, central panel, and node diagnostics panel.

## Development

Node.js 24 LTS is recommended. Node.js 22.22 or later is supported.

```text
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

The repository is pinned to the `npmmirror.com` npm mirror in `.npmrc`.

For deployment and the exact first-run sequence, see
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md). The approved product and security requirements are in
[`PROJECT_REQUIREMENTS.md`](PROJECT_REQUIREMENTS.md).
