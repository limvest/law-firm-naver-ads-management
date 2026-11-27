# Repository operating instructions

Before any production deployment, domain, database, Cloudflare, or server operation, read [`docs/PRODUCTION-OPERATIONS.md`](docs/PRODUCTION-OPERATIONS.md) in full.

Critical rule: `sampleone.attorney`, `*.sampleone.attorney`, and `fintech.sampleone.attorney` are served through Cloudflare Tunnel from the A1 server. A successful Vercel deployment does not update those live sites while their DNS records point to the tunnel.

For ordinary website changes, deploy only the A1 `web` service. Do not rebuild or restart PostgreSQL, `click-listener`, or scheduled collection services unless the task explicitly requires them. Always retain a rollback image and the preceding release directory, then verify through both `127.0.0.1:3100` with the real `Host` header and the public URL.
