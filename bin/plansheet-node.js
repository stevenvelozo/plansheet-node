#!/usr/bin/env node
'use strict';

/**
 * plansheet-node CLI.
 *
 * Commands:
 *   login     Log in to a plansheet (with 2FA), provision + approve a node for yourself, and save the connection.
 *   list      Show the node connections saved on this machine.
 *   status    Alias for list.
 *   logout    Forget a node connection on this machine (does NOT revoke it server-side; use the plansheet UI).
 *   prune     Clean up saved node configs on this machine: the ones the server no longer recognizes, or all.
 *   run       Start a runner for a saved node (ships in the next update).
 *   help      This message.
 *
 * Secrets (password, 2FA code, tokens) are never echoed or logged.
 *
 * @author Steven Velozo <steven@velozo.com>
 * @license MIT
 */

const libReadline = require('readline');
const libFS = require('fs');
const libPath = require('path');

const libPlansheetClient = require('../source/PlansheetClient.js');
const libClientConfig = require('../source/ClientConfig.js');
const libPrune = require('../source/Prune.js');
const libLoginFlow = require('../source/LoginFlow.js');
const libNodeRunner = require('../source/NodeRunner.js');
const libHarnessCapability = require('../source/HarnessCapability.js');
const libRunReportingCapability = require('../source/RunReportingCapability.js');
const libHardwareProbe = require('../source/HardwareProbe.js');
const libCapabilityReadiness = require('../source/CapabilityReadiness.js');
const libProvisionStore = require('../source/ProvisionStore.js');
const libDefaultHarness = require('../source/DefaultHarness.js');

let _PackageVersion = '0.0.0';
try { _PackageVersion = require('../package.json').version; } catch (pIgnore) { /* version is cosmetic */ }

const DEFAULT_PLANSHEET_URL = 'https://plansheet.io';

const USAGE =
[
	'plansheet-node ' + _PackageVersion,
	'',
	'Usage: plansheet-node <command> [options]',
	'',
	'Commands:',
	'  login     Log in, provision + approve a node for yourself, and save the connection',
	'  list      Show the node connections saved on this machine',
	'  status    Alias for list',
	'  logout    Forget a saved node on this machine (does not revoke it server-side)',
	'  prune     Remove saved nodes the server no longer recognizes (or --all), on this machine',
	'  run       Start a runner for a saved node (blocks; Ctrl-C to stop)',
	'  help      Show this message',
	'',
	'login options:',
	'  --url URL         plansheet server (env PLANSHEET_URL, default ' + DEFAULT_PLANSHEET_URL + ')',
	'  --hub URL         Ultravisor hub URL (optional: learned from plansheet at login; env ULTRAVISOR_URL)',
	'  --email ADDRESS   account email (prompted if omitted)',
	'  --name NAME       node name (a default like Matchbook-001 is offered if omitted)',
	'  --managed-by ID   IDCustomer of the plan sheet that ADMINISTERS the node (default: your session tenant)',
	'  --grant ID[,ID]   IDCustomer(s) the node may ACT in (default: just the managed-by tenant)',
	'  --label TEXT      free-text label for the node',
	'  --home DIR        config directory (env PLANSHEET_HOME, default ~/.plansheet)',
	'  --insecure        do not verify plansheet TLS (dev only)',
	'',
	'prune options:',
	'  plansheet-node prune        remove saved nodes the server no longer recognizes (dev rebuilt,',
	'                              token revoked, node retired); an offline node is kept, not pruned',
	'  --url URL         limit to saved nodes for this plansheet server (e.g. a dev URL you are done with)',
	'  --all             remove ALL matching saved nodes without checking the server',
	'  --dry-run         show what would be removed, remove nothing',
	'  --yes             do not prompt for confirmation (also --force)',
	'  --home DIR        config directory (env PLANSHEET_HOME, default ~/.plansheet)',
	'  --insecure        do not verify plansheet TLS (dev only)',
	'',
	'run options:',
	'  plansheet-node run [name]   run the named node (or the only saved node)',
	'  --hub URL         override the hub URL saved at login (env ULTRAVISOR_URL)',
	'  --harness PATH    JSON harness config for what the node runs (default: a logging stub).',
	'                    Comma-separate several to carry more than one capability at once, e.g.',
	'                    --harness harness.query.example.json,harness.assistant.example.json',
	'  --packages SPEC   load capability packages from plansheet with the node token: "all" for every',
	'                    package this plan sheet offers, or a comma-separated list of PackageKeys.',
	'                    Combines with --harness.',
	'  --home DIR        config directory (env PLANSHEET_HOME, default ~/.plansheet)',
	'  --insecure        do not verify plansheet TLS (dev only)',
	''
].join('\n');

