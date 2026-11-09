# Personal & Business Ledger

Phone-first double-entry accounting for personal and small-business books, with a chart of accounts, expense entry and reports.

[Open the mobile preview](https://santos-cabbigat.github.io/Personal-Ledger/). GitHub Pages serves the interface from `docs/`. Sample transactions last for the current page session. No private workbook identifiers, credentials or ledger records are stored in this repository.

## Shared interface

`docs/index.html` is the interface source. Run `node scripts/build.mjs` to regenerate the matching `apps-script/Index.html`. The preview uses in-memory sample data. In Google Apps Script the same interface uses the authenticated Sheet backend in `apps-script/Code.gs`.

The Google backend needs a bound deployment on the prepared private workbook with Overview, Journal, Accounts and Settings tabs. The owner initializes the workbook through its Ledger menu and the web app runs as the signed-in user. Google Sheet sharing controls access. The Pages preview does not post to this backend.
