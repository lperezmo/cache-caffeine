<p align="center"><img src="images/caffeine.png" width="128" alt="cache-caffeine"></p>

# cache-caffeine

A Claude Code mod that keeps the prompt cache warm while you step away, and wakes Claude up when the usage limit resets.

Claude Code caches the conversation for 1 hour on a Claude subscription and 5 minutes on an API key. Come back after it expires and the next turn writes the whole context to the cache again. With caffeine on, a short poke goes out before the cache expires, so your next turn reads the cache instead.

```
 ≋≋≋
c[_] 98°F  caffeine on · poke at 14:32 (in 40m) · until you turn it off (or 8h idle)   t: turn off   e: message
```

The cup is the cache: 100°F and steaming right after a request, cooling to 40°F as the cache runs out, red through blue. It shows while caffeine is off too, so you can watch the cache go cold.

Near the usage limit a second row offers the wake:

```
5h limit 96% · resets 14:10 (in 2h 05m)   u: wake Claude at 14:12   n: not now
```

## Install

```
/plugin marketplace add lperezmo/cache-caffeine
/plugin install cache-caffeine@cache-caffeine
```

Needs Claude Code 2.1.287 or newer (mods on by default).

## Use

The row above the prompt has the switch (`t`) and the message editor (`e`), and says how long caffeine keeps warm: until you turn it off, or to the end of a `warm` or `until` you set; the wake row books the wake (`u`) or puts it off (`n`). Focus the row with ctrl+x tab or a click.

| Command | What it does |
| --- | --- |
| `/caffeine` | on (until you turn it off) or off, for this session |
| `/caffeine warm 2h` | keep the cache warm for 2 hours, then off (alone: 1 hour) |
| `/caffeine until 18:00` | on, then off at 18:00 |
| `/caffeine poke` | poke now |
| `/caffeine message <text>` | what the poke says (`reset` for the default, "poke, just say okay") |
| `/caffeine every 10m` | how long after the last request to poke (`auto`: at 80% of the cache's life, 48m on a 1h cache, 4m on 5m) |
| `/caffeine ttl 1h` | pin the cache TTL (`auto` to go back to detecting it) |
| `/caffeine idle 8h` | turn off after this long without a turn of your own |
| `/caffeine forever` | no end this time: asks you to confirm, then keeps the cache warm until you turn it off; the next turn-on has the idle stop again (`idle off` does the same) |
| `/caffeine band off` | no row; shows in the status line instead, for when other mods use the band |
| `/caffeine auto 100k` | turn on by itself once the context passes 100k tokens (`off` for never, the default) |
| `/caffeine cost` | what a poke costs against one cache rewrite, and how long caffeine pays off for |
| `/caffeine wake` | wake Claude just after the usage limit resets |
| `/caffeine wake 14:30` | wake at a time (`2:30pm`, `+90m`); `wake off` cancels |
| `/caffeine wake prompt <text>` | what Claude is told on waking |
| `/caffeine wake auto` / `awake` / `push` | book the wake by itself at the limit; keep the computer awake until it; a phone notification when it fires |
| `/caffeine status` | what it is doing and whether the last poke found the cache warm |

## What it does and does not do

- **It sends prompts on your behalf.** Each poke is a real turn: it uses your plan's usage and adds a short exchange to the conversation. A poke is exactly the message you set (default "poke, just say okay"), and a wake is exactly the wake prompt you set (default "The usage limit has reset. Pick up where you left off."), with `[caffeine]` in front. Nothing read from the conversation, a file or anywhere else goes into either.
- It is off until you turn it on, and only for the session you turn it on in. It waits while Claude is working and pauses when the 5-hour window is over 90% or the weekly one over 95%.
- It skips the poke once the cache has already expired, since that would only write it again. If a poke finds the cache cold anyway (it writes more than a tenth of what it reads), caffeine turns itself off and says so.
- It turns itself off after 8 hours without a turn of your own, unless you confirm `/caffeine forever` for that run (change the length with `/caffeine idle`).
- **What it reads:** the session's own usage figures from Claude Code (token counts per request, the running cost estimate, the 5-hour and weekly limit windows) and three environment variables, `CLAUDE_CODE_PROMPT_CACHE_TTL`, `FORCE_PROMPT_CACHING_5M` and `ENABLE_PROMPT_CACHING_1H`. From those it works out the cache TTL: what a request cost (a 1-hour write costs 2x input, a 5-minute one 1.25x), else the variables, else request timing (the cache still read after more than 5 minutes idle means 1 hour), else Claude Code's default for your plan. It reads no files and makes no network requests of its own.
- **Tools it calls itself:** `CronCreate`, `CronList` and `CronDelete`, only for the wake (book it, find it again after `--resume`, cancel it); `PushNotification`, once, when a wake fires (`/caffeine wake push off` stops it); `AskUserQuestion`, to confirm `/caffeine forever`.
- **Programs it starts:** only while a wake is booked, one fixed command that keeps the computer from sleeping for up to 6 hours and starts again if the wake is further off: on Windows `powershell` calling `SetThreadExecutionState`, on macOS `caffeinate -i -t 21600`, on Linux `systemd-inhibit ... sleep 21600`. It ends when the wake fires or is cancelled. `/caffeine wake awake off` turns it off.
- **Hooks that see other events:** `prompt.submit` only notices its own wake prompt firing (and clears the "limit hit" flag on yours); it changes nothing. `classic.StopFailure` only notices a reply that failed on the usage limit, to offer the wake. `turn.step` reads each request's usage and leaves the request as it is. `session.compact` only notes that a compaction happened.
- The session has to stay open. After `claude --resume`, caffeine picks its booked wake back up.

## License

MIT