// ----- tiny arg parser -----

function parseArgs(pArgv)
{
	let tmpOut = { _: [] };
	for (let i = 0; i < pArgv.length; i++)
	{
		let tmpArg = pArgv[i];
		if (tmpArg === '--insecure') { tmpOut.insecure = true; }
		else if (tmpArg === '--help' || tmpArg === '-h') { tmpOut.help = true; }
		else if (tmpArg === '--version' || tmpArg === '-v') { tmpOut.version = true; }
		else if (tmpArg.slice(0, 2) === '--')
		{
			let tmpKey = tmpArg.slice(2);
			let tmpValue = pArgv[i + 1];
			if (tmpValue === undefined || tmpValue.slice(0, 2) === '--') { tmpOut[tmpKey] = true; }
			else { tmpOut[tmpKey] = tmpValue; i++; }
		}
		else { tmpOut._.push(tmpArg); }
	}
	return tmpOut;
}

// ----- prompts -----

function prompt(pQuery, pDefault)
{
	return new Promise((fResolve) =>
	{
		let tmpRL = libReadline.createInterface({ input: process.stdin, output: process.stdout });
		let tmpLabel = pQuery + (pDefault ? (' [' + pDefault + ']') : '') + ': ';
		tmpRL.question(tmpLabel, (pValue) =>
		{
			tmpRL.close();
			let tmpTrimmed = String(pValue || '').trim();
			fResolve(tmpTrimmed || pDefault || '');
		});
	});
}

// Read without echoing (no asterisks -- standard terminal password behavior).
function promptHidden(pQuery)
{
	return new Promise((fResolve) =>
	{
		let tmpRL = libReadline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
		let tmpMuted = false;
		tmpRL._writeToOutput = function (pString) { if (!tmpMuted) { tmpRL.output.write(pString); } };
		tmpRL.question(pQuery + ': ', (pValue) =>
		{
			tmpRL.output.write('\n');
			tmpRL.close();
			fResolve(String(pValue || ''));
		});
		tmpMuted = true;
	});
}

// ----- commands -----

async function commandLogin(pArgs)
{
	let tmpURL = pArgs.url || process.env.PLANSHEET_URL || '';
	if (!tmpURL) { tmpURL = await prompt('Plansheet URL', DEFAULT_PLANSHEET_URL); }

	if (pArgs.insecure)
	{
		// Dev only: relax TLS for the global fetch the client uses.
		process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
		console.warn('[plansheet-node] TLS verification disabled (--insecure); use for local development only.');
	}

	let tmpEmail = pArgs.email || await prompt('Email');
	if (!tmpEmail) { throw new Error('An email is required.'); }
	let tmpPassword = await promptHidden('Password');
	if (!tmpPassword) { throw new Error('A password is required.'); }

	let tmpHubURL = pArgs.hub || process.env.ULTRAVISOR_URL || process.env.PLANSHEET_HUB_URL || '';

	let tmpClient = new libPlansheetClient({ BaseURL: tmpURL });
	let tmpConfig = new libClientConfig({ Home: pArgs.home || process.env.PLANSHEET_HOME });
	let tmpFlow = new libLoginFlow(
	{
		Client: tmpClient,
		Config: tmpConfig,
		Prompts:
		{
			notify: (pMessage) => console.log('[plansheet-node] ' + pMessage),
			code: async (pChallenge, pPreviousError) =>
			{
				let tmpHint = pPreviousError ? (pPreviousError.message + ' ') : '';
				return await prompt(tmpHint + 'Enter the 6-digit code');
			},
			nodeName: async (pDefault) => await prompt('Name this node', pDefault)
		}
	});

	// Ownerless-node scope (WI #506): target the managed-by tenant and grant set explicitly, so a deploy
	// node lands in customer 1 (where the deploy toolchains live) no matter which plan sheet the CLI account
	// defaults to. Both optional; omitted, the server defaults managed-by to the session tenant.
	let tmpManagedBy = parseInt(pArgs['managed-by'], 10) || 0;
	let tmpGrant = (typeof pArgs.grant === 'string')
		? pArgs.grant.split(',').map((pV) => parseInt(pV, 10)).filter((pN) => pN > 0)
		: undefined;

	let tmpResult = await tmpFlow.run(
	{
		PlansheetURL: tmpURL,
		HubURL: tmpHubURL,
		UserName: tmpEmail,
		Password: tmpPassword,
		NodeName: pArgs.name,
		Label: pArgs.label,
		IDManagedCustomer: tmpManagedBy || undefined,
		Plansheets: tmpGrant
	});

	console.log('');
	console.log('Connected.');
	console.log('  Node:        ' + tmpResult.NodeName);
	console.log('  Beacon:      ' + tmpResult.BeaconName);
	console.log('  Plansheet:   ' + tmpResult.PlansheetURL);
	console.log('  Hub:         ' + (tmpResult.HubURL || '(not advertised by plansheet -- pass --hub or ULTRAVISOR_URL when running)'));
	console.log('  Saved:       ' + tmpResult.ConfigPath);
	console.log('');
	console.log('Next: plansheet-node run ' + libClientConfig.slug(tmpResult.NodeName));
}

