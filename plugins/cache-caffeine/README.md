<p align="center"><img src=".claude-plugin/icon.png" width="128" alt="cache-caffeine"></p>

# cache-caffeine

A Claude Code mod that keeps the prompt cache warm while you step away, and wakes Claude up when the usage limit resets.

Claude Code caches the conversation for 1 hour on a Claude subscription, 5 minutes on an API key. Come back after it expires and the next turn writes the whole context to the cache again. With caffeine on, a short poke goes out before the cache expires, so your next turn reads it instead.

```
 ≋≋≋
c[_] 98°F  caffeine on · poke at 14:32 (in 40m) · until you turn it off (or 8h idle)   t: turn off   e: message
```

The cup is the cache: 100°F and steaming right after a request, cooling to 40°F (red to blue) as the cache runs out. It shows while caffeine is off too, so you can watch the cache go cold.

Near the usage limit a second row offers the wake:

```
5h limit 96% · resets 14:10 (in 2h 05m)   u: wake Claude at 14:12   n: not now
```

## Install

From the Anthropic plugin directory, no marketplace to add:

```
/plugin install cache-caffeine@anthropic-plugin-directory
```

Needs Claude Code 2.1.287 or newer (mods on by default).

## Use

The row above the prompt has the switch (`t`), the message editor (`e`), and how long caffeine stays on: until you turn it off, or the end of a `warm` or `until`. The wake row books the wake (`u`) or puts it off (`n`). Focus the row with ctrl+x tab or a click.

| Command                            | What it does                                                                                                                            |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `/caffeine`                        | on (until you turn it off) or off, for this session                                                                                     |
| `/caffeine warm 2h`                | keep the cache warm for 2 hours, then off (alone: 1 hour)                                                                               |
| `/caffeine until 18:00`            | on, then off at 18:00                                                                                                                   |
| `/caffeine poke`                   | poke now                                                                                                                                |
| `/caffeine message <text>`         | what the poke says (`reset` for the default, "poke, just say okay")                                                                     |
| `/caffeine every 10m`              | poke this long after the last request (`auto`: 80% of the cache's life, 48m on 1h, 4m on 5m)                                            |
| `/caffeine ttl 1h`                 | pin the cache TTL (`auto` to detect it again)                                                                                           |
| `/caffeine idle 8h`                | turn off after this long without a turn of your own                                                                                     |
| `/caffeine forever`                | no end this time, once you confirm: warm until you turn it off, and the next turn-on has the idle stop again (`idle off` does the same) |
| `/caffeine band off`               | no row; shows in the status line instead, for when other mods use the band                                                              |
| `/caffeine auto 100k`              | turn on by itself once the context passes 100k tokens (`off` for never, the default)                                                    |
| `/caffeine cost`                   | a poke's cost against one cache rewrite, and how long caffeine pays off for                                                             |
| `/caffeine wake`                   | wake Claude just after the usage limit resets                                                                                           |
| `/caffeine 1 min`                  | wake Claude at a time: `in 20 minutes`, `2 hours`, `14:30`, `at 3pm`, `noon` (`wake 1 min` works too); `wake off` cancels               |
| `/caffeine 20 min check the build` | a wake that tells Claude exactly that                                                                                                   |
| `/caffeine wake prompt <text>`     | what Claude is told on every wake (`wake prompt default` restores the defaults)                                                         |
| `/caffeine wake auto`              | book the wake by itself whenever the limit hits                                                                                         |
| `/caffeine status`                 | what it is doing and whether the last poke found the cache warm                                                                         |

## What it does and does not do

- **It sends prompts on your behalf.** Each poke is a real turn: it uses your plan's usage and adds a short exchange to the conversation. A poke is exactly your message (default "poke, just say okay"). A wake is exactly that wake's text (`/caffeine 20 min check the build`), else your wake prompt, else the default ("The usage limit has reset. Pick up where you left off." after a limit reset, "Time's up. Pick up where you left off." at a set time), with `[caffeine]` in front. Nothing from the conversation, a file or anywhere else goes into either.
- It is off until you turn it on, and only for that session. It waits while Claude is working and pauses when the 5-hour window is over 90% or the weekly one over 95%.
- It skips the poke once the cache has expired, since that would only write it again. If a poke finds the cache cold anyway (it writes more than a tenth of what it reads), caffeine turns itself off and says so. A compaction or `/clear` empties the cache, so pokes wait for your next message to write it again; a poke that had to write it anyway (the first after a compaction or model switch) never counts as cold.
- It turns itself off after 8 hours without a turn of your own (change it with `/caffeine idle`), unless you confirm `/caffeine forever` for that run.
- **What it reads:** the session's usage figures from Claude Code (per-request token counts, the running cost estimate, the 5-hour and weekly limit windows), the environment variables `FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_PROMPT_CACHE_TTL` and `ENABLE_PROMPT_CACHING_1H`, and the `promptCacheTtl` key of your Claude Code settings. From those it works out the cache TTL, first match wins:
  1. The variables and the setting, in the order Claude Code checks them (they pin the TTL before Claude Code picks one by plan).
  2. A request whose cost shows a 1-hour write: 2x input, on a write too large for a web search's charge to explain. A 1.25x write could be either TTL, since Claude Code's estimate prices at the 5-minute rate any write the API did not report under a 1-hour TTL. A cache found cold inside the hour takes a 1-hour reading back, unless that request priced at 1 hour itself.
  3. Request timing: the cache still read after more than 5 minutes idle means 1 hour; written again inside the hour means 5 minutes.
  4. Claude Code's default for your plan.

  It reads no files of its own (the setting comes through Claude Code, like the variables) and makes no network requests.

- **Tools it calls itself:** none. A wake is caffeine's own timer, which sends the wake prompt the way it sends a poke. `/caffeine forever` asks you to confirm in Claude Code's own question dialog.
- **Programs it starts:** none. It does not keep the computer awake: wakes and pokes need it on and the session open, so set your power settings to stay awake if you rely on them.
- **Hooks that see other events:** `prompt.submit` only clears the "limit hit" flag when you send a prompt, and changes nothing. `classic.StopFailure` only notices a reply that failed on the usage limit, to offer the wake. `turn.step` reads each request's usage and leaves the request as it is. `session.compact` and `session.end` only note a compaction or `/clear`, to hold the pokes.
- The session has to stay open. A booked wake's time is kept in caffeine's own storage, so `claude --resume` picks it back up.

## License

MIT
