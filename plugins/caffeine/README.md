<p align="center"><img src=".claude-plugin/icon.png" width="128" alt="caffeine"></p>

# caffeine

A Claude Code mod that keeps the prompt cache warm while you step away.

Claude Code caches the conversation for 5 minutes (or 1 hour with `ENABLE_PROMPT_CACHING_1H`). Come back after it expires and the next turn writes the whole context to the cache again. With caffeine on, a short poke goes out before the cache expires, so your next turn reads the cache instead.

```
caffeine on · poke at 14:32 (in 12m) · 3 pokes   t: turn off   e: message
```

## Install

```
/plugin marketplace add lperezmo/caffeine
/plugin install caffeine@caffeine
```

Needs Claude Code 2.1.287 or newer (mods on by default).

## Use

The row above the prompt has the switch (`t`) and the message editor (`e`). Focus the row with ctrl+x tab or a click.

| Command | What it does |
| --- | --- |
| `/caffeine` | on or off for this session |
| `/caffeine for 2h` | on, then off after 2 hours |
| `/caffeine until 18:00` | on, then off at 18:00 |
| `/caffeine poke` | poke now |
| `/caffeine message <text>` | what the poke says (`reset` for the default, "poke, just say okay") |
| `/caffeine every 10m` | how long after the last request to poke (`auto`: 15m on a 1h cache, 2m 30s on 5m) |
| `/caffeine ttl 1h` | set the cache TTL if caffeine reads it wrong (`auto` to undo) |
| `/caffeine idle 8h` | turn off after this long without a turn of your own (`off` for never) |
| `/caffeine band off` | no row; shows in the status line instead, for when other mods use the band |
| `/caffeine status` | what it is doing and whether the last poke found the cache warm |

## What it does and does not do

- It sends a prompt on your behalf. Each poke is a real turn: it uses your plan's usage and adds a short exchange to the conversation.
- It is off until you turn it on, and only for the session you turn it on in.
- It waits while Claude is working and pauses when the 5-hour window is over 90% or the weekly one over 95%.
- It skips the poke once the cache has already expired, since that would only write it again.
- It turns itself off after 8 hours without a turn of your own (change with `/caffeine idle`).
- It reads two environment variables, `ENABLE_PROMPT_CACHING_1H` and `FORCE_PROMPT_CACHING_5M`, to learn the TTL. No network, no files, no shell.
- The session has to stay open.

## License

MIT
