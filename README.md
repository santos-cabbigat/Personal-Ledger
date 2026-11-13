# Personal & Business Ledger

[Open the ledger](https://santos-cabbigat.github.io/Personal-Ledger/) · [Try the sample books](https://santos-cabbigat.github.io/Personal-Ledger/?preview=1).

GitHub Pages hosts the interface. The personal Supabase project handles passwords, sessions, live accounting records, and report data. The existing Google workbook keeps original journal revisions, including records later summarized in Supabase. No accounting data or private credentials belong in this repository.

## Using the ledger

Choose **Set up login** once with the email registered for this ledger, confirm the email, then sign in. Returning devices reuse their Supabase session. **Journal** records transactions. **Expense** shows the selected month’s spending by book and account, net of credits and refunds.

**Settings** shows database size, the time of the last completed archive, and outstanding revisions. The warning starts at 60% of the configured database allowance and turns red at 75%. If the project is unavailable, the owner can open its Supabase dashboard to check its status and restore it.

**Settings → Manage archived entries** previews a book and date range, optionally restricted to whole entries touching one account. Confirming replaces eligible journals with a separate balanced summary on every posting date. The summaries retain gross debits and credits by account, posted entry counts, and opening bank funds. This preserves the General Ledger and Trial Balance at dates inside the selected range as well as afterward. Drafts and changes awaiting archive verification remain in the live database. Historical descriptions and references can be read in the Sheet.

## Installation for the workbook owner

1. Apply `supabase/personal-ledger.sql` once to the intended personal project. Set the Supabase Auth site URL to the Pages address, and allow that address with `?reset=1` for password recovery.
2. In the workbook’s bound Apps Script project, keep the existing workbook functions, add `apps-script/PersonalArchive.gs`, and apply the manifest scopes in `apps-script/appsscript.json`. Run **preparePersonalArchive** as the workbook owner. Its log gives a SHA-256 fingerprint. The private archive credential remains in Script Properties.
3. Using the personal Supabase SQL editor, insert the workbook identifier and the fingerprint into `ledger.settings(workbook,title,archive_key_hash)`. Run **startPersonalLedger** in Apps Script. It imports the workbook, creates a daily trigger around 2 a.m. Laos time, and runs the first archive. Verify both the imported books and the completed archive before switching the live website. Update the legacy script deployments with the workbook archive guard, publish the new Pages interface, and run **activatePersonalLedger** to direct the old workbook menu to the site. Record future transactions through the website.
4. Each archived revision is appended to the **Ledger Archive** tab, read back, and acknowledged. On retry the script checks the stored revision and part number. Confirming the archive never clears or rewrites earlier journal revisions.

## Development

Edit the Pages interface under `docs`, the database operations under `supabase`, and the archive code under `apps-script`. Run `node scripts/build.mjs` to regenerate the bound interface and installer. Run `npm ci && npm test` for browser, Sheet, and database regression checks. The PostgreSQL fixture uses synthetic entries.