function commandList(pArgs)
{
	let tmpConfig = new libClientConfig({ Home: pArgs.home || process.env.PLANSHEET_HOME });
	let tmpNodes = tmpConfig.listNodes();
	if (!tmpNodes.length)
	{
		console.log('No nodes saved on this machine. Run: plansheet-node login');
		return;
	}
	console.log('Saved nodes (' + tmpConfig.nodesDir + '):');
	console.log('');
	for (let i = 0; i < tmpNodes.length; i++)
	{
		let tmpNode = tmpNodes[i];
		console.log('  ' + (tmpNode.NodeName || tmpNode.Slug));
		console.log('    beacon:    ' + (tmpNode.BeaconName || '(none)'));
		console.log('    plansheet: ' + (tmpNode.PlansheetURL || '(none)'));
		console.log('    hub:       ' + (tmpNode.HubURL || '(not set)'));
		console.log('    saved:     ' + (tmpNode.SavedAt || '(unknown)'));
		console.log('');
	}
}

async function commandLogout(pArgs)
{
	let tmpTarget = pArgs._[1];
	if (!tmpTarget) { throw new Error('Usage: plansheet-node logout <node-name>'); }
	let tmpConfig = new libClientConfig({ Home: pArgs.home || process.env.PLANSHEET_HOME });
	let tmpRemoved = tmpConfig.removeNode(tmpTarget);
	if (tmpRemoved)
	{
		console.log('Forgot ' + tmpTarget + ' on this machine.');
		console.log('Note: this did not revoke the node on the server. To revoke it, use the plansheet UI (Nodes -> Revoke).');
	}
	else { console.log('No saved node matched "' + tmpTarget + '".'); }
}

