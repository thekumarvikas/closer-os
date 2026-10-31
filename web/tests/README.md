# Web dashboard end-to-end test

Runs the real dashboard in a browser against the real Supabase project with two temporary
users (owner + rep), checks the main flows, saves screenshots, then deletes all test data.

    cd web && npm run build && npx vite preview --port 4173 &
    SB_SECRET=... SB_PUB=... NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt \
      node tests/e2e.cjs /path/to/screenshots

`SB_SECRET`/`SB_PUB` come from the Management API (`/v1/projects/<ref>/api-keys?reveal=true`);
never commit them. In the cloud sandbox, Chromium trusts the proxy CA via `certutil` (see CLAUDE.md).
