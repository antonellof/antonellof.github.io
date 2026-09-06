---
layout: post
title: "gitgui: a real git GUI inside cmux, next to Pi"
date: 2026-09-03
categories: [How-To]
tags: [gitgui, cmux, Pi Agent, Git, Rust, iced, kitty graphics, macOS, Agentic AI]
excerpt: "I wanted a Sourcetree-class git GUI in the same cmux window as my coding agent. gitgui v0.4.0 renders pixels in the terminal with Rust and iced: draggable panes, a three-way conflict resolver, a code editor, history rewriting. Pi drives it over a Unix socket."
last_modified_at: 2026-09-06
render_with_liquid: false
---

I wrote [The Local Agent Trio: cmux + Pi + Unsloth Studio](/2026/cmux-pi-unsloth-local-glm-setup/) about splitting your local stack into cmux, inference, and Pi. Git stayed in the shell.

Pi runs `git status` and `git diff` fine. You still lose the commit graph, the staged file list, inline diffs, and hunk buttons when you review a refactor. I kept Alt-Tabbing to Fork or squinting at `git diff` output. I wanted Sourcetree in the same cmux grid as the agent.

So I built [gitgui](https://github.com/antonellof/gitgui), one Rust binary that paints a GUI into your terminal pane with the [kitty graphics protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/). Pixels, not a TUI. Graph, sidebar, diff viewer, commit box, editor, conflict resolver. cmux, Ghostty, kitty, WezTerm. Over SSH it sends zlib plus base64 frames.

*Updated 2026-09-06 for v0.4.0: the UI moved from egui to [iced](https://iced.rs), the panes drag and resize, and merge conflicts get a three-way resolver.*

This is what v0.4.0 looks like on a repo with branches, tags, a stash and a merge stopped on a conflict:

![gitgui v0.4.0: repository sidebar, commit graph with branch lanes, changes with a conflict, diff with the conflict banner](/assets/images/posts/gitgui-panes.png)

And my daily layout, Pi on the left, gitgui on the right:

![gitgui in a cmux split beside Pi: commit graph and diff on the right, agent session on the left](/assets/images/posts/gitgui-cmux-pi.png)

Pi edits the repo. gitgui shows branch lanes, unstaged files, and hunk buttons. One workspace. One checkout.
cmux + pi + gitgui = 😍

## Why stay inside the terminal?

cmux is a pane grid. You already split shell, Pi, and sometimes a browser. Fork or GitKraken pull you out: different font, different shortcuts, another app fighting for focus.

lazygit and gitui help for quick commits. They fall short when you read a three-file refactor with colored hunks, click Stage hunk on one block, and scan merge lanes on a graph. I wanted mouse clicks and a graph without leaving the grid.

[terminal-browser](https://github.com/zenbu-labs/terminal-browser) and [terminal-code](https://github.com/zenbu-labs/terminal-code) proved the pattern: render pixels in the terminal, read pixel mouse events back. gitgui uses [iced](https://iced.rs) instead of Chromium, driven without a window.

Three steps:

1. Build the iced UI, draw it with the tiny-skia software renderer straight into an RGBA framebuffer
2. Send the framebuffer as a kitty graphics image each frame
3. Map kitty keyboard and SGR mouse events into iced events

Your terminal never prints UI text. It shows a picture. Locally frames go through POSIX shared memory. On my Mac a 1600×1000 frame at 2x costs about 6 ms.

## What you get in v0.4.0

- **Panes you arrange**: repository, commits, changes and diff on an iced pane grid. Drag a title bar to move a pane, drag the gaps to resize, maximize with a click or `1` to `4`.
- **Commit graph** with branch lanes, ref pills, filter by summary, author or hash.
- **Staging by file, hunk or line**: click, Shift+click or drag lines in the diff, then Stage or Discard just those. Search in the diff, adjust context, ignore whitespace, wrap.
- **Three-way conflict resolver**: ours, result, theirs side by side with per-conflict take-left, take-right, keep-both, drop buttons, accept-all, edit the result, apply and mark resolved. Conflicted files also get a banner with whole-file ours / theirs.

![Three-way conflict resolver: ours, result, theirs with per-conflict buttons](/assets/images/posts/gitgui-merge.png)

- **History rewriting from the commit menu**: reword, squash, fixup, drop, move up / down, edit, autosquash. gitgui runs `git rebase` with itself as the sequence editor, so no editor pops up in your pane.
- **Branches, remotes, tags, stashes** in a collapsible sidebar: checkout, create, rename, delete, merge, rebase onto, fast-forward, upstream, open pull request, delete on remote, fetch one remote, push a tag, apply / pop / drop / branch from stash.
- **File tree** of the whole working tree, folders listed on demand, changed files colored. Click a file and it opens in the built-in editor.
- **Editor** on iced's text editor with syntax colors for the common languages, undo, `Ctrl+S`. `Shift+E` opens the file in your own editor in a new cmux split (`--editor`, `git config gitgui.editor`, `$EDITOR`; GUI editors like `code` open detached). `Shift+O` opens cmux's file preview.

![Built-in editor with syntax colors next to the repository sidebar](/assets/images/posts/gitgui-editor.png)

- **Merge and rebase state** in the footer with continue / abort / skip.
- **Branch switcher**, publish to GitHub through `gh`, initialize a non-git folder, auto refresh every 2 s when the repo changes.
- **Agent socket**: `gitgui ls`, `gitgui action '{"cmd":"status"}'`, so Pi or Cursor query status, select commits, stage paths, fetch, push, or save a PNG screenshot.

![Commit menu: cherry-pick, revert, reset, reword, squash, fixup, drop, move](/assets/images/posts/gitgui-menu.png)

Keys are single letters and Ctrl combinations terminals do not steal. cmux keeps Cmd+*. `?` lists them all. Quit with q or Ctrl+C, or click Quit in the footer.

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
GITGUI_VERSION=0.4.0 bash scripts/install.sh
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

main loop runs iced without a window: it builds the UI, feeds it the terminal events, applies the messages, and lets tiny-skia draw straight into the framebuffer that goes out as kitty graphics. The commit log, the diff and the conflict resolver are custom widgets that draw only their visible rows.

git worker uses libgit2 for reads and index writes. fetch, pull, and push shell out to `git` so your credential helper and SSH agent stay untouched. A background poll every 2 s refreshes the snapshot when files change on disk, so Pi edits show up without a manual refresh.

The UI reads an immutable RepoSnapshot. The worker swaps in a new snapshot after each command. Rendering never calls git.

iced 0.14 (`iced_core`, `iced_runtime`, `iced_widget`, `iced_renderer` on tiny-skia, no winit), git2, libc for termios and shm, serde for the agent API. No Electron. No GPU backend. No tokio. Spec and protocol bytes live in [docs/SPEC.md](https://github.com/antonellof/gitgui/blob/main/docs/SPEC.md) and [docs/PROTOCOLS.md](https://github.com/antonellof/gitgui/blob/main/docs/PROTOCOLS.md).

## One refactor, start to finish

Pi touches three files. You want the graph to update, one hunk staged and one left alone, and a commit message you wrote yourself. All inside cmux.

Before gitgui: `git diff` in the shell for small diffs, Alt-Tab to Fork for a graph, lazygit when you want speed over pixels.

Now: `gitgui --split right .` once per session. Tab between Pi and gitgui. Edits from Pi land in the unstaged list within a couple of seconds. Stage one hunk, leave another, or select three lines and stage just those. Type a message, hit Commit & Push, or fetch first from the footer. Need a feature branch? Click the branch name, pick from the list, stash if you have WIP. Merge came back with conflicts? Click Resolve, take a side per conflict, Apply, Continue. Want to fix a typo in a file Pi touched? Click it in the tree, edit, `Ctrl+S`.

cmux still rings when Pi waits on you. Mouse clicks hit the right widgets. SSH sessions use the direct transport and the same UI.

## What it still skips

cmux and Ghostty are the main targets. kitty works. tmux and Zellij need graphics passthrough and fail today.

Ghostty on macOS has no stable split-from-child API. `gitgui --split` prints a keybind hint and runs in the current pane when needed.

The editor has no line-number gutter yet, and the resolver's result column is not editable in place: press Edit result to hand-edit the merged file.

If you already run cmux and Pi, gitgui is the git pane I wished existed. Install it, split right, keep the graph beside the harness.

---

gitgui: [github.com/antonellof/gitgui](https://github.com/antonellof/gitgui). cmux: [cmux.dev](https://cmux.dev). Pi: [pi.dev](https://pi.dev). Related: [The Local Agent Trio: cmux + Pi + Unsloth Studio](/2026/cmux-pi-unsloth-local-glm-setup/).
