# plansheet-node

The worker-node client for [plansheet](https://plansheet.io). Install it, log in to your
plansheet, and it provisions and approves a node for you and saves the connection. A runner
then holds a live link to the Ultravisor hub and executes the work plansheet dispatches.

You do not paste tokens or run curl. `login` does the whole handshake, including 2FA.

Plansheet dispatches `{ Capability, Action }` and never knows what the action does. The node
that carries the capability owns the recipe: the command each action runs, and whatever that
command decides. A new action, a new stack or a new environment is configuration (a harness
file or a capability package for the node, and rows in the plan sheet), not plansheet code. The
direction of record is docs/architecture/what-plansheet-owns.md in the plansheet repository,
and docs/architecture/legacy-release-path.md there lists the release code that still breaks
that rule and the step that removes it.

## Install

```
npm install -g plansheet-node
```

Node 18 or newer is required.

## Log in

```
plansheet-node login
```

It asks for your plansheet URL (default `https://plansheet.io`), your email and password,
and, if your account has two-factor on, the six-digit code sent to your email or phone. Then
it asks you to name the node, offering a generated default like `Matchbook-001`. When it is
done the node is provisioned, approved, and saved:

```
Connected.
  Node:        Matchbook-001
  Beacon:      ps.nk-yourbox-1a2b3c4d
  Plansheet:   https://plansheet.io
  Hub:         wss://hub.plansheet.io
  Saved:       /Users/you/.plansheet/nodes/matchbook-001.json
```

The hub URL is learned from plansheet at login (plansheet knows its own hub's public address), so
you do not have to supply it. Pass `--hub` only to override what the server advertises, or when a
plan sheet has not been configured with a public hub URL yet.

Non-interactive flags are available for scripting:

```
plansheet-node login --url https://plansheet.io --email you@example.com --name Matchbook-001
```

(The password and any 2FA code are still prompted for; they are never taken from flags or
the environment.)

## Manage saved nodes

```
plansheet-node list             # show the nodes saved on this machine
plansheet-node logout <name>    # forget a node on this machine
plansheet-node prune            # clean up saved nodes the server no longer recognizes
```

`logout` only removes the local file. To revoke a node on the server, use the plansheet UI
(Nodes, then Revoke).

`prune` is the bulk cleanup. By default it checks each saved node against its plan sheet and
removes only the ones the server no longer recognizes (its plan sheet was rebuilt, its token was
revoked, or the node was retired). A node that is simply offline right now is kept, not pruned.
Like `logout`, it only removes local files; it never revokes anything on the server.

```
plansheet-node prune                                  # remove the ones the server forgot
plansheet-node prune --url https://dev.plansheet.io   # only nodes for this plan sheet
plansheet-node prune --all                            # remove ALL saved nodes, no server check
plansheet-node prune --dry-run                        # show what would go, remove nothing
plansheet-node prune --all --yes                      # no confirmation prompt
```

## Where things are kept

Connections live under `~/.plansheet/nodes/` (override the directory with `PLANSHEET_HOME`),
one file per node, mode 0600. Each file holds the node's own token, which is its hub join
secret. Your account password is never stored, and the account token the login mints to do
the provisioning is used once and discarded, so a saved node file only ever yields a narrowed,
revocable node credential.

## Running a node

```
plansheet-node run                                     # the only saved node
plansheet-node run matchbook-001 --harness harness.query.example.json,harness.assistant.example.json
plansheet-node run matchbook-001 --packages all
```

`run` blocks until Ctrl-C or SIGTERM. When it starts it:

1. learns the hub URL from plansheet (`GET /1.0/Node/Self`) when the saved node has none, and
   saves it;
2. builds one capability from each `--harness` file and each package `--packages` loads, and
   leaves out any this box is not ready for (see Readiness);
3. checks its registration with `GET /1.0/Node/Self`. A registration that is not Active, or has
   no beacon name yet, does not join, and the node prints why;
4. joins the hub under the beacon name plansheet gave it, with the node token as its join
   secret, and advertises its capabilities;
5. reports what it advertises, its version and its hardware to plansheet
   (`POST /1.0/Node/Self/Register`). That makes it a candidate on the Capabilities page and
   shows it on the Nodes page.

| Option | What it does |
|---|---|
| `--harness PATH` | A JSON harness config. Comma-separate several to carry several capabilities at once. |
| `--packages SPEC` | Load capability packages from plansheet with the node token: `all` (also what `--packages` alone means), or a comma-separated list of PackageKeys. Combines with `--harness`. |
| `--hub URL` | Override the hub URL saved at login (or set `ULTRAVISOR_URL`). |
| `--home DIR` | The config directory (or set `PLANSHEET_HOME`; the default is `~/.plansheet`). |
| `--insecure` | Do not verify plansheet's TLS certificate. Local development only. |

When nothing is left to advertise (no `--harness`, no `--packages`, or nothing ready), the node
runs a built-in stub: `plansheet.software` with one action, `RunWorkItem`, which logs the
dispatched work item and exits 0. That is enough to prove the loop end to end.

The node reads its harness files and packages once, at start. Restart it after a change.

Toolchain runs started on the Runs page and Tasks asked on the Ask page reach a node only for an
action someone activated for it: on plansheet's Capabilities page an approver picks the node for
each action, and sets who may start it.

## Harness config

A harness file advertises one capability and says what each of its actions runs. The example
files in this package are working configs: `harness.ops.example.json`,
`harness.deploy.example.json`, `harness.query.example.json` and
`harness.assistant.example.json`. The shape, with an illustrative capability:

```
{
	"_comment": "Notes for people. The node does not read this key.",
	"Capability": "example.reports",
	"MaxOutputBytes": 262144,
	"Actions": {
		"Build": {
			"Description": "Build the report named in the input.",
			"Command": "bash",
			"Args": ["/opt/reports/build.sh", "{Input}"],
			"Cwd": "/opt/reports",
			"Env": { "REPORT_OUT": "/var/reports" },
			"TimeoutMs": 600000
		}
	}
}
```

| Key | What it does |
|---|---|
| `Capability` | The capability this file advertises. The default is `plansheet.software`. |
| `Actions` | One entry per action, keyed by the action name plansheet dispatches. |
| `MaxOutputBytes` | The most stdout, and separately the most stderr, the node keeps from one run. The default is 65536; the rest is dropped. |
| `StripEnv` | Variables removed from every command's environment. The default is `NODE_TOKEN`, `PLANSHEET_NODE_TOKEN` and `NODE_TOKEN_FILE`, the node's own credential. A list you set replaces the default, so keep those three in it. |
| `Resources` | What the box needs before the node advertises this capability. See Readiness. |
| `Provision` | Files the node writes for the actions to run. Packages use it; see Capability packages. |

Each action:

| Key | What it does |
|---|---|
| `Command` | Required. The program to run. It starts directly, not through a shell, so use `bash -c` when you need shell syntax. |
| `Args` | The arguments, as an array, with placeholders filled in. Each element stays one argument, so a value with spaces needs no quoting. |
| `Cwd` | The working directory, with placeholders filled in. The default is the package's provision directory, then the dispatch's staging directory, then the directory the node started in. |
| `Env` | Extra environment variables. They win over the node's environment and the `PLANSHEET_` variables. |
| `TimeoutMs` | How long the command may run. The default is the dispatch's own timeout, then 5 minutes. At the limit the node kills the command's whole process group. |
| `Description` | What the action does. The node advertises it with the action. |

A dispatch can carry one value for the command, `Settings.Input`: the question a person asked
on Ask, for example. The node writes it to the command's stdin and then closes stdin. With no
input, stdin is closed at once, so a command that reads it sees end of file instead of hanging.
The same value is the `{Input}` placeholder.

The placeholders in `Args` and `Cwd` are `{Input}`, `{Action}`, `{IDWorkItem}`,
`{WorkItemNumber}`, `{WorkItemTitle}` (or `{Title}`), `{WorkItemHash}`, `{UnitKey}`, `{Staging}`
and `{Provision}`. One with no value in the dispatch is left as typed, braces included.

The command's environment is the node's own, minus `StripEnv`, plus `PLANSHEET_ACTION`,
`PLANSHEET_WORKITEM_HASH`, `PLANSHEET_IDWORKITEM`, `PLANSHEET_WORKITEM_NUMBER`,
`PLANSHEET_WORKITEM_TITLE`, `PLANSHEET_UNITKEY`, `PLANSHEET_STAGING` and
`PLANSHEET_PROVISION_DIR`, plus the action's `Env`.

Exit 0 is success. A non-zero exit, a signal, a command that fails to start, or the timeout is
a failure.

## Capability packages

`--packages` loads the capability packages of the node's plan sheet with the node token, from
`GET /1.0/CapabilityPackages/Available`: the platform's built-in packages (a copy the plan sheet
adopted replaces the built-in with the same PackageKey), then the plan sheet's own packages. A
package's manifest carries the same keys as a harness file, except `StripEnv`: a package always
runs with the default. Writing a package takes content.approve in plansheet,
because it decides what every node started with `--packages` runs.

A manifest can carry a `Provision` block, `{ "Files": [ { "Path": "run.sh", "Content": "...",
"Mode": "0755" } ] }`: the implementation its actions run, shipped with the manifest. The node
writes the files to `<home>/provision/<package-slug>-<version>/`, runs the action's `Command`
from there by default, and passes the directory as `PLANSHEET_PROVISION_DIR` and `{Provision}`.
Each `Path` must be relative and stay inside that directory, or the capability is not
advertised. The node reuses the directory while the files are unchanged and rewrites it when
they change; a new version gets a new directory.

## Readiness

`Resources`, in a harness file or a package, says what the box needs. The node advertises the
capability only when the box meets all of it. Otherwise it logs
`not advertising <capability> -- unmet: <reasons>` and leaves the capability out, so plansheet
never offers this node for work it cannot do.

```
"Resources": {
	"Hardware": { "MinRAMMB": 32768, "GPU": true, "MinVRAMMB": 24000, "MinDiskMB": 50000 },
	"Requires": [
		{ "Kind": "sql-connection", "Label": "read-only database" },
		{ "Kind": "model", "Label": "ollama", "Command": "ollama" }
	]
}
```

`Hardware` is checked against what the node measures at start, in MB: total RAM, the GPU and its
VRAM (from nvidia-smi, or three quarters of unified memory on Apple Silicon), and free disk where
the node was started. A value the node could not measure fails any threshold set against it.

Each `Requires` entry says how to check it. `EnvVar` must be set and not empty, `Command` must be
on PATH (or exist, when it contains a `/`), and `Path` must exist. Every key given must pass. A
`sql-connection` entry that gives none of them checks `PLANSHEET_QUERY_DB_URL`. An entry with
nothing to check fails rather than pass unchecked. Apart from that default, `Kind` and `Label`
only name the requirement in the log line.

The node reports what it measured along with its capabilities, so the Nodes page shows what each
box is.

## Run reporting

A dispatch that carries a RunStep (`Settings.IDRunStep`) belongs to a plansheet run: a toolchain
step, or the run that answers a Task on Ask. The node reports that step to plansheet itself,
with its own token, into the plan sheet that dispatched it (it sends `X-Plansheet-Customer` when
the dispatch names one). A dispatch without a RunStep just runs.

1. Start. The node marks the step Running, and runs the command only after plansheet accepts
   that report (plansheet-node 1.12.0 and later). Any 4xx answer means the work is not this
   node's to run: another node holds the run, the hub delivered it again, or the run was
   stopped. The node then does not run it, and fails it to the hub naming the step and the HTTP
   status. A network error or a 5xx is retried after 1, 2, 4 and 8 seconds, within about 30
   seconds.
2. Progress. Each chunk of stdout becomes the step's StageLabel (its first 120 characters) with
   a new HeartbeatDate. These reports are best effort and never retried.
3. Finish. The node reports the step Succeeded or Failed with its Log, then closes the Run with
   the same status and the last 8,000 characters of the Log as its ResultLog. The close is sent
   only after plansheet accepts the step report. Both are retried like the start report, each
   within its own 30 seconds, and a refused report is logged and not retried.

The Log is a status line (`exit <code>`, and the signal or the error when there is one), then
stdout, then a `--- stderr ---` line and stderr. It keeps only its first 60 KB (61,440
characters), and ends in `...[truncated]` when it is cut, whatever `MaxOutputBytes` says. A
command whose output can run long should print its summary, and any failure, first, and write
its full output to a file on the box.

On Ask, plansheet shows the run's ResultLog, without its leading `exit <code>`, as the answer,
so an answer keeps at most its last 8,000 characters. A conversational Task may print one JSON
object, `{ "Reply": "...", "Metadata": {}, "Attachments": [] }`, instead of plain text.

## License

MIT
