# Database tests

`rls_test.sql` checks the access rules with fake users (owner, manager, two reps, an outsider).
It always rolls back, and its "error" message is the test report:

    scripts/db-apply.sh supabase/tests/rls_test.sql
