---
sidebar_label: 'Workshop 1 — The Five Building Blocks'
sidebar_position: 1
---

# Claude Code Basics: An Interactive Tutorial

> **How to use this file**: Paste the prompt blocks marked with ▶ into Claude Code one at a time.
> Each prompt builds on the previous step, creating a working mini-project as you go.
> By the end you will have built the same structure as this project — from scratch.

---

## Overview: The Five Building Blocks

Claude Code has five core extension points:

| Concept | What it is | Where it lives |
|---|---|---|
| **Tool** | A Python (or any) script that does deterministic work | `tools/` |
| **Workflow** | A markdown SOP that tells Claude which tools to run and how | `workflows/` |
| **Command** | A `/slash-command` that users type in Claude Code | `.claude/commands/` |
| **Skill** | A self-contained capability with its own assets and scripts | `.claude/skills/<name>/` |
| **Hook** | A shell command that fires automatically on lifecycle events | `.claude/settings.json` |

The mental model: **Hooks** start or end work automatically. **Commands** are how users trigger tasks. **Skills** are packaged capabilities. **Workflows** describe the steps. **Tools** do the actual execution.

---

## Step 1 — Tool

### What is a Tool?

A **Tool** is a Python script in `tools/` that does exactly one thing: takes deterministic inputs and produces deterministic outputs. Claude does not try to fetch data or call APIs inline — it delegates to tools. This keeps AI reasoning separate from I/O, which is what makes the system reliable.

**Key properties:**
- Takes arguments via `sys.argv`
- Prints results to stdout (text or JSON)
- Exits non-zero on failure
- Has no side effects beyond its stated purpose

### Real Example: `tools/get_weather.py`

