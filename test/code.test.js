// Loads src/Code.gs into a vm with fake Google services, so the script
// stays a single paste-able file with no module.exports hacks.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(path.join(__dirname, "../src/Code.gs"), "utf8");

function load(globals = {}) {
  const ctx = vm.createContext({
    Logger: { log() {} },
    Utilities: { sleep() {} },
    ...globals,
  });
  vm.runInContext(SOURCE, ctx);
  return ctx;
}

const id = (c) => c.repeat(30); // Drive IDs must be 25+ chars to match
const docUrl = (fileId) => `<a href="https://docs.google.com/document/d/${fileId}/edit">notes</a>`;

/**
 * A fake Drive. `files` maps id -> { name } or an Error to throw from
 * getFileById. Copies land in `copies` with their description.
 */
function fakeDrive(files) {
  const copies = [];
  return {
    copies,
    DriveApp: {
      getFileById(fileId) {
        const f = files[fileId];
        if (f instanceof Error) throw f;
        return {
          getName: () => f.name,
          makeCopy(name) {
            const copy = { name, description: null };
            copies.push(copy);
            return {
              getName: () => name,
              setDescription: (d) => { copy.description = d; },
            };
          },
        };
      },
    },
  };
}

function fakeThread(htmlBodies, { lastMessageAgeHours = 0 } = {}) {
  return {
    getMessages: () => htmlBodies.map((html) => ({ getBody: () => html })),
    getLastMessageDate: () => new Date(Date.now() - lastMessageAgeHours * 36e5),
    getFirstMessageSubject: () => "Notes: Standup",
  };
}

const notFound = () => new Error("No item with the given ID could be found, or you do not have permission to access it.");
const serviceError = () => new Error("Service error: Drive");

// ── extractDriveFileIds_ ────────────────────────────────────────────────────

test("extractDriveFileIds_ finds docs, sheets, slides, and drive links, deduped", () => {
  const { extractDriveFileIds_ } = load();
  const html = [
    `https://docs.google.com/document/d/${id("a")}/edit`,
    `https://docs.google.com/spreadsheets/d/${id("b")}/edit`,
    `https://docs.google.com/presentation/d/${id("c")}/edit`,
    `https://drive.google.com/file/d/${id("d")}/view`,
    `https://drive.google.com/open?id=${id("e")}`,
    `https://docs.google.com/document/d/${id("a")}/edit`, // repeat
  ].join(" ");
  assert.deepEqual([...extractDriveFileIds_(html)].sort(), ["a", "b", "c", "d", "e"].map(id));
});

test("extractDriveFileIds_ ignores IDs too short to be real", () => {
  const { extractDriveFileIds_ } = load();
  assert.equal(extractDriveFileIds_("https://docs.google.com/document/d/short/edit").length, 0);
});

// ── isPermanentError_ ───────────────────────────────────────────────────────

test("isPermanentError_ treats not-found and no-access as permanent", () => {
  const { isPermanentError_ } = load();
  assert.equal(isPermanentError_(notFound()), true);
  assert.equal(isPermanentError_(new Error("You do not have permission to access the requested document.")), true);
});

test("isPermanentError_ treats service errors as transient", () => {
  const { isPermanentError_ } = load();
  assert.equal(isPermanentError_(serviceError()), false);
  assert.equal(isPermanentError_(new Error("Service invoked too many times for one day: drive.")), false);
});

test("isPermanentError_ does not swallow a missing OAuth scope", () => {
  const { isPermanentError_ } = load();
  assert.equal(isPermanentError_(new Error("Access denied: DriveApp.")), false);
});

// ── withRetry_ ──────────────────────────────────────────────────────────────

test("withRetry_ retries transient errors until one succeeds", () => {
  const { withRetry_ } = load();
  let calls = 0;
  const result = withRetry_(() => {
    if (++calls < 3) throw serviceError();
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(calls, 3);
});

test("withRetry_ gives up after MAX_ATTEMPTS and rethrows", () => {
  const ctx = load();
  let calls = 0;
  assert.throws(
    () => ctx.withRetry_(() => { calls++; throw serviceError(); }),
    /Service error/,
  );
  assert.equal(calls, vm.runInContext("MAX_ATTEMPTS", ctx));
});

test("withRetry_ does not retry permanent errors", () => {
  const { withRetry_ } = load();
  let calls = 0;
  assert.throws(() => withRetry_(() => { calls++; throw notFound(); }), /No item/);
  assert.equal(calls, 1);
});

// ── processThread_ ──────────────────────────────────────────────────────────

test("processThread_ copies the file, tags the source ID, and labels the thread", () => {
  const drive = fakeDrive({ [id("a")]: { name: "Standup" } });
  const { processThread_ } = load(drive);

  const result = processThread_(fakeThread([docUrl(id("a"))]), {}, new Set());

  assert.deepEqual({ ...result }, { shouldLabel: true, copied: 1 });
  assert.equal(drive.copies.length, 1);
  assert.equal(drive.copies[0].description, `gemini-notes-source:${id("a")}`);
});

test("processThread_ skips an already-copied source but still labels", () => {
  const drive = fakeDrive({ [id("a")]: { name: "Standup" } });
  const { processThread_ } = load(drive);

  const result = processThread_(fakeThread([docUrl(id("a"))]), {}, new Set([id("a")]));

  assert.deepEqual({ ...result }, { shouldLabel: true, copied: 0 });
  assert.equal(drive.copies.length, 0);
});

test("processThread_ keeps recurring meetings that share a title", () => {
  const drive = fakeDrive({
    [id("a")]: { name: "Weekly Sync" },
    [id("b")]: { name: "Weekly Sync" },
  });
  const { processThread_ } = load(drive);
  const copiedSources = new Set();

  processThread_(fakeThread([docUrl(id("a"))]), {}, copiedSources);
  processThread_(fakeThread([docUrl(id("b"))]), {}, copiedSources);

  assert.equal(drive.copies.length, 2);
});

test("processThread_ leaves the thread unlabeled after a transient failure", () => {
  const drive = fakeDrive({ [id("a")]: serviceError() });
  const { processThread_ } = load(drive);

  const result = processThread_(fakeThread([docUrl(id("a"))]), {}, new Set());

  assert.equal(result.shouldLabel, false);
});

test("processThread_ still copies the good files when one fails transiently", () => {
  const drive = fakeDrive({
    [id("a")]: serviceError(),
    [id("b")]: { name: "Good" },
  });
  const { processThread_ } = load(drive);

  const result = processThread_(fakeThread([docUrl(id("a")) + docUrl(id("b"))]), {}, new Set());

  assert.deepEqual({ ...result }, { shouldLabel: false, copied: 1 });
});

test("processThread_ labels the thread after a permanent failure", () => {
  const drive = fakeDrive({ [id("a")]: notFound() });
  const { processThread_ } = load(drive);

  const result = processThread_(fakeThread([docUrl(id("a"))]), {}, new Set());

  assert.deepEqual({ ...result }, { shouldLabel: true, copied: 0 });
});

test("processThread_ retries a link-less thread while it's young", () => {
  const { processThread_ } = load(fakeDrive({}));

  const result = processThread_(fakeThread(["no links"], { lastMessageAgeHours: 1 }), {}, new Set());

  assert.equal(result.shouldLabel, false);
});

test("processThread_ gives up on a link-less thread once it's old", () => {
  const { processThread_ } = load(fakeDrive({}));

  const result = processThread_(fakeThread(["no links"], { lastMessageAgeHours: 48 }), {}, new Set());

  assert.equal(result.shouldLabel, true);
});
