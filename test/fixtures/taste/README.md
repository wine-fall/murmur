# taste fixture — the listener's real snapshots, scrubbed

A copy of one listener's `~/.murmur/data/taste/*.json` (2026-09-17/18), kept
so the digest's budget can be measured against real title widths and real
list sizes rather than against generated strings (spec 14 §5.14).

What was removed, and why:

- **Every `ref`** — a playable url carries account-reachable ids.
- **Playlist names carrying the account name.**
- **Every YouTube and Bilibili row's title and uploader**, replaced by
  `<kind> row <n>`. Their `kind`, `category`, `at` and count are real, which
  is all the digest rules need: those rows must never reach the block
  (§2.3's invariant), so what they say cannot affect the render. A watch
  history is the listener's own browsing and this repository is public.

The song rows (NetEase, QQ Music) are real: they are the signal under test,
and a song title is catalogue data.
