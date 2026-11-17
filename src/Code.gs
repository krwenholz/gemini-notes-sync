// ── CONFIG ──────────────────────────────────────────────────────────────────
const DRIVE_FOLDER_NAME = "Gemini Meeting Notes";   // Folder created in My Drive
const GMAIL_LABEL_NAME  = "saved-to-drive";         // Label applied after saving
const GMAIL_SEARCH      =
  'from:(gemini-notes@google.com) ' +
  '(subject:("Meeting notes for") OR subject:("Notes:"))';

const MAX_THREADS_PER_RUN   = 100;  // Remainder is picked up by the next run
const TIME_BUDGET_MS        = 5 * 60 * 1000; // Stop before the 6-minute limit
const NO_LINK_GIVE_UP_HOURS = 24;   // Label link-less threads after this long
const MAX_ATTEMPTS          = 3;    // Per Drive call, for transient errors
const SOURCE_MARKER         = "gemini-notes-source:";

// Errors that will never succeed on retry (file deleted, no access, copy blocked).
// "Access denied: DriveApp" (missing OAuth scope) is deliberately NOT here:
// that's a script-wide problem and should fail loudly.
const PERMANENT_ERROR_PATTERNS = [
  /no item with the given id/i,
  /could not be found/i,
  /not found/i,
  /you do not have permission/i,
  /insufficient permission/i,
  /cannot be copied/i,
];
// ────────────────────────────────────────────────────────────────────────────

/**
 * Run this ONCE manually to create the Drive folder, Gmail label,
 * and set up the hourly trigger.
 */
function setup() {
  getOrCreateFolder_(DRIVE_FOLDER_NAME);

  if (!GmailApp.getUserLabelByName(GMAIL_LABEL_NAME)) {
    GmailApp.createLabel(GMAIL_LABEL_NAME);
  }

  // Remove any existing triggers to avoid duplicates
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === "saveMeetingNotes")
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger("saveMeetingNotes")
    .timeBased()
    .everyHours(1)
    .create();

  Logger.log("✅ Setup complete! Folder: '%s', runs every hour.", DRIVE_FOLDER_NAME);
}

/**
 * Main function — finds unprocessed meeting-note emails, copies any linked
 * Google files into the Drive folder, and labels each thread only once every
 * file in it has either been saved or permanently failed.
 *
 * Retry behavior:
 *  - Transient errors (Drive hiccups, rate limits) leave the thread unlabeled,
 *    so the next hourly run retries it.
 *  - Permanent errors (deleted / no access) are logged and the file is given
 *    up on, so they don't cause infinite retries.
 *  - A failure in one thread never blocks the others.
 *  - Copies are tagged with their source file ID, so retries and duplicate
 *    links never produce duplicate copies (recurring meetings with identical
 *    titles are unaffected, since their source IDs differ).
 */
function saveMeetingNotes() {
  const startedAt = Date.now();
  const folder    = getOrCreateFolder_(DRIVE_FOLDER_NAME);
  const label     = getOrCreateLabel_(GMAIL_LABEL_NAME);
  const threads   = GmailApp.search(
    `${GMAIL_SEARCH} -label:${GMAIL_LABEL_NAME}`, 0, MAX_THREADS_PER_RUN);

  Logger.log("Found %d unprocessed thread(s).", threads.length);

  const copiedSources = getCopiedSourceIds_(folder);
  const stats = { labeled: 0, retryLater: 0, threadErrors: 0, copied: 0 };

  for (const thread of threads) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      Logger.log("Time budget reached; remaining threads will run next time.");
      break;
    }

    try {
      const result = processThread_(thread, folder, copiedSources);
      stats.copied += result.copied;

      if (result.shouldLabel) {
        thread.addLabel(label);
        stats.labeled++;
      } else {
        stats.retryLater++;
      }
    } catch (e) {
      // Unexpected failure (e.g. Gmail service error). Leave unlabeled so the
      // next run retries, and keep going so one bad thread can't block the rest.
      stats.threadErrors++;
      Logger.log("Thread failed, will retry next run: %s", e.message);
    }
  }

  Logger.log(
    "Done. copied=%d labeled=%d retryLater=%d threadErrors=%d",
    stats.copied, stats.labeled, stats.retryLater, stats.threadErrors);
}

