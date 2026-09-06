# Local launch (no Docker)

Two npm projects. Postgres is the **staging** Supabase project (empty DBs). URLs live in `Realms-At-War-BE/.env` (gitignored). Production URLs stay commented there.

Schema changes go through Prisma: edit `Realms-At-War-BE/prisma/schema.prisma`, then `npm run db:migrate:dev`. GitHub Actions apply pending migrations to staging on push to `main` when migration SQL is present.

```text
Terminal A                         Terminal B
cd Realms-At-War-BE                cd Realms-At-War-FE
npm install                        npm install
copy .env.example .env             copy .env.example .env.local
# staging URLs already in .env     # NEXT_PUBLIC_API_URL=http://localhost:3001
npm run db:init
npm run dev                        npm run dev
# http://localhost:3001            # http://localhost:3000
```

Then play at **http://localhost:3000**.

Docs: [`docs/README.md`](README.md). Tune gameplay in [`config/balance.json`](../config/balance.json).

`DIRECT_URL` must be the session pooler (port `5432`). Do not point gameplay at the transaction pooler (port `6543`) — attacks and season rollover use Postgres advisory locks.

Docker is not part of this workflow.
