# The comparison bench

This folder answers one question honestly: **on the same task, is Syok Code as good as Claude Code, Codex and Cursor?**

It gives each tool the same task, in a fresh copy of the same project, with the same time limit and (in a lane) the same AI
model. Then the same grader decides, and a table shows the results side by side.

There are two parts:

| Part | What it does | Command |
|---|---|---|
| The orchestrator | Runs the tools on our own scenarios (`bench/scenarios/`) | `bun bench/run.ts` |
| The SWE-bench adapter | Runs one tool on SWE-bench instances, one container each, and writes predictions for the official harness | `bun bench/swebench/run.ts` |

> **Cost warning.** A real run calls paid AI services on **your own accounts** (your Syok key, your Claude, OpenAI or
> Cursor plan). The bench never runs a real tool without you naming it, uses `--runs 1` by default, and refuses a plan whose
> worst case is above `--max-spend` (default $5) unless you add `--yes`. The worst case is worked out from each scenario's
> `limits.maxCostUsd` (or $2 when a scenario sets none) times tools times runs. Only Claude Code (`--max-budget-usd`) and Syok
> Code (`--max-steps`) can be stopped by their own limits; Codex and Cursor have no such flag, so for them only the hard time
> limit applies. `--dry-run` and `--check` spend nothing.

## The fair-test rule

**Same model, different harness.** A "harness" is everything around the model: the instructions, the tools it can call,
how it reads files and runs tests. That is what we want to compare. If Syok Code used a stronger model than Claude Code, the
result would say nothing about the harness.

So use a lane:

- `--lane claude`: every tool must be pinned to the same Claude model.
- `--lane gpt`: every tool must be pinned to the same GPT model.

In a lane the bench **refuses to start** when the pinned models differ, when a model is from the other lane, or when a tool
has no model, and it prints why. After each run it also reads which model(s) actually answered (where the tool says so) and
notes any other model in the table.

- `--model <name>` pins all tools; `--model-<tool> <name>` pins one tool (for example `--model-codex gpt-5`).
- If a tool spells the same model differently, write `--model-<tool> <its spelling>=<common name>`. The first part is passed
  to the tool, the second is used for the check.
- **Syok Code routes between providers.** For a fair test, make a Syok key that only has the one model you are testing
  (Syok, Work, API Keys), so no other provider can answer. The table notes it if another model answered anyway.

## Step 1: install the tools

You only need the tools you want to compare.

| Tool | Install | Log in | Check |
|---|---|---|---|
| Syok Code | this repository (`bun install`), or the one-line installer in the main README | `syok setup`, or set `SYOK_BASE_URL` and `SYOK_API_KEY` | nothing to check |
| Claude Code | see https://code.claude.com/docs/en/setup | `claude auth login` (or set `ANTHROPIC_API_KEY`) | `claude auth status` |
| Codex CLI | `npm install -g @openai/codex` | `codex login` (or set `CODEX_API_KEY`) | `codex login status` |
| Cursor CLI | `curl https://cursor.com/install -fsS \| bash` | `agent login` (or set `CURSOR_API_KEY`) | `agent status` |

You also need `git`, `node` and `python3` for the sample scenarios. The bench checks every tool before it spends anything
and stops if one is missing or not logged in.

### How each tool is run (headless, nobody answering questions)

