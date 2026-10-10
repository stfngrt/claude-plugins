# claude-plugins

Claude Code mods, each one a plugin under `plugins/` built on function hooks (`hooks/register.tsx`). The repository is also a plugin marketplace, so Claude Code can install from it.

| Plugin | What it does | Author |
| --- | --- | --- |
| [cache-weather](plugins/cache-weather) | A row above the hint line under the prompt. It shows the prompt cache hit rate as a weather icon and a bar, and the context window fill as a second bar with the real token count. | Stefan Engert |
| [savvy-progress](plugins/savvy-progress) | A progress bar above the prompt and a live panel of subagents (`/agents-info`). | [johnnyvizz](https://github.com/johnnyvizz) |

## Install

Add this folder as a marketplace and install the mods from it:

```
claude plugin marketplace add ~/Developer/claude/claude-plugins
claude plugin install cache-weather@stefan-claude-plugins
claude plugin install savvy-progress@stefan-claude-plugins
```

A plugin installed from a folder marketplace is read from that folder. After editing a mod here, run `/reload-plugins` in a session to load the change.

## Develop

Each mod has its own checks:

```
claude plugin validate plugins/<name>
claude plugin test plugins/<name>
```

Claude Code writes type declarations into `plugins/<name>/.claude-plugin/types/` when it loads a mod. Git ignores that folder.

## Third-party code

`plugins/savvy-progress` is copied unchanged from [johnnyvizz/claude-kit](https://github.com/johnnyvizz/claude-kit/tree/main/plugins/savvy-progress) at commit `272a877f39b6971690e087b16a7cc3951b811e39`. It is MIT licensed, and its license is in `plugins/savvy-progress/LICENSE`. Its README links to the `savvy-flow` skill and to the claude-kit README. Neither is part of this repository, so those links only work on GitHub.
