# Command-palette transcript availability

The palette's transcript source is independent of command and file matching.
Desktop retains its existing transcript search and hit actions. The browser bridge
still rejects `transcripts.search` with `E_UNSUPPORTED`; there is no Server
transcript route or additional access grant.

`usePaletteTranscriptSearch` debounces queries of at least two trimmed characters
by 180 ms. Each query and palette lifetime has an invalidation generation, so a
late response cannot replace a newer query, short-query reset, closed palette or
unmounted consumer, even when query text repeats. In-flight host work is not
claimed cancelled; only its obsolete renderer result is discarded.

The mounted palette labels unsupported search as unavailable, other failures as
failed, pending search as pending, and a successful empty result as no transcript
matches. These messages are non-selectable and do not become commands. Bridge
error details are not echoed. Changing the query retries through the same bounded
debounce; no automatic retry or authority fallback is introduced.

Mounted tests combine the hook, palette and actual browser stub. Desktop success
uses synthetic hits; it does not establish real transcript access or validate
session focus/resume. Browser acceptance uses only synthetic sticky persistence,
without opening a transcript or terminal session.