// prune: the "docker prune" for saved node configs on this machine. By default it probes each saved node's plan
// sheet and removes only the ones the server no longer recognizes (dev rebuilt, token revoked, node retired) --
// a node that is merely offline, or whose server erred, is kept. --all skips the probe and removes everything in
// the selection; --url narrows the selection to one plansheet. This only ever removes the LOCAL config, never
// revokes anything server-side (that is the plansheet UI's job). --dry-run shows the plan; --yes/--force skips
// the prompt.
async function commandPrune(pArgs)
{
	if (pArgs.insecure)
	{
		process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
		console.warn('[plansheet-node] TLS verification disabled (--insecure); use for local development only.');
	}

	let tmpConfig = new libClientConfig({ Home: pArgs.home || process.env.PLANSHEET_HOME });
	let tmpURL = (typeof pArgs.url === 'string') ? pArgs.url : '';
	let tmpAll = !!pArgs.all;
	let tmpDryRun = !!pArgs['dry-run'];
	let tmpAssumeYes = !!(pArgs.yes || pArgs.force);

	let tmpSelected = libPrune.selectNodes(tmpConfig.listNodes(), tmpURL);
	if (!tmpSelected.length)
	{
		console.log('No saved nodes' + (tmpURL ? (' for ' + libPrune.normalizeURL(tmpURL)) : '') + ' on this machine.');
		return;
	}

	let tmpToRemove = [];
	if (tmpAll)
	{
		tmpToRemove = tmpSelected.slice();
	}
	else
	{
		// Probe each node's plan sheet; remove only the ones the server has forgotten. Offline / erroring nodes
		// are kept, so a node that is simply not reachable right now never loses its only local token.
		console.log('Checking ' + tmpSelected.length + ' saved node(s) against their plan sheet...');
		let tmpKeptUnreachable = 0;
		for (let i = 0; i < tmpSelected.length; i++)
		{
			let tmpNode = tmpSelected[i];
			let tmpProbe;
			try
			{
				let tmpClient = new libPlansheetClient({ BaseURL: tmpNode.PlansheetURL });
				let tmpResult = await tmpClient.probeNodeSelf({ Bearer: tmpNode.NodeToken });
				tmpProbe = { Reachable: true, StatusCode: tmpResult.StatusCode };
			}
			catch (pError) { tmpProbe = { Reachable: false }; }
			let tmpVerdict = libPrune.classifyProbe(tmpProbe);
			let tmpLabel = tmpNode.NodeName || tmpNode.Slug || '(node)';
			if (tmpVerdict.Remove) { tmpToRemove.push(tmpNode); console.log('  dead      ' + tmpLabel + '  (' + tmpNode.PlansheetURL + ')'); }
			else if (tmpVerdict.State === 'alive') { console.log('  live      ' + tmpLabel + '  (kept)'); }
			else if (tmpVerdict.State === 'unreachable') { tmpKeptUnreachable++; console.log('  offline   ' + tmpLabel + '  (unreachable, kept)'); }
			else { console.log('  error     ' + tmpLabel + '  (server did not answer cleanly, kept)'); }
		}
		if (tmpKeptUnreachable) { console.log('Kept ' + tmpKeptUnreachable + ' unreachable node(s): offline right now is not the same as forgotten by the server.'); }
	}

	if (!tmpToRemove.length) { console.log('Nothing to prune.'); return; }

	console.log('');
	console.log((tmpDryRun ? 'Would remove ' : 'About to remove ') + tmpToRemove.length + ' node(s) from this machine:');
	tmpToRemove.forEach((pNode) => console.log('  ' + (pNode.NodeName || pNode.Slug || '(node)') + '  (' + (pNode.PlansheetURL || '') + ')'));
	console.log('This removes the local config only; it does not revoke the node on the server.');

	if (tmpDryRun) { console.log('Dry run: nothing was removed.'); return; }

	if (!tmpAssumeYes)
	{
		let tmpAnswer = await prompt('Remove these ' + tmpToRemove.length + ' node(s)? [y/N]');
		if (!/^y(es)?$/i.test(String(tmpAnswer || '').trim())) { console.log('Aborted. Nothing was removed.'); return; }
	}

	let tmpRemoved = 0;
	for (let i = 0; i < tmpToRemove.length; i++)
	{
		if (tmpConfig.removeNode(tmpToRemove[i].Slug || tmpToRemove[i].NodeName)) { tmpRemoved++; }
	}
	console.log('Pruned ' + tmpRemoved + ' node(s) from this machine.');
}

// Resolve which saved node to run: an explicit name/slug, or the only saved node if there is exactly one.
function resolveNode(pConfig, pTarget)
{
	if (pTarget)
	{
		let tmpNode = pConfig.loadNode(pTarget);
		if (!tmpNode) { throw new Error('No saved node matched "' + pTarget + '". Run: plansheet-node list'); }
		return tmpNode;
	}
	let tmpNodes = pConfig.listNodes();
	if (tmpNodes.length === 0) { throw new Error('No nodes saved on this machine. Run: plansheet-node login'); }
	if (tmpNodes.length > 1)
	{
		throw new Error('Several nodes are saved; name one: ' + tmpNodes.map((pN) => pN.Slug || pN.NodeName).join(', '));
	}
	return tmpNodes[0];
}

