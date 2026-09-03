---
layout: post
title: "gitgui: a real git GUI inside cmux, next to Pi"
date: 2026-09-03
categories: [How-To]
tags: [gitgui, cmux, Pi Agent, Git, Rust, egui, kitty graphics, macOS, Agentic AI]
excerpt: "I wanted a Sourcetree-class git GUI in the same cmux window as my coding agent. gitgui v0.1.4 renders pixels in the terminal with Rust and egui: footer toolbar, branch switcher, auto refresh, GitHub publish. Pi drives it over a Unix socket."
render_with_liquid: false
---

I wrote [The Local Agent Trio: cmux + Pi + Unsloth Studio](/2026/cmux-pi-unsloth-local-glm-setup/) about splitting your local stack into cmux, inference, and Pi. Git stayed in the shell.

Pi runs `git status` and `git diff` fine. You still lose the commit graph, the staged file list, inline diffs, and hunk buttons when you review a refactor. I kept Alt-Tabbing to Fork or squinting at `git diff` output. I wanted Sourcetree in the same cmux grid as the agent.

So I built [gitgui](https://github.com/antonellof/gitgui) a Rust one binary that paints a GUI into your terminal pane with the [kitty graphics protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/). Pixels, not a TUI. Graph, sidebar, diff viewer, commit box. cmux, Ghostty, kitty, WezTerm. Over SSH it sends zlib plus base64 frames.

This is my daily layout:

![gitgui in a cmux split beside Pi: commit graph and diff on the right, agent session on the left](/assets/images/posts/gitgui-cmux-pi.png)

Pi on the left edits the repo. gitgui on the right shows branch lanes, unstaged files, and hunk buttons. One workspace. One checkout. 
cmux + pi + gitgui = 😍

## Why stay inside the terminal?

cmux is a pane grid. You already split shell, Pi, and sometimes a browser. Fork or GitKraken pull you out: different font, different shortcuts, another app fighting for focus.

lazygit and gitui help for quick commits. They fall short when you read a three-file refactor with colored hunks, click Stage hunk on one block, and scan merge lanes on a graph. I wanted mouse clicks and a graph without leaving the grid.

[terminal-browser](https://github.com/zenbu-labs/terminal-browser) and [terminal-code](https://github.com/zenbu-labs/terminal-code) proved the pattern: render pixels in the terminal, read pixel mouse events back. gitgui uses [egui](https://github.com/emilk/egui) instead of Chromium.

Three steps:

1. Draw the UI into an RGBA framebuffer with egui
2. Send the framebuffer as a kitty graphics image each frame
3. Map kitty keyboard and SGR mouse events into egui input

Your terminal never prints UI text. It shows a picture. Locally frames go through POSIX shared memory. On my Mac a 1600×1000 release build rasterizes in about 6 ms.

You get a commit graph with branch lanes, a sidebar for branches/tags/stashes, unstaged and staged lists, per-hunk stage and unstage, a compact commit box with Commit and Commit & Push, fetch/pull/push through your existing `git` CLI, and a JSON-lines socket so Pi or Cursor queries status, selects commits, stages paths, or saves a PNG screenshot.

**v0.1.4** adds the polish I use every day:

- **Footer toolbar**: icon buttons for Fetch, Pull, Push, Refresh, and Quit. No more squinting at key hints in the status bar.
- **Branch switcher**: click the current branch in the status bar, search local and remote branches, confirm when you have dirty files (stash and switch, discard, or cancel).
- **Auto refresh**: the worker polls every 2 s. Edits from Pi in the left pane show up on the right without pressing `r`.
- **Publish to GitHub**: no `origin` remote yet? One modal runs `gh repo create`, adds origin, and pushes. Needs `gh auth login`.
- **Non-git folders**: open any path. gitgui offers **Initialize git repository** instead of exiting.
- **Diff wrap**: toggle wrap in the diff viewer. Long lines get the row height they need instead of clipping.

Keys are single letters and Ctrl combinations terminals do not steal. cmux keeps Cmd+*. Quit with q or Ctrl+C, or click Quit in the footer.

## Install

You need macOS or Linux and a kitty-graphics terminal.

Quick start:

```bash
curl -fsSL https://raw.githubusercontent.com/antonellof/gitgui/main/scripts/install.sh | bash
```

That one-liner works on public repos. Private repo? Clone with `gh` and run the script locally:

```bash
gh repo clone antonellof/gitgui
cd gitgui
bash scripts/install.sh
```

Pin a release:

```bash
GITGUI_VERSION=0.1.4 bash scripts/install.sh
```

The script pulls a release binary when GitHub has one. Otherwise it builds from source with cargo (Rust 1.95+). Success looks like:

```
installed: ~/.local/bin/gitgui

run in a kitty-graphics terminal (cmux, Ghostty, kitty):
  gitgui                  open repo in current directory
  gitgui /path/to/repo    open a specific repo
  gitgui --split right .  open in a new terminal split

quit with q or Ctrl+C
```

Check terminal support:

```bash
gitgui --probe
```

## cmux + Pi + gitgui

Same workspace as the trio post. One extra split.

Pane A, Pi:

```bash
cd ~/Projects/my-app
pi
```

Pane B, gitgui, from the agent pane:

```bash
gitgui --split right .
```

cmux runs `new-split right` and `send` with the gitgui command. Or split by hand and type `gitgui` in the new pane.

Give your agent the skill file:

```bash
mkdir -p ~/.cursor/skills/gitgui
ln -sf ~/path/to/gitgui/skill/SKILL.md ~/.cursor/skills/gitgui/SKILL.md
```

Drive the GUI from the shell:

```bash
gitgui ls
gitgui action '{"cmd":"status"}'
gitgui action '{"cmd":"stage","paths":["src/main.rs"]}'
gitgui action '{"cmd":"fetch"}'
gitgui action '{"cmd":"commit_and_push","message":"fix layout"}'
gitgui action '{"cmd":"screenshot","path":"/tmp/frame.png"}'
```

Run `action` from the pane where gitgui lives and it finds the instance via the controlling tty. Writes queue on a background git thread. Poll status until busy hits zero.

A typical session: Pi edits and runs tests on the left. gitgui auto-refreshes on the right. You stage hunks, click Commit or Commit & Push, or use Ctrl+Enter / Ctrl+Shift+Enter. Switch branches from the status bar when Pi opens a feature branch. Or Pi stages through `gitgui action` and you type the commit message yourself.

## Inside the binary

One Rust process. Three threads.

stdin reader blocks on terminal bytes and feeds a parser for kitty keys, SGR mouse, paste, resize.

main loop runs egui, tessellates meshes, rasterizes triangles, encodes kitty graphics.

git worker uses libgit2 for reads and index writes. fetch, pull, and push shell out to `git` so your credential helper and SSH agent stay untouched. A background poll every 2 s refreshes the snapshot when files change on disk, so Pi edits show up without a manual refresh.

The UI reads an immutable RepoSnapshot. The worker swaps in a new snapshot after each command. Rendering never calls git.

egui 0.36, a custom rasterizer, git2, libc for termios and shm, serde for the agent API. No Electron. No GPU backend. No tokio. Spec and protocol bytes live in [docs/SPEC.md](https://github.com/antonellof/gitgui/blob/main/docs/SPEC.md) and [docs/PROTOCOLS.md](https://github.com/antonellof/gitgui/blob/main/docs/PROTOCOLS.md).

## One refactor, start to finish

Pi touches three files. You want the graph to update, one hunk staged and one left alone, and a commit message you wrote yourself. All inside cmux.

Before gitgui: `git diff` in the shell for small diffs, Alt-Tab to Fork for a graph, lazygit when you want speed over pixels.

Now: `gitgui --split right .` once per session. Tab between Pi and gitgui. Edits from Pi land in the unstaged list within a couple of seconds. Stage one hunk, leave another. Type a message, hit Commit & Push, or fetch first from the footer toolbar. Need a feature branch? Click the branch name, pick from the list, stash if you have WIP. First push to GitHub? Publish from the modal when there is no origin yet.

cmux still rings when Pi waits on you. Mouse clicks hit the right widgets. SSH sessions use the direct transport and the same UI.

## What v1 skips

cmux and Ghostty are the main targets. kitty works. tmux and Zellij need graphics passthrough and fail today.

Ghostty on macOS has no stable split-from-child API. `gitgui --split` prints a keybind hint and runs in the current pane when needed.

Merge conflict UI is out of scope for v1. Use git on the CLI or your desktop client for conflicts.

If you already run cmux and Pi, gitgui is the git pane I wished existed. Install it, split right, keep the graph beside the harness.

---

gitgui: [github.com/antonellof/gitgui](https://github.com/antonellof/gitgui). cmux: [cmux.dev](https://cmux.dev). Pi: [pi.dev](https://pi.dev). Related: [The Local Agent Trio: cmux + Pi + Unsloth Studio](/2026/cmux-pi-unsloth-local-glm-setup/).
