# DSH root-chat pool (opt-in stdio MCP)

Status: **implemented and verified in a temporary standard stdio MCP on Windows; not installed or host-loaded on every machine.** In that temporary MCP, one real root completed two approved-cwd DSH tasks in the same instance/runtime with fresh sessions, and two real registered DSH instances (`alpha`/`bravo`) overlapped for 22.388 s with distinct tasks and three native reads each. Independent synthetic roots were exercised only through actual mock stdio. This remains an additional opt-in service; it does not replace `dsh-opencode-go`, named DSH instances, WorkBuddy/HY4 registrations, schedules or runtimes. Per-machine registration and host reload still need separate acceptance.

## Selection after opt-in

After the manual registration below and a supported host restart, this machine's literal user selection **“使用 DSH”** (or an equivalent DSH selection) chooses the pooled service. No special “根池” phrase, instance name, root UUID, lease or task ID is typed by the user. An explicit named legacy service (for example `dsh-opencode-go-alpha`) still selects that legacy service; a machine without this registration keeps the old DSH path; a task already running keeps its original backend.

Sol runs the helper from its own host shell. `CODEX_THREAD_ID` is not assumed to reach stdio; the helper must be executed in the host shell where the thread ID is real. When the pool MCP is visible, Sol uses:

```powershell
$entry = codex mcp get dsh-root-pool --json | ConvertFrom-Json
$cfg = $entry.transport.args[[Array]::IndexOf($entry.transport.args, '--config') + 1]
& $entry.transport.command (Join-Path (Split-Path -Parent $entry.transport.args[0]) 'cli.mjs') context --config $cfg
```

Only `transport.command/args` are read; do not print full config/env. Pass only the returned opaque `context_ref` to the MCP. A context reference is routing context, not authentication.

## Actual files and manual registration (non-overwriting)

Installed repo example: `C:\Users\YOUR_USER\ai_rule` (use the real installation path).

1. Copy `config/root-pool.example.json` to a private local file such as
   `C:\Users\YOUR_USER\ai_rule-state\root-pool.local.json`; replace every absolute
   path. `hy4_manifest` and `fallback_authorization_ref` are optional and must both be
   absent or both present. Set `workspace_root` to the approved directory for task cwd validation.
2. Add this MCP service to the existing user Codex configuration **without deleting or
   rewriting** the four current registrations (`dsh-opencode-go`, WorkBuddy entries,
   `hy4-workbuddy` or others). Back up the file first.

```toml
[mcp_servers.dsh-root-pool]
command = "C:\\Program Files\\nodejs\\node.exe"
args = [
  "C:\\Users\\YOUR_USER\\ai_rule\\bridges\\pool\\server.mjs",
  "--config",
  "C:\\Users\\YOUR_USER\\ai_rule-state\\root-pool.local.json"
]
startup_timeout_sec = 20
tool_timeout_sec = 3700
```

`tool_timeout_sec = 3700` is the standard example. Use the host-supported timeout. Existing standalone and named services retain their routes.

Do not add a `--root`, `--child` or `--lease` argument. Do not add a network/web listener.
Restart through the host's supported MCP reload flow only when no task is active. If this
machine previously installed an older pool entry, inspect it before merging; do not run two
pool servers against different configuration for the same root.

Ordinary DSH defaults to `workspace-write` within the approved workspace and host boundaries. Pass `permissionMode: "read-only"` to restrict a task. Set `allow_write: false` in the local config or register `--read-only` to enforce read-only for this server. Older `--allow-write` arguments are still accepted.

HY4 retains its own explicit capability. For HY4 file edits, supply `permissionMode: "workspace-write"`, `capability: "workspace-write"`, a real `authorizationNote`, and `writeScopes` or exact `writes`. The normalized scope belongs to the request fingerprint. Commands require local manifest enablement and exact task authorization. See [CodeBuddy ACP](codebuddy-acp.md).

## Tool surface

| Tool | Effect |
|---|---|
| `get_pool_status` | Read-only pool counts, effective schedule and this root's worker bindings. |
| `set_pool_schedule` | Store `scheduleMode` for the verified root and apply it to that root's running DSH workers. |
| `start_pool_task` | Validate and reserve capacity, then return a durable local task ID or a WorkBuddy DSF handoff in mode 2 at peak. |
| `run_pool_task` | Same submission path. Waits for local work and returns a WorkBuddy handoff immediately. |
| `get_workbuddy_dsf_dispatch`, `claim_workbuddy_dsf_dispatch`, `finish_workbuddy_dsf_dispatch` | Inspect the handoff, claim it once at peak, and record the verified external outcome. Each takes the verified root context. |
| `get_pool_task` | Reads by durable idempotency key; a direct task ID is accepted only when mapped to the same root by its routing decision. |
| `wait_pool_task` | Event-driven wait up to 60 s on an accepted task. No resubmission. |
| `cancel_pool_task` | Cancels only the backend child owned by this live stdio server and only for this context root. A non-owner gets a read-only snapshot. |

No `rootId`, `lease`, `generation`, `ordinal`, `requestedBackend` or direct model API argument exists. When a result is returned, leases, raw context paths, runtime paths, PIDs and receipt paths are stripped.

## Trusted host chain and context

The helper is exactly:

```powershell
node C:\Users\YOUR_USER\ai_rule\bridges\pool\cli.mjs context --config C:\Users\YOUR_USER\ai_rule-state\root-pool.local.json
```