This tool calls the [wttr.in](https://wttr.in) API and returns weather data. It supports two output modes: human-readable text (default) and `--json` for machine consumption by Claude.

```python
# tools/get_weather.py
import sys
import json
import requests

def get_weather(location: str = "", as_json: bool = False) -> None:
    url = f"https://wttr.in/{location}?format=j1"
    response = requests.get(url, timeout=10)
    response.raise_for_status()
    data = response.json()

    nearest = data["nearest_area"][0]
    city    = nearest["areaName"][0]["value"]
    country = nearest["country"][0]["value"]

    current = data["current_condition"][0]
    temp_c  = current["temp_C"]
    temp_f  = current["temp_F"]
    ...

    if as_json:
        print(json.dumps({"city": city, "country": country, "temp_c": int(temp_c), ...}))
    else:
        print(f"Weather for {city}, {country}")
        print(f"  Temperature: {temp_c}°C / {temp_f}°F")
        ...

if __name__ == "__main__":
    location = sys.argv[1] if len(sys.argv) > 1 else ""
    as_json  = "--json" in sys.argv
    get_weather(location, as_json)
```

The `--json` flag is the key design pattern: Claude uses it to parse structured output; humans can run the script without `--json` for readable output.

**Sample output** — `python3 tools/get_weather.py Mumbai --json`:
```json
{
  "city": "Mumbai",
  "country": "India",
  "temp_c": 31,
  "temp_f": 88,
  "feels_c": 37,
  "feels_f": 99,
  "condition": "Haze",
  "humidity": "75",
  "wind_kmph": "21",
  "wind_dir": "SW"
}
```

This is exactly what the workflow in Step 2 parses — each field name in the workflow's Steps section maps directly to a key here.

### Two more tools in this project

**`tools/get_hottest_city.py`** — given a country name, fetches weather for 10–20 major cities in parallel (using `ThreadPoolExecutor`) and returns the hottest one as JSON. Parallel fetching keeps wall time under 3 seconds.

**`tools/get_quote.py`** — calls the `dummyjson.com` API and returns a random quote as JSON. On failure it returns `{"error": "..."}` rather than crashing, so the workflow can skip it gracefully.

### ▶ Build It: Create your first tool

Paste this prompt into Claude Code to build the weather tool:

```
Create tools/get_weather.py — a Python script that fetches weather from
https://wttr.in/<location>?format=j1 (use requests library).

Requirements:
- Accept location as sys.argv[1], default to "" (wttr.in auto-detects via IP)
- Accept --json flag in sys.argv to switch output mode
- Without --json: print a human-readable summary (city, country, condition,
  temp in C and F, feels-like, humidity, wind speed and direction)
- With --json: print a single JSON object with these keys:
  city, country, temp_c, temp_f, feels_c, feels_f, condition, humidity,
  wind_kmph, wind_dir
- On HTTP or network error: print to stderr and sys.exit(1)
- Use requests; assume it is installed
```

After Claude creates the file, test it:
```
Run: python3 tools/get_weather.py Mumbai --json
```

---

## Step 2 — Workflow

### What is a Workflow?

A **Workflow** is a markdown file in `workflows/` that acts as an SOP (Standard Operating Procedure). It tells Claude exactly:
1. What the goal is
2. What inputs are required
3. Which tools to run, in which order, with which arguments
4. How to parse and use each tool's output
5. What to do when things go wrong

Workflows are the "recipe" — Claude is the cook, tools are the kitchen equipment.

**Why markdown and not code?** Because the *coordination logic* (if country is X, do Y; if tool returns error, skip Z) requires judgment. Markdown lets Claude reason over edge cases that no static script could anticipate.

### Real Example: `workflows/weather_comparison.md`

```markdown
# Workflow: Weather Comparison

## Objective
Fetch weather for a given location, find the hottest city in that country
right now, and print a formatted comparison summary to the console.

## Required Inputs
- `location`: city name or empty string (auto-detects via IP)

## Steps

1. Run `python3 tools/get_weather.py "<location>" --json`
   - Parse JSON output: city, country, temp_c, temp_f, feels_c, feels_f,
     condition, humidity, wind_kmph, wind_dir

2. Extract the `country` field from step 1.

3. Run `python3 tools/get_hottest_city.py "<country>"`
   - Parse JSON output: city, country, temp_c, condition
   - If the result contains an `error` key, skip the comparison section

4. Print the formatted summary:
   Weather Report: <city>, <country>
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     Temperature: <temp_c>°C / <temp_f>°F
     ...
   Hottest in <country> right now: <hottest_city> at <hottest_temp_c>°C
     <city> is X°C cooler/hotter than the hottest city

5. Run `python3 tools/get_quote.py`
   - Append quote to summary; if error key is present, skip silently.

## Edge Cases
- If get_hottest_city.py returns an error, show only current weather.
- If location is empty, wttr.in auto-detects via IP.
```

Notice the structure: each step names the exact command to run, names the exact JSON fields to parse, and specifies the fallback if it fails. Claude reads this document and follows it literally — it is both human documentation and Claude's instructions.

### Why not just tell Claude what you want inline?

If you skip the workflow and just say "get weather and compare to hottest city", Claude will:
- Potentially try to do it in different ways each time
- Make judgment calls about error handling that may differ run to run
- Have no record of the steps to improve later

A workflow file is **persistent, versioned, and improvable**. When you discover a new edge case (e.g., wttr.in rate-limits at 60 requests/min), you add it to the workflow once and it's handled forever.

### ▶ Build It: Create the weather workflow

Paste this prompt into Claude Code (assumes you completed Step 1):

```
Create workflows/weather_comparison.md — a workflow SOP for Claude to follow.

Objective: fetch weather for a location, find the hottest city in the same
country, and print a formatted comparison.

The workflow should specify:
1. Run python3 tools/get_weather.py "<location>" --json → parse city, country,
   temp_c, temp_f, feels_c, feels_f, condition, humidity, wind_kmph, wind_dir
2. Use the country field to run python3 tools/get_hottest_city.py "<country>"
   → parse city, temp_c, condition; skip comparison if response has "error" key
3. Print a formatted summary using box-drawing characters (━, ─) showing:
   - Current weather block (all fields from step 1)
   - Hottest city line with temperature delta (X°C cooler/hotter)
   - Special case: if current city == hottest city, say "You're in the hottest city!"
4. Run python3 tools/get_quote.py → append quote to output; skip silently on error

Include an Edge Cases section covering: error from get_hottest_city, empty
location input, city name matching hottest city.
```

---

## Step 3 — Command

### What is a Command?

A **Command** is a markdown file in `.claude/commands/` that creates a `/slash-command` for users to type in Claude Code. When a user types `/weather Mumbai`, Claude Code:
1. Reads `.claude/commands/weather.md`
2. Extracts the argument (`Mumbai`)
3. Follows the instructions in the file

**A command is not a workflow** — it is the user-facing entry point that receives arguments and delegates to a workflow. Think of it as the "interface" and the workflow as the "implementation".

### Real Example: `.claude/commands/weather.md`

```markdown
Fetch current weather and compare it against the hottest city in the same country.

## Usage
/weather [location]

- `/weather` — auto-detects location based on IP
- `/weather Mumbai` — fetches weather for a specific city

## Steps
1. Extract the location argument from the invocation (everything after `/weather`).
   If none provided, use an empty string.
2. Read and follow `workflows/weather_comparison.md` exactly, passing the
   location as input.
```

This file is intentionally thin — it does two things only: documents usage, and points at the workflow. All the real logic lives in the workflow.

### The anatomy of a command file

| Section | Purpose |
|---|---|
| First line (no heading) | Short description shown in Claude Code's command picker |
| `## Usage` | Documents how to invoke the command and what arguments it takes |
| `## Steps` | What Claude should do: parse args, read workflow, call tools |

### Argument passing pattern

The convention `everything after /weather` is how commands receive arguments. For example:
- `/weather` → location = `""`
- `/weather Mumbai` → location = `"Mumbai"`
- `/weather New York` → location = `"New York"`

Claude parses this naturally from the invocation text. No configuration needed — it is plain English in the Steps section.

### ▶ Build It: Create the /weather command

Paste this into Claude Code:

```
Create .claude/commands/weather.md — a slash command definition for /weather.

The first line (no heading) should be a one-line description:
  "Fetch current weather and compare it against the hottest city in the same country."

Include:
- ## Usage section showing:
    /weather           — auto-detects location via IP
    /weather Mumbai    — specific city
    /weather New York  — multi-word city works too
- ## Steps section with exactly two steps:
    1. Extract everything after "/weather" as the location arg; use "" if nothing
    2. Read and follow workflows/weather_comparison.md exactly, passing location as input
```

After creating it, test in Claude Code by typing: `/weather London`

---

## Step 4 — Skill

### What is a Skill?

A **Skill** is a self-contained, packaged capability that lives in `.claude/skills/<name>/`. Unlike a command (which is a thin entry point) or a workflow (which orchestrates tools), a skill bundles together:

- `SKILL.md` — the full instructions for how to execute this capability
- `assets/` — data files, PDFs, reference material the skill needs
- `scripts/` — helper scripts specific to this skill

Skills are designed to be **portable** — you can copy the entire `.claude/skills/explain-semaphore/` directory into any other Claude Code project and it works immediately.

### Real Example: `.claude/skills/explain-semaphore/`

```
.claude/skills/explain-semaphore/
├── SKILL.md                                    # Instructions
├── assets/
│   └── LittleBookOfSemaphores.pdf              # Reference material
└── scripts/
    └── extract_chapter.py                      # Helper script
```

**`SKILL.md` frontmatter and structure:**
```markdown
---
description: Explain semaphore concepts, puzzles, and patterns using
             The Little Book of Semaphores as the authoritative local reference.
---

# Skill: explain-semaphore

## Purpose
Answer questions about semaphores by extracting and reasoning over the
actual text of The Little Book of Semaphores (Downey, 2016).

## Setup (first time only)
[instructions to recreate venv and download PDF if missing]

## Steps
1. Verify PDF exists; if not, download it
2. Identify what the user wants — chapter, puzzle, concept, or pattern
3. Extract relevant text using extract_chapter.py or direct page-range reads
4. Read extracted text carefully before answering
5. Explain with: what it is, why it matters, pseudocode, invariants, pitfalls
6. Offer to go deeper on sub-concepts

## Book Structure (quick reference)
| Chapter | Topic |
|---|---|
| 1 | Introduction |
| 2 | Semaphore definition |
...
```

**The `description:` frontmatter field** is what Claude Code displays in the skill picker and uses to decide when to invoke the skill automatically.

### Skill vs Command vs Workflow

| | Command | Workflow | Skill |
|---|---|---|---|
| Entry point | User types `/name` | Read by Claude or Command | User invokes via Skill tool or `/name` |
| Assets bundled | No | No | Yes |
| Self-contained | No (depends on workflows/) | No (calls tools/) | Yes (has its own scripts/) |
| Use case | User-facing shortcut | Multi-step orchestration | Capability requiring reference data |

A good rule of thumb: use a **skill** when the capability needs bundled reference material or helper scripts that are specific to that capability alone. Use a **command + workflow + tool** when the capability is about orchestrating existing external APIs.

### ▶ Build It: Create a quote-of-the-day skill

Paste this into Claude Code:

```
Create a skill at .claude/skills/daily-quote/ that fetches and displays a
random inspirational quote with a reflection.

Structure:
1. .claude/skills/daily-quote/SKILL.md  with frontmatter description:
     "Fetch and display a random inspirational quote with a tailored reflection."

2. .claude/skills/daily-quote/assets/reflection-angles.txt — a plain-text
   file listing these five reflection angles, one per line:
     What does this mean for how we write code?
     How does this apply to debugging and problem-solving?
     How does this relate to working in a team?
     What does this say about learning and growth?
     How does this connect to building reliable systems?

The SKILL.md should include:

## Purpose
Fetch a random quote and reflect on it through a software engineering lens,
using one of the bundled reflection angles.

## Steps
1. Read .claude/skills/daily-quote/assets/reflection-angles.txt
2. Run: python3 tools/get_quote.py
3. Parse JSON output: quote, author fields
4. Print the quote formatted as:
   ─────────────────────────────────────
   "<quote>"
     — <author>
   ─────────────────────────────────────
5. Pick the reflection angle from the file that fits the quote best.
   Write 2-3 sentences using that angle.

## Error handling
If get_quote.py returns an error key, say "Could not fetch a quote right now."

## Example invocations
- "give me a quote"
- "show me something inspiring"
- /daily-quote
```

Then add the matching command:
```
Create .claude/commands/daily-quote.md — a slash command that invokes the
daily-quote skill.

First line: "Fetch and display a random inspirational quote with reflection."

Steps:
1. Read and follow .claude/skills/daily-quote/SKILL.md exactly.
```

The `assets/reflection-angles.txt` file is what makes this a skill rather than a plain command — it bundles reference data that travels with the capability. If you copied `.claude/skills/daily-quote/` into any other project, the skill brings its own context with it.

---

## Step 5 — Hook

### What is a Hook?

A **Hook** is a shell command that Claude Code runs automatically when a lifecycle event occurs. Hooks are configured in `.claude/settings.json` under the `"hooks"` key.

Hooks let you attach behavior to Claude's lifecycle **without** requiring the user to ask for it. The work just happens automatically.

### Available lifecycle events

| Event | When it fires |
|---|---|
| `Stop` | After Claude finishes a response and stops |
| `PreToolUse` | Before Claude calls any tool |
| `PostToolUse` | After a tool call completes |
| `Notification` | When Claude Code sends a user notification |

### Real Example: The Bash command auditor

This project uses a `PreToolUse` hook to log every shell command Claude runs to an audit file — so you always know exactly what was executed and when.

**`.claude/settings.json`:**
```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "python3 /absolute/path/to/project/.claude/scripts/bash-auditor.py"
          }
        ]
      }
    ]
  }
}
```

> **Important**: always use an **absolute path** in the `command` field. Hooks run from a different working directory than your project root, so relative paths like `python3 .claude/scripts/foo.py` silently fail.

**`.claude/scripts/bash-auditor.py`:**
```python
#!/usr/bin/env python3
import json
import sys
from datetime import datetime
from pathlib import Path

payload = json.load(sys.stdin)
command = payload.get("tool_input", {}).get("command", "")
if not command.strip():
    sys.exit(0)

log = Path(__file__).parent.parent / "bash-audit.log"
timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
truncated = command.replace("\n", " ")[:120]
with log.open("a") as f:
    f.write(f"[{timestamp}] {truncated}\n")
```

**What the hook does:**
1. Reads the `PreToolUse` payload from stdin — a JSON object with `tool_name` and `tool_input` fields
2. Extracts `tool_input.command` — the exact shell command Claude is about to run
3. Appends a timestamped, single-line entry to `.claude/bash-audit.log`

The hook receives a JSON payload on stdin:
```json
{
  "session_id": "...",
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": {
    "command": "python3 tools/get_weather.py Mumbai --json"
  }
}
```

After a Claude Code session you can run `cat .claude/bash-audit.log` and see every command it executed:
```
[2026-05-29 21:30:14] python3 tools/get_weather.py Mumbai --json
[2026-05-29 21:30:16] python3 tools/get_hottest_city.py India
[2026-05-29 21:30:19] python3 tools/get_quote.py
```

### Hook anatomy in settings.json

```json
{
  "hooks": {
    "<EventName>": [
      {
        "matcher": "<tool-name-pattern or empty string>",
        "hooks": [
          {
            "type": "command",
            "command": "<shell command to run>"
          }
        ]
      }
    ]
  }
}
```

- **`matcher`**: for `PreToolUse`/`PostToolUse`, filter by tool name (e.g., `"Bash"` to run only when Bash is called). Empty string `""` matches all.
- **`type`**: always `"command"` — runs a shell command
- **`command`**: any shell command; receives event payload on stdin as JSON

### Inline command vs Python script

Use an **inline shell command** when the hook is fire-and-forget with no payload reading needed — a timestamp log, a desktop notification, triggering a test run. Use a **Python script** when you need to parse the stdin JSON payload (to extract the command, file path, or transcript) or do anything conditional.

### Practical hook patterns

**Auto-format on file write (PostToolUse):**
```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write",
        "hooks": [{"type": "command", "command": "echo 'File written' >> .claude/write-log.txt"}]
      }
    ]
  }
}
```

**Run tests after every Bash tool call:**
```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{"type": "command", "command": "python3 -m pytest tests/ -q 2>&1 | tail -5"}]
      }
    ]
  }
}
```

**Log session end with timestamp:**
```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [{"type": "command", "command": "echo \"Session ended at $(date)\" >> .claude/session-log.txt"}]
      }
    ]
  }
}
```

### ▶ Build It: Add the Bash command auditor

Paste this into Claude Code:

```
Create .claude/scripts/bash-auditor.py — a PreToolUse hook script that logs
every Bash command Claude runs.

The script should:
1. Read JSON from stdin — this is the PreToolUse hook payload with fields:
     {"tool_name": "Bash", "tool_input": {"command": "..."}}
2. Extract tool_input.command; if it's empty or whitespace, exit 0 immediately
3. Build a log path: .claude/bash-audit.log (relative to the project root,
   which is two directories up from the script's own location)
4. Get the current timestamp as "YYYY-MM-DD HH:MM:SS"
5. Truncate the command to 120 chars and collapse newlines to spaces
6. Append a line to the log: "[<timestamp>] <command>\n"

Then update .claude/settings.json to wire it up:
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{"type": "command", "command": "python3 /absolute/path/to/project/.claude/scripts/bash-auditor.py"}]
      }
    ]
  }
}
```

Replace `/absolute/path/to/project` with the actual full path to your project root (e.g. `pwd` in the terminal).

To verify it works, ask Claude to run any bash command (e.g. "list the files in tools/"), then check:
```
Run: cat .claude/bash-audit.log
```
You should see a timestamped entry for every command Claude ran.

---

## Putting It All Together

Here is the complete architecture of this project, showing how the five concepts connect:

```
User types: /weather Mumbai
       │
       ▼
.claude/commands/weather.md          ← COMMAND (entry point, arg parsing)
       │  "read and follow the workflow, location=Mumbai"
       ▼
workflows/weather_comparison.md      ← WORKFLOW (step-by-step SOP)
       │  step 1: run get_weather.py
       │  step 3: run get_hottest_city.py
       │  step 5: run get_quote.py
       ▼
tools/get_weather.py                 ← TOOL (deterministic execution)
tools/get_hottest_city.py            ← TOOL (parallel API calls)
tools/get_quote.py                   ← TOOL (single API call)
       │
       ▼
Formatted output printed to terminal

Meanwhile, before every Bash tool call...

.claude/settings.json PreToolUse hook  ← HOOK (automatic lifecycle trigger)
       │  matcher: "Bash" → fires bash-auditor.py
       ▼
.claude/bash-audit.log               ← timestamped record of every command run
```

The skill (`explain-semaphore`) is independent — it bundles its own PDF and extraction script, and is invoked separately when a user asks about concurrency concepts.

---

## ▶ Final Challenge: Build a New Feature End-to-End

Now that you understand all five concepts, build something new using all of them. Paste this into Claude Code:

```
Build a complete "news headline" feature using all five Claude Code concepts:

1. TOOL: Create tools/get_news.py
   - Fetch top headlines from https://gnews.io/api/v4/top-headlines?lang=en&max=5&apikey=demo
   - Accept --topic flag (e.g., --topic technology) to filter by topic
   - With --json flag: output array of {title, source, url, publishedAt}
   - Without --json: print a numbered list of headlines with source

2. WORKFLOW: Create workflows/news_briefing.md
   - Run get_news.py with optional topic, parse JSON
   - Print a formatted briefing header with current date/time
   - List each headline with source and published time
   - Run get_quote.py and append it as a closing thought
   - Edge cases: if news API fails, show error message; if no headlines, say so

3. COMMAND: Create .claude/commands/news.md
   - /news          → general top headlines
   - /news tech     → technology headlines
   - Parse the argument after /news as the topic (empty = all topics)
   - Delegate to workflows/news_briefing.md

4. SKILL: Create .claude/skills/news-briefing/ with SKILL.md
   - Description: "Fetch and present top news headlines with a closing thought"
   - Bundle a topics reference table in the SKILL.md (technology, sports,
     science, health, business, entertainment, world)
   - Steps should check if get_news.py exists before running

5. HOOK: Add a PreToolUse hook in settings.json that fires when the Bash
   tool is called and logs the command to .claude/bash-audit.log with timestamp
   (just append: "<timestamp> CMD: <command substring>" — you can read the
   payload from stdin as JSON, field "tool_input.command")

Build all five files, then test with: /news technology
```

---

## Quick Reference Card

### File locations

```
project/
├── tools/                          # Python scripts (Tools)
│   ├── get_weather.py
│   ├── get_hottest_city.py
│   └── get_quote.py
├── workflows/                      # Markdown SOPs (Workflows)
│   └── weather_comparison.md
├── .claude/
│   ├── commands/                   # Slash commands (Commands)
│   │   └── weather.md
│   ├── skills/                     # Packaged capabilities (Skills)
│   │   └── explain-semaphore/
│   │       ├── SKILL.md
│   │       ├── assets/
│   │       └── scripts/
│   ├── scripts/                    # Hook scripts
│   │   └── bash-auditor.py
│   └── settings.json               # Hook configuration (Hooks)
└── .env                            # API keys (never commit)
```

### Tool output convention

```python
# Always support --json for machine-readable output
if "--json" in sys.argv:
    print(json.dumps({...}))        # structured, for Claude to parse
else:
    print("Human readable output")  # formatted, for direct use

# Signal failure with exit code + stderr message
if error:
    print(f"Error: {msg}", file=sys.stderr)
    sys.exit(1)

# For non-fatal errors, return error key in JSON
print(json.dumps({"error": "rate limited"}))  # caller decides what to do
```

### Workflow structure

```markdown
# Workflow: <Name>

## Objective
One sentence — what this workflow produces.

## Required Inputs
- `param`: description

## Steps
1. Run `python3 tools/foo.py "<param>" --json`
   - Parse: field_a, field_b
2. Use field_a to run `python3 tools/bar.py "<field_a>"`
   - If result has "error" key: [fallback behavior]
3. Print formatted output using values from steps 1 and 2.

## Edge Cases
- If step N fails: do X instead
```

### Command structure

```markdown
One-line description shown in command picker.

## Usage
/command-name [optional-arg]

- `/command-name` — what it does with no args
- `/command-name foo` — what it does with arg

## Steps
1. Extract argument (everything after `/command-name`); use default if none.
2. Read and follow `workflows/relevant_workflow.md` exactly, passing arg as input.
```

### Hook configuration

```json
{
  "hooks": {
    "Stop": [{"matcher": "", "hooks": [{"type": "command", "command": "..."}]}],
    "PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "..."}]}],
    "PostToolUse": [{"matcher": "Write", "hooks": [{"type": "command", "command": "..."}]}]
  }
}
```

Hook stdin payload for `PreToolUse`/`PostToolUse`: `{"session_id": "...", "tool_name": "Bash", "tool_input": {"command": "..."}}`
Hook stdin payload for `Stop`: `{"session_id": "...", "transcript_path": "/path/to/transcript.jsonl"}`

### Skill frontmatter

```markdown
---
description: One line describing what this skill does — used in the skill picker.
---

# Skill: <name>

## Purpose
## Setup (first time only)
## Steps
## Error handling
## Example invocations
```
