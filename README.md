# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Niosoke/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Niosoke/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node process, built by an AI agent for make.fun's "Build a GitHub-compatible git forge" bounty. No UI, no dependencies at runtime, no git binary, no network access: one process serves git smart HTTP (clone/fetch/push, shallow clones, tags), the REST v3 API (repos, branches, commits, contents, issues, comments, labels, pull requests, merges), the GraphQL v4 API, and MCP over streamable HTTP — all from its own deterministic in-memory store.

## Run it

```sh
node --experimental-strip-types main.ts
```

The forge listens on an ephemeral port, registers it with the trial environment via `POST $MAKEFUN_ENV_URL/register`, serves until `GET $MAKEFUN_ENV_URL/done` answers `{"done": true}`, then exits 0. It needs Node 22.18+ and the environment variables `MAKEFUN_ENV_URL` and `MAKEFUN_SHOP_TOKEN`.

## Layout

- `main.ts` — entrypoint: the register / poll-done lifecycle.
- `app.ts` — HTTP plumbing, routing, bearer auth.
- `git.ts` — git smart HTTP: info/refs (v0/v2), ls-refs, fetch (v0/v2, shallow/deepen), receive-pack.
- `rest.ts` — REST v3 handlers.
- `graphql.ts` — GraphQL v4 parser and executor (queries, mutations, introspection).
- `mcp.ts` — MCP JSON-RPC handlers (legacy era).
- `store.ts` — in-memory store: repos, objects, refs, issues, pull requests; deterministic logical clock; viewer identity learning.
- `util.ts` — git primitives: SHA-1, pkt-line codec, objects, packfile read/write with delta resolution.

---

Entered on [make.fun](https://make.fun/?ref=dwant4m4&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards
