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
- **Syok Code routes between providers, and `--model` does not pin it.** Syok Code sends tool-calling requests. For those
  the Syok router sends each provider its own model and ignores the model name, except that `syok-coder` puts the
  code-strong providers first (syok-ai-router `src/tools.ts` `routeToolChat` and `src/smartrouting.ts` `taskFromModel`,
  checked 23 Nov 2026). The one-provider header `X-Syok-Lock` is refused for tool requests, and when every provider fails,
  Syok's built-in free model answers. So for a fair test the Syok account behind the key must have only the one provider
  connected. Either way the bench records which `<provider> / <model>` answered each run (from Syok Code's `--json`
  `usage.by`) and every `(switched provider: a -> b)` note, and the table shows them.

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
| Claude Code | `claude -p "<task>" --output-format json --model <m> --dangerously-skip-permissions --no-session-persistence --max-turns <n> --max-budget-usd <usd>` (in a SWE-bench container also `--bare`, run as a non-root user; with `--no-web` also `--disallowedTools WebSearch WebFetch`) | turns, budget | `modelUsage` / `usage` and `total_cost_usd` (Claude Code's own estimate) |
| Codex CLI | `codex exec --json -m <m> --sandbox workspace-write --skip-git-repo-check --ephemeral -C <dir> "<task>"` | none | the last `turn.completed` event's `usage`; cost from `bench/prices.json` |
| Cursor CLI | `agent -p "<task>" --output-format json --model <m> --force --trust --workspace <dir>` | none | not reported by Cursor: shown as **unknown** |

Sources are written at the top of each adapter (`bench/adapters/*.ts`). Anything that could not be confirmed in the
official documentation or source is marked `UNVERIFIED` in the code and printed as a warning when that tool is used. The
bench never guesses a number: what a tool does not report is shown as `unknown`.

`bench/prices.json` holds US dollars per million tokens, used only for tools that do not report a cost. Only prices checked
on the provider's own pricing page go in (today: `claude-sonnet-5`, checked 23 Nov 2026; the source is written next to it).
Costs worked out this way are marked "(est.)".

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
- The patch is everything the tool changed in `/testbed`: the difference between a snapshot taken just before the tool starts
  and one taken after it stops (git trees written through a separate index, so the repository itself is not touched). Edits the
  image had already made to tracked files (the sphinx images change `tox.ini` during setup) and untracked files already in the
  image stay out of the patch; `imageChangedFiles` in results.json records how many files already differed from the dataset's
  base commit before the tool ran. A tool's own bookkeeping folder (its adapter's `patchExclude`: `.syok/` for Syok Code,
  where it saves each chat) is never put in the patch, so predictions hold only code changes and no chat transcripts.
- Images are big (several GB each), and the official advice is an x86_64 machine with about 120 GB free disk, 16 GB RAM and
  8 CPU cores for a full run.

Output in `bench/swebench/out/<time>-<tool>/`: `predictions.jsonl` (official format: `instance_id`, `model_name_or_path`,
`model_patch`), `report.json` and logs.

Each run folder also has `results.json` (everything, plus the money used and any early stop; `report.json` is the same file)
and `results.md` (the table). `--max-steps <n>` stops Syok Code or Claude Code after n steps. Money: before starting, the
worst case (`--cost-per-instance` times the instances) must be within `--max-spend`; while running, no new instance starts
once the money used reaches `--max-spend`. Syok Code reports tokens but no money amount, so unless `bench/prices.json` has a
price for every model that answered, the money used is "unknown" and only the time limit and `--max-steps` bound the run.
Outcomes: `resolved`, `wrong-patch` (applied, tests fail), `did-not-apply`, `no-patch`, `timeout`, `error`.

### In the cloud (GitHub Actions): the pilot workflow

Actions > "bench pilot (SWE-bench Verified)" > Run workflow. It runs on GitHub's Ubuntu machine with Docker, so nothing runs
on your computer. Inputs: `tool` (`gold`, `noop`, `syok`, `syok-direct`, `claude`, or a comma list such as `gold,noop`),
`n` (default 5, fixed seed 42) or `ids`, `runs` (how many times each paid lane runs, default 1), `model` (the `syok` lane
only), `max_spend_usd` (default 5, for all paid runs together), `cost_per_instance_usd`, `max_steps`, `timeout_sec`,
`official`. The inputs, the secrets each lane needs and the money plan are checked first (`bun bench/swebench/lane.ts check`);
then every lane and run is its own job, and a last job writes one summary table. For
`syok` it builds Syok Code from the commit being run and puts that build in the containers (`SYOK_BENCH_BUNDLE`), with the
repository secrets `SYOK_BASE_URL` and `SYOK_API_KEY` (the address is hidden in the logs; `bench/swebench/scrub.ts` removes
the key and the address from every file and checks that none is left before the summary is written and the files are
uploaded, and deletes the files if one is). `bench/swebench/summary.ts` writes the summary: per instance, the official
harness result next to the quick grade, with any disagreement marked (the official result is the one to report).
After the quick grade it grades the same predictions with the official harness (`pip install swebench==5.0.2`,
`swebench eval verified`). The job summary shows both; the artifact holds `predictions.jsonl`, `results.json`, `results.md`,
the official report and all logs. The pilot's instances were fixed before any run in `bench/swebench/pilot-ids.txt`.

### The same-model lane: Claude Code vs Syok Code on claude-sonnet-5 (beginner guide)

**What it answers.** Both tools use the very same model, `claude-sonnet-5`, on the very same SWE-bench Verified instances,
with the very same limits. The only difference is the harness (the instructions and tools around the model), so the
result says which harness gets more out of the same model.

**How the fair lane works**, step by step, for each instance:

1. GitHub starts a fresh copy of the instance's official SWE-bench container (one job per tool and run, so the runs never
   share anything and none hits GitHub's 6-hour job limit).
2. The tool gets the same task text (`promptFor` in `bench/swebench/dataset.ts`), the same step/turn cap (`max_steps`,
   default 40: Syok Code's `--max-steps`, Claude Code's `--max-turns`), the same time limit (`timeout_sec`, default 1200 s)
   and **no web** (Syok Code `--no-web`; Claude Code `--disallowedTools WebSearch WebFetch`).
3. **Claude Code** (`tool: claude`): Claude Code refuses `--dangerously-skip-permissions` when it runs as root, and SWE-bench
   containers run as root. So the bench makes a normal user (`syokbench`) in the container, installs Claude Code for that
   user with the official installer (`curl -fsSL https://claude.ai/install.sh | bash -s stable`), gives `/testbed` to that user
   only while Claude Code runs, and gives it back before the patch is taken. Claude Code runs in `--bare` mode (nothing from
   the image changes it: no hooks, plugins, MCP servers or CLAUDE.md) and logs in with `ANTHROPIC_API_KEY` only. Its
   background model and subagent model are pinned to the same model (`ANTHROPIC_DEFAULT_HAIKU_MODEL`,
   `CLAUDE_CODE_SUBAGENT_MODEL`), and it does not update itself during the run (`DISABLE_AUTOUPDATER=1`).
4. **Syok Code direct** (`tool: syok-direct`): Syok Code built from the commit being run, talking straight to Anthropic
   (`SYOK_BASE_URL=https://api.anthropic.com`, `SYOK_API_KEY` = your Anthropic key, for that job only). No Syok router is
   involved, so no other provider can answer. (The plain `syok` lane still goes through your router with its own secrets.)
5. After each instance the bench checks **which model answered**: Claude Code's `modelUsage`, Syok Code's `usage.by`. Any
   answer from a model other than `claude-sonnet-5` is marked **OTHER MODEL ANSWERED** in the tables; when a tool names no
   model at all, the row says "not confirmed" (never assumed to be fine).
6. The quick grade and then the **official SWE-bench harness** grade the patch. The official result is the one to report.

**What you must set (once).**

