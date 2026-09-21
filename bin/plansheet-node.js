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
const libLoginFlow = require('../source/LoginFlow.js');
const libNodeRunner = require('../source/NodeRunner.js');
const libHarnessCapability = require('../source/HarnessCapability.js');
const libRunReportingCapability = require('../source/RunReportingCapability.js');
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
	'  run       Start a runner for a saved node (blocks; Ctrl-C to stop)',
	'  help      Show this message',
	'',
	'login options:',
	'  --url URL         plansheet server (env PLANSHEET_URL, default ' + DEFAULT_PLANSHEET_URL + ')',
	'  --hub URL         Ultravisor hub URL the runner will connect to (env ULTRAVISOR_URL)',
	'  --email ADDRESS   account email (prompted if omitted)',
	'  --name NAME       node name (a default like Matchbook-001 is offered if omitted)',
	'  --label TEXT      free-text label for the node',
	'  --home DIR        config directory (env PLANSHEET_HOME, default ~/.plansheet)',
	'  --insecure        do not verify plansheet TLS (dev only)',
	'',
	'run options:',
	'  plansheet-node run [name]   run the named node (or the only saved node)',
	'  --hub URL         override the hub URL saved at login (env ULTRAVISOR_URL)',
	'  --harness PATH    JSON harness config for what the node runs (default: a logging stub)',
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

	let tmpResult = await tmpFlow.run(
	{
		PlansheetURL: tmpURL,
		HubURL: tmpHubURL,
		UserName: tmpEmail,
		Password: tmpPassword,
		NodeName: pArgs.name,
		Label: pArgs.label
	});

	console.log('');
	console.log('Connected.');
	console.log('  Node:        ' + tmpResult.NodeName);
	console.log('  Beacon:      ' + tmpResult.BeaconName);
	console.log('  Plansheet:   ' + tmpResult.PlansheetURL);
	console.log('  Hub:         ' + (tmpResult.HubURL || '(not set -- pass --hub or ULTRAVISOR_URL before running)'));
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
	let tmpHubURL = pArgs.hub || process.env.ULTRAVISOR_URL || tmpNode.HubURL || '';
	if (!tmpHubURL) { throw new Error('No hub URL for this node. Pass --hub or set ULTRAVISOR_URL.'); }

	let tmpHarnessConfig = loadHarnessConfig(pArgs.harness);
	tmpHarnessConfig.Log = console;
	let tmpHarness = new libHarnessCapability(tmpHarnessConfig);

	// Wrap the harness in the reporting interface: when a dispatched unit carries a RunStep, the node reports the
	// step's lifecycle (Running, progress, terminal + log) back to plansheet with its own token, and closes the
	// Run -- which is what puts the action's output into the plansheet workflow view. Plain units pass through.
	let tmpReportingClient = new libPlansheetClient({ BaseURL: tmpNode.PlansheetURL });
	let tmpProvider = new libRunReportingCapability({ Inner: tmpHarness, Client: tmpReportingClient, NodeToken: tmpNode.NodeToken, Log: console });

	let tmpRunner = new libNodeRunner(
	{
		PlansheetURL: tmpNode.PlansheetURL,
		NodeToken: tmpNode.NodeToken,
		HubURL: tmpHubURL,
		Harness: tmpProvider,
		Log: console
	});

	console.log('[plansheet-node] Starting node "' + (tmpNode.NodeName || tmpNode.Slug) + '"');
	console.log('[plansheet-node]   plansheet: ' + tmpNode.PlansheetURL);
	console.log('[plansheet-node]   hub:       ' + tmpHubURL);
	console.log('[plansheet-node]   capability: ' + tmpHarness.Capability + ' [' + Object.keys(tmpHarness.actions).join(', ') + ']');

	let tmpResult = await tmpRunner.start();
	if (!tmpResult.Started)
	{
		console.error('[plansheet-node] Did not join: ' + tmpResult.Reason);
		return 2;
	}
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
