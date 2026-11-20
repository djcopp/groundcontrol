# Ground Control

Air traffic control for your Claude Code agents.

If you run lots of agents (a few terminals, a tmux grid, the desktop app, a Python script fanning out
`claude -p` workers, a box over SSH), it gets hard to tell which ones are working, which are stuck on
a permission prompt, and which finished ten minutes ago and are waiting on you. Ground Control is
a local, open-source dashboard that finds every running `claude` process and draws it as a network
of routes:

- **Launchers on the left:** Terminal, iTerm2, Ghostty, VS Code, Cursor, Claude Desktop, tmux, a
  cron job, the Python or Node script that spawned the agent, or a remote machine over SSH.
- **Agents on the right, connected by taxiways.** Every agent is a flight with a flight number
  (`VSC482`: launcher plus pid). Its route from the launcher shows what it's doing:

  | Agent state                    | On the taxiway                                                                |
  | ------------------------------ | ----------------------------------------------------------------------------- |
  | Thinking                       | **In flight**: a blue plane moves along the route, centreline lights chasing  |
  | Running a tool                 | **Taxiing**: a green plane, moving faster                                     |
  | Waiting for you                | **Holding**: the plane parks at an amber hold-short line in front of the card |
  | Blocked on a permission prompt | **Awaiting clearance**: the plane stops at a blinking red stop bar            |
  | Finished or exited             | **Landed**: the taxiway goes dark                                             |
- **Subagents** branch off their parent agent as escorts, numbered `VSC482-A`, `VSC482-B`.
- **A timeline** shows the last 30 minutes of each agent as a track, so you can see when each one
  was busy and when it sat idle.
- **Click anything** to see its flight plan, the full launch chain (launchd → iTerm2 → zsh → `orchestrate.py` →
  `claude`), the lines of the launching script that call Claude, recent tool calls, tokens, git
  branch and working directory.

Everything runs on your machine. It reads only process metadata and files Claude Code already
writes under `~/.claude`, and it serves the UI on `127.0.0.1`.

## Quick start

Requires Node 22.4+ and macOS or Linux.

```bash
git clone https://github.com/djcopp/groundcontrol && cd groundcontrol
pnpm install && pnpm build
node dist/server/cli.js            # opens http://127.0.0.1:4317
node dist/server/cli.js --demo     # simulated fleet, no agents needed
```

Keyboard: `t` toggles the map and the timeline, `+` `-` `0` zoom, `Esc` closes the panel. Click a state
in the top bar to highlight just those agents. "Notify me" sends a desktop notification when an
agent starts waiting on you, and the tab title always shows how many need attention, e.g.
`(1! 3) Ground Control`.

## Remote machines over SSH

Lots of agents run on servers: a GPU box, a devcontainer host, a bot that answers in Slack and
shells out to `claude -p`. Add them with `--remote`:

```bash
node dist/server/cli.js --remote devbox --remote me@10.0.0.5
```

For each host, Ground Control opens an ordinary SSH session and runs `groundcontrol --stream`
on it. The remote collector writes one JSON snapshot per second to stdout, and trace requests travel
back over stdin. So:

- **No ports are opened** on either side and nothing is exposed to the network. Auth, jump hosts and
  aliases all come from your own `~/.ssh/config` and agent. `BatchMode` is on, so a host that wants
  a password shows an error instead of hanging.
- **The remote collector exits when the SSH session ends.** Nothing is left running on the server.
- Each machine becomes its own root in the pipe view, with its launchers and agents under it. A host
  that can't connect shows the last SSH error on its node.

The remote needs Node 22.4+ and this package installed and on the `PATH` of a non-interactive shell.
To point at a different install, or to use a different SSH client:

```bash
node dist/server/cli.js --remote gpu-box --remote-cmd "bash -lc 'cd ~/groundcontrol && node dist/server/cli.js --stream'"
node dist/server/cli.js --remote prod-bastion --ssh "tsh ssh"
node dist/server/cli.js --remote devbox --no-local   # only the remote
```

The default remote command is deliberately not `npx -y groundcontrol`: that would download and
run whatever is currently published under that name. Use npx explicitly via `--remote-cmd` once
you've checked what the package is.

Prefer a classic tunnel? Run `groundcontrol` on the server, then
`ssh -L 4317:127.0.0.1:4317 devbox` and open `http://localhost:4317`. That works too: the server
only accepts loopback Host headers, which a tunnel provides.

**What it can't see:** Claude in Slack, Claude on the web and other cloud-run sessions run on
Anthropic's infrastructure, not as a process on any machine you control, so there is nothing to
watch. A self-hosted Slack bot that spawns `claude` on your own server is visible: add that server
with `--remote`, and the bot's script appears as the agent's launcher, with the lines that call Claude.

## How it works

| What you see                      | Where it comes from                                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Which agents exist                | `ps`: any process whose executable is `claude` (native, desktop-bundled, or the npm `cli.js` under node)                                          |
| Where it was launched from        | the parent-process chain, classified into apps, terminals, IDEs, multiplexers, SSH and interpreters; shells and wrappers are folded into the pipe |
| The calling code                  | for interpreters in the chain, the script file is read and lines mentioning `claude`, `anthropic` or the Agent SDK are shown with context         |
| Working dir and branch            | `lsof` (macOS) or `/proc/<pid>/cwd` (Linux), then `.git/HEAD` read directly                                                                       |
| Busy or idle                      | `~/.claude/sessions/<pid>.json`, written by Claude Code itself (the sibling `.key` files are never opened)                                        |
| Thinking, tool, waiting, timeline | the session transcript `~/.claude/projects/<dir>/<session>.jsonl`, tailed incrementally                                                           |
| Blocked on permission             | a pending tool call while the session is idle, an Edit or Write pending for more than 6 s, or a Bash call pending with no child process           |
| Subagents                         | `<session>/subagents/agent-*.jsonl` and their `.meta.json`                                                                                        |

Headless agents (`claude -p`, SDK) often have no session file. They're matched to the transcript in
their project folder created closest to the process start.

## Options

```
-p, --port <n>        Port (default 4317)
    --host <addr>     Bind address (default 127.0.0.1)
    --demo            Simulated agents
    --claude-dir <d>  Claude config dir (default $CLAUDE_CONFIG_DIR or ~/.claude)
    --interval <ms>   Sample rate (default 1000)
    --window <min>    Timeline length (default 30)
    --no-details      Hide tool arguments (commands, file names)
    --json            Print one snapshot and exit
    --no-open         Don't open a browser
    --remote <target> Watch an SSH host too (repeatable)
    --remote-cmd <c>  Remote command (default "groundcontrol --stream")
    --ssh <cmd>       SSH client (default "ssh")
    --no-local        Only remote hosts
    --stream          Remote end of --remote: JSON lines on stdout
```

## Privacy and security

- The UI shows commands, paths, tool arguments and session names. It binds to `127.0.0.1`
  and rejects requests whose `Host` header isn't loopback, which blocks DNS-rebinding attacks from
  web pages. `--host 0.0.0.0` prints a warning, because anyone who can reach the port can see all of it.
- `--no-details` drops tool arguments at the source.
- No telemetry and no network calls. Fonts and icons are bundled.

## Development

```bash
pnpm dev        # API on :4317 + Vite UI on :5173 with hot reload
pnpm dev:demo   # same, simulated agents
pnpm test       # vitest
pnpm typecheck && pnpm lint && pnpm build
```

Layout: `src/collector/*` (process, session and transcript reading), `src/server.ts` (HTTP + SSE),
`src/remote.ts` (SSH hosts), `src/demo.ts`, `web/src/*` (React UI; `layout.ts` turns a snapshot
into pipe geometry).

Windows isn't supported yet: process ancestry needs a different backend there. PRs welcome.

## Credits

App logos are from [gilbarbara/logos](https://github.com/gilbarbara/logos) (CC0) and
[Simple Icons](https://simpleicons.org) (CC0), and interface glyphs from [Lucide](https://lucide.dev)
(ISC). See `web/public/icons/icons-credits.json`. Product names and logos are trademarks of their
owners and are used only to name the app an agent was launched from. Type is Reddit Sans and JetBrains Mono (SIL OFL).

MIT licensed.