| Tool | Command the bench runs | Limits the tool enforces | Tokens / cost read from |
|---|---|---|---|
| Syok Code | `syok -p "<task>" --json --mode auto --no-stream --model <m> --cwd <dir> --max-steps <n>` | steps | `usage` in the `--json` result; cost from `bench/prices.json` |
| Claude Code | `claude -p "<task>" --output-format json --model <m> --dangerously-skip-permissions --no-session-persistence --max-turns <n> --max-budget-usd <usd>` | turns, budget | `modelUsage` / `usage` and `total_cost_usd` (Claude Code's own estimate) |
| Codex CLI | `codex exec --json -m <m> --sandbox workspace-write --skip-git-repo-check --ephemeral -C <dir> "<task>"` | none | the last `turn.completed` event's `usage`; cost from `bench/prices.json` |
| Cursor CLI | `agent -p "<task>" --output-format json --model <m> --force --trust --workspace <dir>` | none | not reported by Cursor: shown as **unknown** |

Sources are written at the top of each adapter (`bench/adapters/*.ts`). Anything that could not be confirmed in the
official documentation or source is marked `UNVERIFIED` in the code and printed as a warning when that tool is used. The
bench never guesses a number: what a tool does not report is shown as `unknown`.

`bench/prices.json` holds US dollars per million tokens, used only for tools that do not report a cost. It is empty on purpose:
copy the current prices from each provider's pricing page. Costs worked out this way are marked "(est.)".

## Step 2: check the bench itself (free)

```bash
bun bench/run.ts --check
```
proves each scenario is fair: its existing tests pass at the start, its grader fails before the fix, and passes with the
known fix in `solution/`.

```bash
bun bench/run.ts --dry-run --tools syok,claude,codex,cursor
```
runs the whole pipeline with a **fake tool** that copies the known fix (no AI, no money), and writes the results table.

## Step 3: a small pilot

```bash
bun bench/run.ts --tools syok,claude --lane claude --model <a Claude model name>
```
One run per tool per scenario. When you are happy, add `--runs 3` (and `--yes` if the bench asks). AI tools give different
results on different tries, so three runs or more are needed before drawing conclusions.

Other options: `--only <id1,id2>` (some scenarios), `--scenarios <folder>`, `--out <folder>` (default `bench/results/`),
`--keep` (keep the project folders to look at them), `--max-spend <usd>`.

## Step 4: read the results

Each run writes `bench/results/<time>/results.json` (everything) and `results.md` (the table), plus each tool's output and
its patch in `logs/`.

| Column | Meaning |
|---|---|
| Passed | The scenario's grader passed. The grader always runs with the **original** protected tests put back, so editing a test never makes a run pass. |
| Regressions | Existing test commands that passed before the tool ran and fail after it. |
| Tests weakened | Protected test files the tool changed or deleted (compared with the starting commit, so commits by the tool count too). |
| Tokens, Cost | As reported by the tool, or "unknown". "(est.)" = worked out from `bench/prices.json`. |
| Time | Wall-clock seconds of the tool's run (not the grading). |
| Human help | Always 0: every run is headless. |

"Clean passes" in the per-tool summary = passed, with no regressions, no protected test changed, and within the time limit.

## Writing a scenario

A folder `bench/scenarios/<id>/` with `scenario.json`:

```json
{
  "id": "my-task",
  "source": { "type": "git", "url": "https://github.com/owner/repo", "commit": "<full 40-character commit>" },
  "prompt": "The task, in the words every tool gets.",
  "limits": { "timeSec": 900, "maxSteps": 60, "maxCostUsd": 2 },
  "setup": "npm ci",
  "tests": [{ "name": "unit tests", "command": "npm test" }],
  "protected": ["test/"],
  "grader": { "command": "npm test", "files": "grader", "timeSec": 300 }
}
```
- `source` is a git repository at a **pinned commit**, or `{ "type": "tarball", "path": "repo.tar.gz" }`, or
  `{ "type": "dir", "path": "repo" }` (a folder inside the scenario).
- `setup` runs once after checkout (its output becomes part of the starting point).
- `tests` must pass at the start; they are run again after the tool to find regressions.
- `protected` paths (files or folders) must not be changed by the tool.
- `grader.files` is a folder copied over the project **after** the tool finished (hidden tests the tool never saw).
- `solution/` (optional) holds a known fix, used by `--check` and by the fake tool.

The three sample scenarios come from `evals/` (a JavaScript bug, a Python parsing bug, and a Python bug packed as a
tarball). They prove the pipeline; the real hard scenarios come later.

## SWE-bench

[SWE-bench](https://www.swebench.com) is a public set of real GitHub issues from Python projects. SWE-bench Verified is 500 of
them checked by people. Each instance has an official Docker image with the project ready at the right commit.

### Get the dataset (as JSONL)

The dataset is published as Parquet. With Python:
```bash
pip install datasets
python -c "import datasets; datasets.load_dataset('SWE-bench/SWE-bench_Verified', split='test').to_json('verified.jsonl')"
```
`SWE-bench/SWE-bench_Verified` (what the official harness uses today) includes each instance's `image` and `eval_script`,
which the quick local grade needs. The classic `princeton-nlp/SWE-bench_Verified` also works: the image name is then built with
the official rule (`swebench/sweb.eval.x86_64.<instance_id with __ written _1776_>:latest`), and only the official harness can
grade it.

### Run

```bash
# check the pipeline with the dataset's own reference fix (no AI, no cost; needs Docker)
bun bench/swebench/run.ts --dataset verified.jsonl --ids psf__requests-1142 --tool gold --grade

# 5 instances picked with a fixed seed, with one tool
bun bench/swebench/run.ts --dataset verified.jsonl --n 5 --seed 42 --tool syok --model <model> --grade
```
- One container per instance, from the instance's official image. `--backend docker` (default) needs Docker running;
  `--backend modal` runs the containers on Modal instead, through Syok Code's own Modal connection (`syok run --on modal`
  setup: `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`).
- The tool is installed inside the container (`containerInstall` in its adapter) and its login is passed in by variable
  **name** (`SYOK_API_KEY`, `ANTHROPIC_API_KEY`, `CODEX_API_KEY`, `CURSOR_API_KEY`, ...). `--skip-install` if your image already
  has the tool. The containers need internet access for the install and the AI calls.
- The patch is everything the tool changed in `/testbed` as a `git diff`, without untracked files that were already in the image.
- Images are big (several GB each), and the official advice is an x86_64 machine with about 120 GB free disk, 16 GB RAM and
  8 CPU cores for a full run.

Output in `bench/swebench/out/<time>-<tool>/`: `predictions.jsonl` (official format: `instance_id`, `model_name_or_path`,
`model_patch`), `report.json` and logs.

### Grade

**The official harness is the only real score.** Install it (`pip install swebench`) and run:
```bash
swebench eval verified -p bench/swebench/out/<run>/predictions.jsonl --run-id <name> -j 4
# older form, same arguments as before:
python -m swebench.harness.run_evaluation --dataset_name SWE-bench/SWE-bench_Verified --predictions_path <file> --max_workers 4 --run_id <name>
```
Results land in `logs/evaluation/<run-id>/`.

`--grade` adds a **quick local grade**: in a fresh container the patch is applied the way the harness applies it, the row's
official `eval_script` runs, and the FAIL_TO_PASS and PASS_TO_PASS tests are read with a simplified copy of the harness's
pytest, Django and SymPy log readers. It is a quick look, not a score: other projects have their own readers in the harness,
so a quick result can differ. `report.json` always says "quick local grade only (NOT the official harness)".