/**
 * Processes one thread. Returns { shouldLabel, copied }.
 * shouldLabel is false if any file hit a transient error, or if the thread
 * has no links yet and is still young enough that links might show up.
 */
function processThread_(thread, folder, copiedSources) {
  let foundAnyLink = false;
  let transientFailure = false;
  let copied = 0;

  thread.getMessages().forEach(msg => {
    extractDriveFileIds_(msg.getBody()).forEach(fileId => {
      foundAnyLink = true;

      if (copiedSources.has(fileId)) {
        Logger.log("Already saved (source %s), skipping.", fileId);
        return;
      }

      try {
        const copy = withRetry_(() => {
          const file = DriveApp.getFileById(fileId);
          const c = file.makeCopy(file.getName(), folder);
          c.setDescription(SOURCE_MARKER + fileId);
          return c;
        });
        copiedSources.add(fileId);
        copied++;
        Logger.log("Copied to Drive: %s", copy.getName());
      } catch (e) {
        if (isPermanentError_(e)) {
          Logger.log("Giving up on file '%s' (permanent): %s", fileId, e.message);
        } else {
          transientFailure = true;
          Logger.log("Transient failure on file '%s', will retry: %s", fileId, e.message);
        }
      }
    });
  });

  if (transientFailure) {
    return { shouldLabel: false, copied };
  }

  if (!foundAnyLink) {
    // Maybe the doc link just isn't in the email yet. Retry for a while,
    // then give up so the thread doesn't get re-scanned forever.
    const ageHours =
      (Date.now() - thread.getLastMessageDate().getTime()) / 36e5;
    if (ageHours < NO_LINK_GIVE_UP_HOURS) {
      Logger.log("No Drive links yet in '%s'; will retry.", thread.getFirstMessageSubject());
      return { shouldLabel: false, copied };
    }
    Logger.log("No Drive links after %dh in '%s'; giving up.",
      NO_LINK_GIVE_UP_HOURS, thread.getFirstMessageSubject());
  }

  return { shouldLabel: true, copied };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extracts all unique Google Drive/Docs file IDs from an HTML email body.
 * Handles docs.google.com/document/d/ID and drive.google.com/open?id=ID patterns.
 */
function extractDriveFileIds_(htmlBody) {
  const patterns = [
    /docs\.google\.com\/(?:document|spreadsheets|presentation)\/d\/([a-zA-Z0-9_-]{25,})/g,
    /drive\.google\.com\/(?:file\/d\/|open\?id=)([a-zA-Z0-9_-]{25,})/g,
  ];

  const ids = new Set();
  patterns.forEach(re => {
    let match;
    while ((match = re.exec(htmlBody)) !== null) {
      ids.add(match[1]);
    }
  });

  return [...ids];
}

/**
 * Builds the set of source file IDs already copied into the folder, by reading
 * the marker we store in each copy's description. Scanned once per run.
 */
function getCopiedSourceIds_(folder) {
  const ids = new Set();
  const files = folder.getFiles();
  while (files.hasNext()) {
    const desc = files.next().getDescription();
    if (desc && desc.indexOf(SOURCE_MARKER) === 0) {
      ids.add(desc.substring(SOURCE_MARKER.length).trim());
    }
  }
  return ids;
}

/**
 * Runs fn, retrying transient failures with exponential backoff.
 * Permanent errors are rethrown immediately.
 */
function withRetry_(fn) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return fn();
    } catch (e) {
      lastError = e;
      if (isPermanentError_(e) || attempt === MAX_ATTEMPTS) break;
      Utilities.sleep(1000 * Math.pow(2, attempt - 1)); // 1s, 2s, ...
    }
  }
  throw lastError;
}

function isPermanentError_(e) {
  const msg = (e && e.message) || String(e);
  return PERMANENT_ERROR_PATTERNS.some(re => re.test(msg));
}

function getOrCreateFolder_(name) {
  const folders = DriveApp.getFoldersByName(name);
  return folders.hasNext() ? folders.next() : DriveApp.createFolder(name);
}

function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}
