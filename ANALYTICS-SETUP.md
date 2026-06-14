# Wiring the anonymous play telemetry to a Google Sheet

The game POSTs batches of gameplay events to a Google Apps Script web app, which appends
them to a Sheet you own. No new account — it uses your existing Google.

## One-time setup (~5 min)

1. Go to **https://sheets.new** — create a blank Google Sheet (name it e.g. "Empire telemetry").
2. **Extensions → Apps Script.** Delete whatever code is in the editor.
3. Paste the **script below**, then Save (the disk icon).
4. **Deploy → New deployment.** Click the gear icon → choose **Web app**.
   - *Execute as:* **Me**
   - *Who has access:* **Anyone**
   - Click **Deploy**, then **Authorize access** when prompted (it's your own script — approve it).
5. Copy the **Web app URL** (it ends in `/exec`). **Send me that URL** — I'll paste it into the
   game, rebuild, and your Sheet will start filling up as people play.

## The script

```js
function doPost(e) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName('events') || ss.insertSheet('events');
    if (sh.getLastRow() === 0) sh.appendRow(['received_at','pid','session','gameNo','event','event_ts','props']);
    var data = JSON.parse(e.postData.contents);
    var rows = (data.events || []).map(function (ev) {
      return [new Date(), data.pid || '', data.session || '', data.gameNo || '',
              ev.event, ev.ts ? new Date(ev.ts) : '', JSON.stringify(ev.props || {})];
    });
    if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, 7).setValues(rows);
    return ContentService.createTextOutput(JSON.stringify({ ok: true, n: rows.length }));
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) }));
  }
}
function doGet() { return ContentService.createTextOutput('EOB telemetry OK'); }
```

Each gameplay event becomes one row; the `props` column holds that event's details as JSON.
Once it's live I read the Sheet to retune balance from how real people actually play.

## What's collected (and what isn't)

- **Collected:** an anonymous random id (in the player's browser only), and gameplay events —
  what shops they build, when they borrow, per-week net worth vs. Vane, crunches, foreclosures,
  win/lose. See the event list in `ui-shell.html` (`track(...)` calls).
- **Not collected:** no names, emails, IP-based identity, or anything personal. The id is a
  random string with no link to a real person.
