# Personal & Business Ledger

[Open the ledger](https://santos-cabbigat.github.io/Personal-Ledger/) or [explore the sample ledger](https://santos-cabbigat.github.io/Personal-Ledger/?preview=1). GitHub Pages serves the interface. Preview mode uses temporary sample data. The live interface calls the workbook's existing Apps Script posting and reporting functions under the signed-in Google account. The Sheet menu and its sidebar still work independently.

## Connect the GitHub Pages interface

The existing Google web app remains accessible from the welcome screen. To activate in-page access for this deployment:

1. Open the existing workbook's Apps Script project. Use the same project that handles direct edits, so both entry paths share its posting lock and daily numbering sequence. Confirm that the intended workbook is selected in the project.
2. In the script's standard Google Cloud project, enable the Apps Script, Google Sheets and Drive APIs. Configure the OAuth consent audience for your intended contributors. Create a **Web application** OAuth client with the authorized JavaScript origin `https://santos-cabbigat.github.io`.
3. In the existing Apps Script project, select **Deploy → New deployment → API executable**. Choose access for the intended Google accounts, subject to the workbook's existing Google Drive permissions. Keep the existing Web app deployment as well.
4. Set the public web OAuth client ID and the **API executable deployment ID** in `docs/google-config.json` and publish the file on Pages. Never add a client secret, access token or workbook data. Sign in on the main link and confirm the correct book appears. The browser requests the same scopes listed in the script manifest and keeps its short-lived token in memory.

The Google account may need to approve access or reauthorize after expiry. Journal retries reuse the original posting request ID. [Google setup instructions](https://developers.google.com/apps-script/api/how-tos/execute)

## Use a Google Sheet

Each person signs in with their own Google account. **Connect Google Drive** creates or reconnects their own ledger in **My Drive → Personal & Business Ledger**. The original owner keeps the existing workbook. To use one shared database, its owner shares the spreadsheet with each contributor as an Editor. In Settings, contributors choose **Open existing ledger** and paste the same spreadsheet URL. The app refreshes when reopened or brought back to the foreground with the main screen visible. **Refresh** reads the latest Sheet immediately.

In **Accounts**, enter a unique code, name, classification, optional parent code, and use (`Posting` or `Group`). Open the tab named for your book (for example **Nurturing Support**). Column A holds the entry ID, B the date, C the receipt reference, D/E the account code/name, G the description, H/I the debit/credit, and J/K the poster/time. The tab supplies the book. Add a book in app Settings or in **Settings → Book types** (column F). Each creates a separate editable journal. The app reads all book tabs, and all books share the daily numbering sequence. In a script-bound workbook choosing an account reserves an ID. A balanced entry with a date, description and at least two posting accounts records the editor and time. Other users can identify themselves from **Ledger → Enable my Sheet posting**. The app's Journal has the ID picker and edit action. Newly created workbooks without a bound script use the web app for posting.

All books in the same spreadsheet share a daily series: `YYMM-DDA001` through `YYMM-DDA999`, then `B001`; `Z999` rolls to `AA001`. IDs use the transaction date. Edits keep the original posted ID and Gmail. Backup the workbook from Settings as Excel; Journal, Accounts and Reports offer CSV downloads. Report CSV uses the same book, project, category and date filters as the on-screen report.

## Deploy an update

Use the [two-file installer](https://santos-cabbigat.github.io/Personal-Ledger/copy-script.html) in the existing Apps Script project. When opened with a workbook ID in its URL fragment, the installer binds the legacy workbook without including its ID in the public repository. The installer contains both the complete Code.gs and the manifest. The manifest enables the advanced Sheets v4 and Drive v3 services. If you use a standard Cloud project, enable their APIs there too. Keep the deployment running as the user accessing the app. Google handles sign-in in the browser. Anyone using a future Android wrapper must sign in through the system browser or a browser-backed custom tab.

Edit `docs/index.html` or `docs/ledger.css` for the Pages interface and `apps-script/Code.gs` for shared posting behavior. Run `node scripts/build.mjs` to regenerate the Apps Script interface, the preview's matching ID generator, and the single-file script installer. Publishing a Pages-only screen change does not require a new Google deployment. To update the sidebar as well, install the rebuilt Apps Script interface. After changing shared server code, update the API executable and web app deployments to the new version.

The Reference column in each book stores a receipt or transfer reference as text, including leading zeros. A blue first row separates each transaction. Lines sharing a manual Entry ID may use different descriptions and references. Posting a balanced Sheet draft retains a correctly dated manual ID and records the signed-in poster. Settings lists IDs directly from Journal.

In a script-bound book tab, choosing a posting account assigns an ID. The next lines share it until both sides balance. Fill in the date (first for backdated entries), book and description. A ready entry is stamped with the Google editor and Laos time automatically. If Google withholds your identity, choose **Ledger → Enable my Sheet posting** using your own account and edit the draft again, or use **Post selected journal entry**. A yellow row marks where to start after a balanced entry.
