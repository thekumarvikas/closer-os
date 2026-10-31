# Web dashboard end-to-end test

Runs the real dashboard in a browser against the real Supabase project with two temporary
users (owner + rep), checks the main flows, saves screenshots, then deletes all test data.

    cd web && npm run build && npx vite preview --port 4173 &
    SB_SECRET=... SB_PUB=... NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt \
      node tests/e2e.cjs /path/to/screenshots

`SB_SECRET`/`SB_PUB` come from the Management API (`/v1/projects/<ref>/api-keys?reveal=true`);
never commit them. In the cloud sandbox, Chromium trusts the proxy CA via `certutil` (see CLAUDE.md).

`reports-test.cjs` seeds a temporary company with 4 reps and ~30 days of calls (~8,600), checks the
report numbers against an independent count, checks a rep only sees their own calls, takes
screenshots of Dashboard and every Reports tab, then deletes everything. Same env vars as above.

`webinar-test.cjs` runs the webinar flow through the real screens: buyers upload, new webinar,
registrations import (with repeats), reminder assignment, a Zoom attendee report (email + phone
matching, multiple joins summed, new attendees added), reminder and sales calls, then checks the
batch report numbers per rep against an independent count. Cleans up after itself.
