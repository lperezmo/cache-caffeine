<p align="center"><img src="images/caffeine.png" width="128" alt="caffeine"></p>

# caffeine

A Claude Code mod that keeps the prompt cache warm while you step away, and wakes Claude up when the usage limit resets.

Claude Code caches the conversation for 1 hour on a Claude subscription and 5 minutes on an API key. Come back after it expires and the next turn writes the whole context to the cache again. With caffeine on, a short poke goes out before the cache expires, so your next turn reads the cache instead.

```
caffeine on · poke at 14:32 (in 12m) · 3 pokes   t: turn off   l: away 1h   e: message
```

Near the usage limit a second row offers the wake:

```
5h limit 96% · resets 14:10 (in 2h 05m)   u: wake Claude at 14:12   n: not now
```

## Install

```
/plugin marketplace add lperezmo/caffeine
/plugin install caffeine@caffeine
```

Needs Claude Code 2.1.287 or newer (mods on by default).

## Use

The row above the prompt has the switch (`t`), on-for-an-hour (`l`) and the message editor (`e`); the wake row books the wake (`u`) or puts it off (`n`). Focus the row with ctrl+x tab or a click.

| Command | What it does |
| --- | --- |
| `/caffeine` | on or off for this session |
| `/caffeine for 2h` | on, then off after 2 hours |
| `/caffeine until 18:00` | on, then off at 18:00 |
| `/caffeine away` | on for an hour (`away 30m` for another length) |
| `/caffeine poke` | poke now |
| `/caffeine message <text>` | what the poke says (`reset` for the default, "poke, just say okay") |
| `/caffeine every 10m` | how long after the last request to poke (`auto`: 15m on a 1h cache, 2m 30s on 5m) |
| `/caffeine ttl 1h` | pin the cache TTL (`auto` to go back to detecting it) |
| `/caffeine idle 8h` | turn off after this long without a turn of your own (`off` for never) |
| `/caffeine band off` | no row; shows in the status line instead, for when other mods use the band |
| `/caffeine auto 100k` | turn on by itself once the context passes 100k tokens (`off` for never, the default) |
| `/caffeine cost` | what a poke costs against one cache rewrite, and how long caffeine pays off for |
| `/caffeine wake` | wake Claude just after the usage limit resets |
| `/caffeine wake 14:30` | wake at a time (`2:30pm`, `+90m`); `wake off` cancels |
| `/caffeine wake prompt <text>` | what Claude is told on waking |
| `/caffeine wake auto` / `awake` / `push` | book the wake by itself at the limit; keep the computer awake until it; a phone notification when it fires |
| `/caffeine status` | what it is doing and whether the last poke found the cache warm |

## What it does and does not do

- It sends a prompt on your behalf. Each poke is a real turn: it uses your plan's usage and adds a short exchange to the conversation.
- It is off until you turn it on, and only for the session you turn it on in.
- It waits while Claude is working and pauses when the 5-hour window is over 90% or the weekly one over 95%.
- It skips the poke once the cache has already expired, since that would only write it again.
- It turns itself off after 8 hours without a turn of your own (change with `/caffeine idle`).
- It works out the cache TTL by itself: from what each request cost (a 1-hour write costs 2x input, a 5-minute one 1.25x), else from `CLAUDE_CODE_PROMPT_CACHE_TTL`, `FORCE_PROMPT_CACHING_5M` or `ENABLE_PROMPT_CACHING_1H`, else Claude Code's default for your plan. No network and no files; the only process it starts is the keep-awake one below.
- A wake is a one-shot `CronCreate` job in the session. Until it fires, caffeine keeps the cache warm (if the limit allows pokes) and keeps the computer from sleeping: `powershell` with `SetThreadExecutionState` on Windows, `caffeinate` on macOS, `systemd-inhibit` on Linux. Turn that off with `/caffeine wake awake off`.
- On waking it sends a phone notification through Claude Code's `PushNotification`; `/caffeine wake push off` stops it.
- The session has to stay open. After `claude --resume`, caffeine picks its booked wake back up.

## License

MIT
