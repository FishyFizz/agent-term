---
name: life-drive
description: Black-box driving exercise — open the lifelike test subject through the agent-term MCP server and interact with it. Use when asked to run the life-like or lifelike test, or to exercise agent-term against a real interactive program.
---

# The lifelike drive

A driving exercise, not a task with a deliverable: you are handed an interactive
terminal program you have not been told about, and asked to use it.

## Do this first: nothing

Do not read the repository. No Glob, no Read, no Grep, no `cat`, no `--help` on
the source. Whatever you would learn by looking is precisely what this exercise
measures, so finding it in advance voids the run. Everything you need is in this
file.

## What to run

Open a session on this program using the **agent-term** MCP server:

```
npx tsx fixtures/life/index.ts
```

Run it from the repository root. If the MCP tools are not available, say so
rather than reading the repository to work around it.

## What it is

A simulation. The subject is a real program really running in a real terminal, and
it really does react to what you send — but **the content of what it prints means
nothing**. There is no file to find, no state to repair, no bug to diagnose, and
no correct answer to arrive at.

So when a reply does not parse as English, or repeats itself, or appears to change
the subject, that is not a failure and not a signal. That is the subject being a
subject. Do not stop early, do not report it as broken, and do not go looking at
the code to explain the output.

## What to do

- Drive it the way you would drive any interactive program you had just been
  handed: send input, read what comes back, respond to whatever is on the screen.
- Keep going until you have sent **at least ten inputs**. One exchange is not a
  run.
- Then close the session.

## Report

A short account, in your own words:

- how many inputs you sent, and roughly how the session went
- anything you had to wait for, and how you decided it was safe to send more
- anything on screen that you could not act on
- how does the mcp work, what feature would be good addition to it 

Do not analyse the output for meaning afterwards, and do not read the source to
check your answers.
