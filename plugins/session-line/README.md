# session-line

The model, the working directory and the checked-out git branch in one dim row under the prompt, above the hint line:

```
Opus 5.5 (1M context) · claude-plugins · main
```

The row is read again when a turn ends, the model is switched or the session moves to another directory. Outside a repository, and on a detached HEAD, the branch is left out.

```
claude plugin install session-line@stefan-claude-plugins
```
