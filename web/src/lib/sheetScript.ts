/** The Closer OS Google Sheets script (version 2). The client pastes it once and presses Run — it sets up its own
 *  every-minute check and its "on change" trigger, repairs itself, sends new rows in batches with a stable row key
 *  (re-sends are ignored by Closer OS) and reports its health. No trigger to choose by hand. */
export const SHEET_SCRIPT_VERSION = 2

export function sheetScript(url: string, tab = ''): string {
  return `// Closer OS Sync — version ${SHEET_SCRIPT_VERSION}
// Paste this whole file, click Save, then click Run (it runs "connectCloserOS") and allow access once.
// That's all: new rows are sent to Closer OS within a minute, by themselves. Nothing else to set up.
const CLOSER_OS_URL = '${url}';
const SHEET_TAB = '${tab.replace(/'/g, "\\'")}';   // empty = the first tab

function connectCloserOS() {
  installCloserOS_();
  const n = sendToCloserOS();
  try { SpreadsheetApp.getUi().alert('Closer OS is connected ✓\\n\\nNew rows are now sent automatically within a minute.' + (n ? '\\n' + n + ' rows sent now.' : '')); } catch (e) {}
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Closer OS')
    .addItem('Connect / repair', 'connectCloserOS')
    .addItem('Send new rows now', 'sendToCloserOS')
    .addItem('Send every row again (no duplicates)', 'resendAllToCloserOS')
    .addToUi();
}

function installCloserOS_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendToCloserOS') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendToCloserOS').timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger('sendToCloserOS').forSpreadsheet(SpreadsheetApp.getActive()).onChange().create();
}

function resendAllToCloserOS() {
  PropertiesService.getDocumentProperties().setProperty('closerOsSent', '1');
  sendToCloserOS();
}

function sendToCloserOS() {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(10000)) return 0;
  let sent = 0, problem = '';
  try {
    // Repair: if the every-minute timer was removed, put it back.
    const timers = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'sendToCloserOS' && t.getEventType() === ScriptApp.EventType.CLOCK; });
    if (timers.length === 0) installCloserOS_();

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = SHEET_TAB ? ss.getSheetByName(SHEET_TAB) : ss.getSheets()[0];
    const tz = ss.getSpreadsheetTimeZone();
    const values = sh.getDataRange().getValues();
    const head = values[0].map(function (h) { return String(h).trim(); });
    const props = PropertiesService.getDocumentProperties();
    let from = Number(props.getProperty('closerOsSent') || 1);
    if (from > values.length) from = 1;                 // the sheet got shorter — check it all again
    from = Math.max(1, from - 25);                      // look back: rows filled in a little later are caught too

    const rows = [];
    for (let r = from; r < values.length; r++) {
      const row = {}; let filled = 0;
      head.forEach(function (h, i) {
        if (!h) return;
        let v = values[r][i];
        if (v instanceof Date) {
          // A date with no time of day stays a plain date (in the sheet's own time zone).
          v = Utilities.formatDate(v, tz, 'HH:mm:ss') === '00:00:00'
            ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : Utilities.formatDate(v, tz, 'yyyy-MM-dd HH:mm:ss');
        } else v = String(v).trim();
        if (v !== '') filled++;
        row[h] = v;
      });
      if (filled === 0) continue;
      const digest = Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, JSON.stringify(row)));
      row._row_key = ss.getId() + ':' + sh.getSheetId() + ':' + digest;
      row._row = r + 1;
      rows.push(row);
    }
    let upTo = from;
    for (let i = 0; i < rows.length; i += 100) {
      const part = rows.slice(i, i + 100);
      const res = UrlFetchApp.fetch(CLOSER_OS_URL, { method: 'post', contentType: 'application/json', payload: JSON.stringify(part), muteHttpExceptions: true });
      if (res.getResponseCode() !== 200) { problem = 'Closer OS answered ' + res.getResponseCode(); break; }
      sent += part.length;
      upTo = part[part.length - 1]._row;
      props.setProperty('closerOsSent', String(upTo));
    }
    if (!problem && rows.length === 0) props.setProperty('closerOsSent', String(values.length));
    UrlFetchApp.fetch(CLOSER_OS_URL + '?hello=1', { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify({ sheet_id: ss.getId(), sheet_name: ss.getName(), tab: sh.getName(), rows: values.length - 1,
        sent_up_to: Number(props.getProperty('closerOsSent') || 1) - 1, version: ${SHEET_SCRIPT_VERSION}, timer: true, problem: problem }) });
  } catch (e) {
    problem = String(e);
  } finally {
    lock.releaseLock();
  }
  return sent;
}
`
}
