# gemini-notes-sync

A Google Apps Script that saves your Gemini meeting notes to a Drive folder.

Every hour it searches Gmail for Gemini's "Meeting notes for" emails, copies each linked doc into a `Gemini Meeting Notes` folder, and labels the thread `saved-to-drive` so it's only handled once.

## Setup

1. Go to [script.google.com](https://script.google.com) and create a new project.
2. Paste the contents of [`src/Code.gs`](src/Code.gs) over the default `Code.gs`.
3. Pick `setup` in the function dropdown and hit Run. Approve the Gmail and Drive permissions.

`setup()` creates the folder and the label, and installs an hourly trigger. It's safe to run again. It replaces the old trigger instead of stacking a second one.

To update, paste the new file over the old one. No need to re-run `setup()` unless the trigger or config changed.

Config lives at the top of the file: folder name, label name, the Gmail search, and the retry limits.

## How it handles failures

Failed runs recover on the next hourly run.

| What happened | What the script does |
|---|---|
| Transient error (Drive hiccup, rate limit) | Retries up to 3 times with backoff. If it still fails, the thread stays unlabeled and the next run tries again. |
| Permanent error (file deleted, no access, copying blocked) | Logs it and gives up on that file. Retrying would never help. |
| One thread throws | Logged and skipped. The rest of the threads still run. |
| Thread has no Drive links | Retried for 24 hours in case the link shows up late, then labeled. |
| Run hits the 5-minute budget | Stops cleanly. The next run picks up the rest. |

The script never labels a thread until every file in it is either saved or permanently failed.

### Duplicates

Each copy gets a `gemini-notes-source:<fileId>` marker in its Drive description. Before copying, the script skips any source it has already saved, so retries and repeat links don't make duplicates. It dedupes on the source file ID and never on the name, so recurring meetings with the same title all get saved.

## Caveats

- **Permanent errors are matched by message text.** Google doesn't promise those strings stay the same. If a gone file keeps retrying, add its message to `PERMANENT_ERROR_PATTERNS`.
- **The dedupe scan reads the whole folder every run.** That's fine for hundreds of files. It'll get slow around tens of thousands.

## Tests

The tests load `src/Code.gs` into a Node `vm` with fake Gmail and Drive services, so the script stays a single pasteable file. Needs Node 20 or newer.

```sh
npm test
```

They cover link extraction, the permanent versus transient split, retry behavior, and the label-or-retry decision for each kind of failure.

## License

MIT