function loadHarnessConfig(pPath)
{
	if (!pPath) { return libDefaultHarness(); }
	let tmpResolved = libPath.resolve(pPath);
	let tmpText;
	try { tmpText = libFS.readFileSync(tmpResolved, 'utf8'); }
	catch (pError) { throw new Error('Could not read harness config ' + tmpResolved + ' (' + pError.message + ').'); }
	try { return JSON.parse(tmpText); }
	catch (pIgnore) { throw new Error('Harness config ' + tmpResolved + ' is not valid JSON.'); }
}

async function commandRun(pArgs)
{
	if (pArgs.insecure)
	{
		process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
		console.warn('[plansheet-node] TLS verification disabled (--insecure); use for local development only.');
	}

	let tmpConfig = new libClientConfig({ Home: pArgs.home || process.env.PLANSHEET_HOME });
	let tmpNode = resolveNode(tmpConfig, pArgs._[1]);
	// --hub / ULTRAVISOR_URL override the saved hub; otherwise use what login saved. An empty value here is not
	// fatal yet: a node saved before plansheet advertised its hub URL self-heals below by asking the server.
	let tmpHubURL = pArgs.hub || process.env.ULTRAVISOR_URL || tmpNode.HubURL || '';

	// One node can carry several capabilities: pass --harness a comma-separated list of configs (e.g.
	// harness.query.example.json,harness.assistant.example.json) and each becomes its own capability provider,
	// so a single runner answers plansheet.query AND plansheet.assistant at once. An empty list is the default
	// logging stub. Each provider is wrapped in the reporting interface so a dispatched unit that carries a
	// RunStep reports its lifecycle (Running, progress, terminal + log) back to plansheet and closes the Run --
	// which is what puts the action's output into the workflow view. Plain units pass through.
	// A node's capabilities come from two sources, and can be combined:
	//   --harness a,b,c        local JSON configs (dev), each becoming a capability
	//   --packages all|k1,k2   capability packages fetched from Plansheet with the node token (managed centrally)
	// Each becomes its own provider, so one runner can answer several capabilities at once. With neither flag the
	// default logging stub runs. Every provider is wrapped in the reporting interface so a dispatched unit that
	// carries a RunStep reports its lifecycle back to plansheet and closes the Run; plain units pass through.
	let tmpHarnessPaths = String(pArgs.harness || '').split(',').map((pPath) => pPath.trim()).filter(Boolean);
	let tmpPackageSpec = (pArgs.packages === true) ? 'all' : String(pArgs.packages || '').trim();
	let tmpReportingClient = new libPlansheetClient({ BaseURL: tmpNode.PlansheetURL });

	// Self-heal a node saved before plansheet advertised its hub URL (or re-provisioned): learn it from
	// GET /1.0/Node/Self and persist it, so the operator never has to pass --hub. An explicit --hub /
	// ULTRAVISOR_URL already won above and is treated as a transient override, so it is not persisted here.
	if (!tmpHubURL)
	{
		try
		{
			let tmpSelf = await tmpReportingClient.nodeSelf({ Bearer: tmpNode.NodeToken });
			let tmpLearned = String((tmpSelf && tmpSelf.HubURL) || '').trim();
			if (tmpLearned)
			{
				tmpHubURL = tmpLearned;
				console.log('[plansheet-node]   hub URL learned from plansheet: ' + tmpHubURL);
				try { tmpNode.HubURL = tmpHubURL; tmpConfig.saveNode(tmpNode); } catch (pSaveIgnore) { /* best-effort persist */ }
			}
		}
		catch (pSelfIgnore) { /* fall through to the error below */ }
	}
	if (!tmpHubURL) { throw new Error('No hub URL for this node. Pass --hub or set ULTRAVISOR_URL, or ensure the plan sheet advertises its hub URL.'); }

	let tmpProviders = [];
	let tmpCapabilityLabels = [];
	let tmpAdvertised = [];

	// Probe the box once, and build the readiness context the advertise gate reads. A capability whose package
	// declares Resources (hardware or prerequisites) is advertised ONLY when this box satisfies them, so a weak or
	// unconfigured node never becomes an F153 activation candidate for work it cannot do (V51 F155, WI-513).
	let tmpHardware = libHardwareProbe.probe();
	let fCommandExists = (pCommand) =>
	{
		let tmpCommand = String(pCommand || '');
		if (!tmpCommand) { return false; }
		if (tmpCommand.indexOf('/') >= 0) { try { return libFS.existsSync(tmpCommand); } catch (pIgnore) { return false; } }
		return String(process.env.PATH || '').split(libPath.delimiter).some((pDir) =>
		{
			try { return !!pDir && libFS.existsSync(libPath.join(pDir, tmpCommand)); } catch (pIgnore) { return false; }
		});
	};
	let tmpReadinessContext = {
		Probe: tmpHardware,
		Env: process.env,
		FileExists: (pPath) => { try { return libFS.existsSync(pPath); } catch (pIgnore) { return false; } },
		CommandExists: fCommandExists
	};
	let tmpProvisionStore = new libProvisionStore({ Home: tmpConfig.home, Log: console });
	let fAddHarness = (pConfig) =>
	{
		let tmpReady = libCapabilityReadiness.evaluate(pConfig.Resources || null, tmpReadinessContext);
		if (!tmpReady.Ready)
		{
			console.warn('[plansheet-node]   not advertising ' + (pConfig.Capability || '(capability)') + ' -- unmet: ' + tmpReady.Unmet.join('; '));
			return;
		}
		// A self-contained package ships its implementation in a Provision block; materialize it to a per-package
		// dir the Action Command runs from, so the node pulls the CODE with the manifest -- no second install. Only
		// after readiness passes, so an un-advertisable capability never writes files. A provision failure (e.g. an
		// unsafe path) refuses the capability rather than running a half-written one.
		if (pConfig.Provision)
		{
			try { pConfig.ProvisionDir = tmpProvisionStore.materialize(pConfig.PackageKey || pConfig.Capability, pConfig.Version, pConfig.Provision); }
			catch (pProvErr) { console.warn('[plansheet-node]   not advertising ' + (pConfig.Capability || '(capability)') + ' -- provision failed: ' + pProvErr.message); return; }
		}
		pConfig.Log = console;
		let tmpHarness = new libHarnessCapability(pConfig);
		tmpProviders.push(new libRunReportingCapability({ Inner: tmpHarness, Client: tmpReportingClient, NodeToken: tmpNode.NodeToken, Log: console }));
		tmpCapabilityLabels.push(tmpHarness.Capability + ' [' + Object.keys(tmpHarness.actions).join(', ') + ']');
		tmpAdvertised.push({ Capability: tmpHarness.Capability, Actions: Object.keys(tmpHarness.actions) });
	};

	for (let i = 0; i < tmpHarnessPaths.length; i++) { fAddHarness(loadHarnessConfig(tmpHarnessPaths[i])); }

	if (tmpPackageSpec)
	{
		// Fetch this plan sheet's capability packages with the node token; build one provider per manifest.
		// --packages all loads every Available package; --packages k1,k2 loads only those PackageKeys.
		let tmpPackages = await tmpReportingClient.capabilityPackages({ Bearer: tmpNode.NodeToken });
		if (tmpPackageSpec !== 'all')
		{
			let tmpWanted = {};
			tmpPackageSpec.split(',').map((pKey) => pKey.trim()).filter(Boolean).forEach((pKey) => { tmpWanted[pKey] = true; });
			tmpPackages = tmpPackages.filter((pPackage) => tmpWanted[pPackage.PackageKey]);
		}
		tmpPackages.forEach((pPackage) =>
		{
			let tmpManifest = pPackage.Manifest || {};
			fAddHarness({ Capability: tmpManifest.Capability || pPackage.Capability, Actions: tmpManifest.Actions || {}, MaxOutputBytes: tmpManifest.MaxOutputBytes, Resources: tmpManifest.Resources, Provision: tmpManifest.Provision, PackageKey: pPackage.PackageKey, Version: pPackage.Version });
		});
		console.log('[plansheet-node]   loaded ' + tmpPackages.length + ' capability package(s) from plansheet');
	}

	// Neither flag gave a working provider (no --harness, or --packages returned none): fall back to the stub so
	// the node still joins and logs, rather than starting with nothing to answer.
	if (!tmpProviders.length) { fAddHarness(loadHarnessConfig(null)); }

	let tmpRunner = new libNodeRunner(
	{
		PlansheetURL: tmpNode.PlansheetURL,
		NodeToken: tmpNode.NodeToken,
		HubURL: tmpHubURL,
		Providers: tmpProviders,
		Log: console
	});

	console.log('[plansheet-node] Starting node "' + (tmpNode.NodeName || tmpNode.Slug) + '"');
	console.log('[plansheet-node]   plansheet: ' + tmpNode.PlansheetURL);
	console.log('[plansheet-node]   hub:       ' + tmpHubURL);
	console.log('[plansheet-node]   capabilities: ' + tmpCapabilityLabels.join('; '));

	let tmpResult = await tmpRunner.start();
	if (!tmpResult.Started)
	{
		console.error('[plansheet-node] Did not join: ' + tmpResult.Reason);
		return 2;
	}
	// Report this node to plansheet as one acknowledged step BEFORE we idle: what it advertises to the hub
	// (Capabilities) and its running client version (Version), through the Self/Register handshake. This is what
	// makes the node a candidate on the Capabilities screen and shows its build on the Nodes screen (V51, F153).
	// Awaited here rather than fired after "Waiting for work", so it cannot lose a race with the process going idle;
	// still best-effort, so a plansheet hiccup logs but never stops the node from taking work.
	try
	{
		await tmpReportingClient.registerSelf({ Capabilities: tmpAdvertised, Version: _PackageVersion, Hardware: tmpHardware }, { Bearer: tmpNode.NodeToken });
		console.log('[plansheet-node] Reported ' + tmpAdvertised.length + ' capabilit' + (tmpAdvertised.length === 1 ? 'y' : 'ies') + ' and version ' + _PackageVersion + ' to plansheet.');
	}
	catch (pReportError) { console.warn('[plansheet-node]   (could not report to plansheet: ' + (pReportError && pReportError.message) + ')'); }

	console.log('[plansheet-node] Connected as ' + tmpResult.BeaconName + '. Waiting for work. Press Ctrl-C to stop.');

	// Hold the process open until a signal; the beacon's heartbeat keeps the event loop live on its own.
	let tmpShutting = false;
	let fShutdown = (pSignal) =>
	{
		if (tmpShutting) { return; }
		tmpShutting = true;
		console.log('\n[plansheet-node] caught ' + pSignal + ', disconnecting...');
		tmpRunner.stop(() => process.exit(0));
		setTimeout(() => process.exit(0), 5000).unref();
	};
	process.on('SIGINT', () => fShutdown('SIGINT'));
	process.on('SIGTERM', () => fShutdown('SIGTERM'));

	// Never resolve: run() blocks until a signal calls process.exit above.
	return await new Promise(() => {});
}

// ----- main -----

async function main()
{
	let tmpArgs = parseArgs(process.argv.slice(2));
	if (tmpArgs.version) { console.log(_PackageVersion); return 0; }
	let tmpCommand = tmpArgs._[0] || (tmpArgs.help ? 'help' : '');

	if (!tmpCommand || tmpCommand === 'help' || tmpArgs.help) { console.log(USAGE); return 0; }

	switch (tmpCommand)
	{
		case 'login': await commandLogin(tmpArgs); return 0;
		case 'list':
		case 'status': commandList(tmpArgs); return 0;
		case 'logout': await commandLogout(tmpArgs); return 0;
		case 'prune': await commandPrune(tmpArgs); return 0;
		case 'run': return await commandRun(tmpArgs);
		default:
			console.error('Unknown command: ' + tmpCommand);
			console.error(USAGE);
			return 1;
	}
}

main().then((pCode) => { process.exit(pCode || 0); }).catch((pError) =>
{
	console.error('[plansheet-node] ' + (pError && pError.message ? pError.message : 'failed'));
	process.exit(1);
});