1. An Anthropic API key: https://platform.claude.com > API keys > Create key. Give that key's workspace a **spend limit**
   there (Limits) that you are happy to lose; this is your real safety net, on top of the bench's own cap.
2. In this repository on GitHub: Settings > Secrets and variables > Actions > New repository secret. Name
   `ANTHROPIC_API_KEY`, value: the key. The workflow passes it into the container by **name** only, GitHub hides it in the
   logs, and `bench/swebench/scrub.ts` removes it from every file before anything is uploaded. Without this secret the
   workflow refuses to start the `claude` and `syok-direct` lanes and says so; nothing is spent.
3. Run it: Actions > "bench pilot (SWE-bench Verified)" > Run workflow, with `tool` = `claude,syok-direct`, `runs` = `3`,
   `n` = `5` (or the pre-registered `ids`), and money inputs that cover the plan (next paragraph).

**Money.** Before anything starts, the plan's worst case must be within `max_spend_usd`:
`instances x cost_per_instance_usd x runs x paid lanes`. For 5 instances, 3 runs and both lanes at $3 per instance that is
5 x 3 x 3 x 2 = **$90**, so set `max_spend_usd` to 90 (or lower `cost_per_instance_usd`, `n` or `runs`). Each of the 6 jobs
may then spend at most its equal share ($15), and stops starting new instances once it has. **Expected cost (a rough
estimate from token arithmetic, not a measurement):** an instance of up to 40 steps sends roughly 0.5 to 1.5 million input
tokens in total. Syok Code direct pays the full $2 per million for all of them (about $1 to $3 per instance plus output at
$10 per million); Claude Code pays mostly the cache-read price of $0.20 per million (well under $1 per instance). So the full
5 x 3 x 2 pilot is likely in the $20 to $50 range. Prices: `bench/prices.json` (Claude Sonnet 5: $2 in, $10 out, cache reads
$0.20, cache writes $2.50 (5 minutes) / $4 (1 hour) per million tokens; checked on the official pricing page 23 Nov 2026).

**Reading the summary.** The last job writes one table with a row per lane and run and an "all runs" row per lane:
official resolved / n, quick grade, steps or turns, tokens in / out (Claude Code's cache reads shown separately; they are
part of "in"), the models that answered, the same-model check, the tool version, tool time and cost. Claude Code's cost is
**its own estimate** (`total_cost_usd`, worked out on your machine from its price table, not the bill); Syok Code direct's
cost is its tokens times `bench/prices.json`. AI runs differ from try to try, so compare all three runs, not one.

**Known unfairness (read before quoting a result).**

- **Prompt caching.** Claude Code talks to Anthropic's own Messages API and uses prompt caching, so most of its input is
  billed at the cache-read price. Syok Code direct goes through Anthropic's OpenAI-compatible endpoint, where prompt caching
  is not supported (docs: platform.claude.com/docs/en/api/openai-sdk), so all of its input is billed at the full price. This
  makes Syok Code look **more expensive** for the same work; it does not change which model answers or the resolved count.
- **The endpoint itself.** On that OpenAI-compatible endpoint some request fields are ignored (for example `strict` on tool
  schemas), and it has no extended features of the native API. Claude Code uses the native API.
- **User rights.** Claude Code runs as a normal user, Syok Code as root (as SWE-bench containers do). Claude Code can change
  everything in `/testbed` and its home folder, but not files owned by root elsewhere (for example it cannot `pip install`
  into the image's Python environment). SWE-bench fixes are code changes in `/testbed`, so this should rarely matter.
- **Cost figures** come from two different methods (Claude Code's own estimate vs. tokens x price list); neither is the bill.
  Your Anthropic Console usage page is the bill.
- **Syok Code direct must name the model.** Syok Code learns which provider and model answered from the Syok router's reply
  headers. Talking straight to Anthropic there are no such headers, so unless Syok Code reads the model from the reply
  itself, its rows say "not confirmed" and its cost is the tokens priced as `claude-sonnet-5`, marked "model not reported".

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