It reads `CODEX_HOME/sessions` and the caller's real `CODEX_THREAD_ID`, follows only the
first `session_meta` line of each exact rollout file, and walks the parent chain to the true
root chat. The root must carry a known host origin (`source: "vscode"` or
`originator: "codex_work_desktop"`); a missing/ambiguous/cyclic root, malformed subagent
parent metadata, or unknown source fails closed. The metadata reader is capped at 256 KiB and
never loads later log lines or prompt text.
It emits only `{ "context_ref": "...", "expires_at": "..." }`; the UUID and child ID stay in
a private file under `context_dir` (default: sibling of `pool_root`, disjoint from the pool
state and workspace).

The MCP server receives the opaque reference, checks its shape, regular-file/private-directory
boundary, age (short-lived, default 5 minutes), and then **re-resolves the host parent chain
again from the file's child ID**. It compares the root; a stale/edited file is rejected. A
newly issued context can be used for a short wait/get after an older one expires.

This is routing context. It is not identity authentication, does not protect against another
process running as the same OS account, and does not add OS isolation. If a host does not pass
`CODEX_THREAD_ID` into Sol's shell, the helper fails; there is no guessed root and no stdio
identity assumption.

`resolve` remains as a read-only diagnostic. `verify-context` checks age/chain without
mutation. Neither prints a lease.

## Binding and admission invariants

- `pool_root` and all runtime paths are absolute normalized real paths. Symlink/junction
  escapes are rejected. Every root directory contains `dsh/`, `hy4/` and `routing/`.
- The primary DSH instance retains its original name and `dsh/` runtime. Extra workers use private `workers/<number>/dsh/` directories with stable suffixed instance names. Routing and HY4 data are shared within the root.
- A binding remains lazy and idle bindings retain their data without starting a child.
- One coordinator can submit multiple independent tasks in parallel under one context. Each worker keeps one child. `binding_cap` optionally limits bound roots. `running_cap` defaults to **3** across roots and pool processes, including active, starting and unknown workers.
- Local DSH and HY4 dispatch and settlement require the original binding handle and unique operation proof. For a WorkBuddy handoff, the pool releases the local reservation before Sol claims the external dispatch with the verified root context.
- Reserve before submit. Only after the backend returns an actual task ID is the binding
  marked active with the backend. A classified pre-admission rejection releases the
  reservation; an unstructured/unknown failure is pinned `unknown`. Unknown/starting is
  never recycled automatically.
- The root tracks request identity across its workers. Terminal replay returns the existing receipt. Changing task arguments or scopes with the same key returns a conflict.
- A separate task needs a new key. A continuation uses its original `sessionId`, worker and cwd. If that worker is occupied, wait for it. Get, wait and cancel resolve the original task and worker. A client without process ownership can observe its receipt.
- `finish` is accepted only for the exact admitted task, live operation and active binding.
  A proved terminal from another owner does not authorize this process to mutate the pool.
- Idle TTL uses task-use timestamps only. Status/get do not refresh or create a binding.
  Reaping releases the ordinal and invalidates generation/lease; the preserved runtime
  remains readable by the same root. Old roots' directories are not deleted by the pool.
- If the backend manager reports `disconnected`/`unknown`, the bridge returns unknown once
  and preserves the pin; it does not tight-loop or guess a substitute task.

## DSH-first and pre-admission HY4

The same routing coordinator and decision files are used by MCP and the one-shot compatibility
wrapper. The original DSH-first policy applies in mode 3. HY4 is possible only when all of these hold: this is a new
task (no `sessionId`, continuation or repair); a supported DSH pre-admission rejection is
structurally `not_accepted`; local authorization exists; the HY4 route is ready; and a
supported capability was explicitly selected. The attempt is at most once. No fallback is
allowed after acceptance, unknown/timeout/disconnect, permission/approval/parameter failure,
invalid input, busy/lock, or for continuation/repair. The selected backend is then fixed.

`schedule_config` defines the calendar. New roots use mode 1 without a calendar. Use `set_pool_schedule` with the root context and `scheduleMode`. Mode 2 uses local DSH in offpeak and lets Sol claim the selected WorkBuddy DSF handoff at peak. Mode 3 applies the original gate and optional authorized HY4 route. Legacy `enabled: false` and `enabled: true` select modes 1 and 3. The choice persists across connections and idle bindings. Mode 2 and mode 3 apply the pre-peak gate, budget check and hard stop to DSH. Owners recheck the current choice before stopping a task. A stopped task stays terminal. See [peak scheduling](offpeak-schedule.md).

The pool reads existing schema 1 and 2 binding stores, primary worker receipts and replay proofs. It writes schema 3 when binding or schedule state changes. Upgrade processes that share a pool after their active work completes.

## Tests and limits

`tests/pool.test.mjs` covers strict handles, cap/TTL/unknown, host chain and the one-shot
wrapper. `tests/pool-mcp.test.mjs` drives the actual stdio MCP subprocess with mock DSH,
fake ACP, synthetic `CODEX_HOME`, injected deterministic clocks and bounded child shutdown:
replay/continuation, root isolation, peak rejection, HY4 fallback, non-owner cancellation,
and normalized `writeScopes` reaching the HY4 file fallback. Mode 2 tests connect the real stdio schedulers to a separate offline WorkBuddy fixture and record its actual tool results. All 113 earlier isolated mocks passed
with 0 skips, including opt-in native command fakes. These mocks still do not prove a real
CodeBuddy provider, billing, desktop app, global registration, multi-chat host behavior, OS
account isolation or authentication. The temporary real stdio checks above supplement but do
not replace per-machine host installation/reload acceptance. Commands remain optional,
manifest-gated and individually authorized; vendor auto-allow does not prove every command
passes an ACP permission callback.
