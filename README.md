# plansheet-node

The worker-node client for [plansheet](https://plansheet.io). Install it, log in to your
plansheet, and it provisions and approves a node for you and saves the connection. A runner
then holds a live link to the Ultravisor hub and executes the work plansheet dispatches.

You do not paste tokens or run curl. `login` does the whole handshake, including 2FA.

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
  Beacon:      ps.23.nk-yourbox-1a2b3c4d
  Plansheet:   https://plansheet.io
  Hub:         wss://hub.plansheet.io
  Saved:       /Users/you/.plansheet/nodes/matchbook-001.json
```

Non-interactive flags are available for scripting:

```
plansheet-node login --url https://plansheet.io --email you@example.com --name Matchbook-001 --hub wss://hub.plansheet.io
```

(The password and any 2FA code are still prompted for; they are never taken from flags or
the environment.)

## Manage saved nodes

```
plansheet-node list             # show the nodes saved on this machine
plansheet-node logout <name>    # forget a node on this machine
```

`logout` only removes the local file. To revoke a node on the server, use the plansheet UI
(Nodes, then Revoke).

## Where things are kept

Connections live under `~/.plansheet/nodes/` (override the directory with `PLANSHEET_HOME`),
one file per node, mode 0600. Each file holds the node's own token, which is its hub join
secret. Your account password is never stored, and the account token the login mints to do
the provisioning is used once and discarded, so a saved node file only ever yields a narrowed,
revocable node credential.

## Running a node

`plansheet-node run <name>` starts the runner. It is landing in the next update; today `login`
already gives you a fully provisioned, approved, saved connection.

## License

MIT
