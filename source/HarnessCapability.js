'use strict';

/**
 * HarnessCapability -- the configurable work handler a plansheet node runs.
 *
 * A node is a HARNESS, not a hardcoded executor. It advertises one capability (e.g. plansheet.software) and, for
 * each action the hub can dispatch (RunWorkItem and friends), runs a command a HUMAN configured. The command is
 * what actually does the work; the harness just gives it the dispatched work item's context and reports the
 * outcome. The Actions config is the knob for "what this node does" -- point it at a stub, an agent, or Claude
 * without changing this file.
 *
 * Config: { Capability, Actions: { <ActionName>: { Command, Args?, Cwd?, Env?, TimeoutMs?, Description? } }, MaxOutputBytes?, StripEnv? }.
 * The executor receives the work item as environment (PLANSHEET_IDWORKITEM, PLANSHEET_WORKITEM_NUMBER,
 * PLANSHEET_WORKITEM_TITLE, PLANSHEET_WORKITEM_HASH, PLANSHEET_ACTION, PLANSHEET_UNITKEY, PLANSHEET_STAGING) plus
 * any configured Env, and {Placeholder} substitution in Args from the same fields. A Task-backed dispatch also
 * carries one runtime input (Settings.Input -- a user's question, a filled prompt shape, a SQL query): it is
 * written to the command's stdin and available as the {Input} placeholder in Args. Exit 0 is success; anything
 * else (or a spawn error or a timeout) is a failure the hub records and plansheet re-drives.
 *
 * @author Steven Velozo <steven@velozo.com>
 * @license MIT
 */

const libChildProcess = require('child_process');
const libCapabilityProviderBase = require('ultravisor-beacon').CapabilityProvider;

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
// A default execution ceiling so a hung executor (e.g. one blocked reading stdin) cannot pin the node's work
// slot forever when neither the action nor the work item sets a timeout. Real RunWorkItem dispatches carry their
// own (6h); this is only the floor for a dispatch that sets none.
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
// The node's own credential env vars, stripped from the executor's environment: a semi-trusted executor (an
// agent, later Claude) gets work-item DATA, never the beacon's identity token to re-authenticate with.
const DEFAULT_STRIP_ENV = [ 'NODE_TOKEN', 'PLANSHEET_NODE_TOKEN', 'NODE_TOKEN_FILE' ];

class HarnessCapability extends libCapabilityProviderBase
{
	constructor(pConfig)
	{
		super(pConfig || {});
		let tmpConfig = pConfig || {};
		this.Name = 'PlansheetHarness';
		this.Capability = String(tmpConfig.Capability || 'plansheet.software');
		// { <ActionName>: { Command (required), Args?, Cwd?, Env?, TimeoutMs?, Description? } }
		this._Actions = (tmpConfig.Actions && typeof tmpConfig.Actions === 'object') ? tmpConfig.Actions : {};
		this._MaxOutputBytes = (Number.isFinite(tmpConfig.MaxOutputBytes) && tmpConfig.MaxOutputBytes > 0)
			? tmpConfig.MaxOutputBytes : DEFAULT_MAX_OUTPUT_BYTES;
		this._Log = tmpConfig.Log || console;
		// Env vars withheld from every executor. Defaults to the node's own credential; an operator can extend it.
		this._StripEnv = Array.isArray(tmpConfig.StripEnv) ? tmpConfig.StripEnv : DEFAULT_STRIP_ENV;
		// Test seam: a spawn(command, args, options) -> ChildProcess-like. Defaults to child_process.spawn.
		this._Spawn = (typeof tmpConfig.Spawn === 'function') ? tmpConfig.Spawn : libChildProcess.spawn;
	}

	get actions()
	{
		let tmpOut = {};
		Object.keys(this._Actions).forEach((pName) =>
		{
			tmpOut[pName] = { Description: this._Actions[pName].Description || ('Runs the configured executor for ' + pName + '.') };
		});
		return tmpOut;
	}

	/**
	 * Run the configured executor for pAction against the dispatched work item.
	 *
	 * @param {string}   pAction
	 * @param {object}   pWorkItem  { WorkItemHash, Capability, Action, Settings, TimeoutMs, OperationHash }
	 * @param {object}   pContext   { StagingPath }
	 * @param {function} fCallback  function(pError, pResult) -- pResult = { Outputs, Log }
	 * @param {function} [fReportProgress]
	 */
	execute(pAction, pWorkItem, pContext, fCallback, fReportProgress)
	{
		let tmpActionConfig = this._Actions[pAction];
		if (!tmpActionConfig || !tmpActionConfig.Command)
		{
			return fCallback(new Error('HarnessCapability: no executor configured for action "' + pAction + '".'));
		}

		let tmpWorkItem = pWorkItem || {};
		let tmpSettings = tmpWorkItem.Settings || {};
		let tmpContext = pContext || {};
		// The user's assembled input for a Task-backed dispatch (a question, a filled prompt shape, a SQL
		// query), delivered on the command's stdin below and available as the {Input} placeholder in Args.
		// This is the one deliberate runtime value a dispatch carries; empty for ordinary ops dispatches.
		let tmpInput = (tmpSettings.Input !== undefined && tmpSettings.Input !== null) ? String(tmpSettings.Input) : '';

		let tmpBaseEnv =
		{
			PLANSHEET_WORKITEM_HASH: String(tmpWorkItem.WorkItemHash || ''),
			PLANSHEET_ACTION: String(pAction),
			PLANSHEET_IDWORKITEM: String(tmpSettings.IDWorkItem || ''),
			PLANSHEET_WORKITEM_NUMBER: String(tmpSettings.WorkItemNumber || ''),
			PLANSHEET_WORKITEM_TITLE: String(tmpSettings.Title || ''),
			PLANSHEET_UNITKEY: String(tmpSettings.UnitKey || ''),
			PLANSHEET_STAGING: String(tmpContext.StagingPath || '')
		};
		// Inherit the node's environment so the executor has a working PATH/HOME and any tool auth the operator
		// set deliberately, but STRIP the node's own hub/plansheet credential first: the executor gets work-item
		// DATA, never the beacon's identity token, or a semi-trusted executor (an agent, later Claude) could
		// re-authenticate to the hub or the plansheet API as this node.
		let tmpInherited = Object.assign({}, process.env);
		for (let i = 0; i < this._StripEnv.length; i++) { delete tmpInherited[this._StripEnv[i]]; }
		let tmpEnv = Object.assign(tmpInherited, tmpBaseEnv,
			(tmpActionConfig.Env && typeof tmpActionConfig.Env === 'object') ? tmpActionConfig.Env : {});
		// {Placeholder} names the operator can use in Args, mapped to the same values as the env above.
		let tmpSubs =
		{
			IDWorkItem: tmpSettings.IDWorkItem,
			WorkItemNumber: tmpSettings.WorkItemNumber,
			WorkItemTitle: tmpSettings.Title,
			Title: tmpSettings.Title,
			WorkItemHash: tmpWorkItem.WorkItemHash,
			UnitKey: tmpSettings.UnitKey,
			Action: pAction,
			Staging: tmpContext.StagingPath,
			Input: tmpSettings.Input
		};
		let tmpArgs = (Array.isArray(tmpActionConfig.Args) ? tmpActionConfig.Args : [])
			.map((pArg) => this._substitute(String(pArg), tmpSubs));
		let tmpCwd = tmpActionConfig.Cwd || tmpContext.StagingPath || process.cwd();
		// Always bound the run: an unset timeout used to mean no timer, so a command that blocks (e.g. reading
		// stdin) never fired close/error and pinned the work slot forever. Real dispatches carry their own.
		let tmpTimeoutMs = Number(tmpActionConfig.TimeoutMs) || Number(tmpWorkItem.TimeoutMs) || DEFAULT_TIMEOUT_MS;

		let tmpChild;
		// detached:true makes the child a process-group leader so a timeout can kill its whole subprocess tree
		// (git, npm, an agent's tools) instead of orphaning grandchildren while the hub re-drives the work.
		try { tmpChild = this._Spawn(tmpActionConfig.Command, tmpArgs, { cwd: tmpCwd, env: tmpEnv, detached: true }); }
		catch (pError) { return fCallback(new Error('HarnessCapability: failed to spawn "' + tmpActionConfig.Command + '": ' + pError.message)); }
		// The executor gets no interactive stdin: end it so a command that reads stdin sees EOF instead of hanging.
		// Deliver any Task input on stdin (unbounded, no shell quoting), then EOF; a command that wants it as
		// an argument uses the {Input} placeholder instead. No input still ends stdin so a reader sees EOF.
		if (tmpChild.stdin)
		{
			try { if (tmpInput) { tmpChild.stdin.write(tmpInput); } tmpChild.stdin.end(); }
			catch (pIgnore) { /* stdin may already be closed */ }
		}

		let tmpSettled = false;
		let tmpStdout = '';
		let tmpStderr = '';
		let tmpTruncated = false;
		let tmpTimer = null;

		let fAppend = (pField, pChunk) =>
		{
			let tmpText = pChunk.toString('utf8');
			if (pField === 'out')
			{
				if (tmpStdout.length < this._MaxOutputBytes) { tmpStdout += tmpText; }
				if (tmpStdout.length > this._MaxOutputBytes) { tmpStdout = tmpStdout.slice(0, this._MaxOutputBytes); tmpTruncated = true; }
				if (fReportProgress) { try { fReportProgress({ Message: tmpText.slice(0, 500) }); } catch (pIgnore) { /* progress is best-effort */ } }
			}
			else if (tmpStderr.length < this._MaxOutputBytes)
			{
				tmpStderr += tmpText;
				if (tmpStderr.length > this._MaxOutputBytes) { tmpStderr = tmpStderr.slice(0, this._MaxOutputBytes); tmpTruncated = true; }
			}
		};
		if (tmpChild.stdout) { tmpChild.stdout.on('data', (pChunk) => fAppend('out', pChunk)); }
		if (tmpChild.stderr) { tmpChild.stderr.on('data', (pChunk) => fAppend('err', pChunk)); }

		let fFinish = (pError, pCode, pSignal) =>
		{
			if (tmpSettled) { return; }
			tmpSettled = true;
			if (tmpTimer) { clearTimeout(tmpTimer); }
			let tmpResult =
			{
				Outputs: { ExitCode: (pCode === undefined ? null : pCode), Signal: pSignal || null, Stdout: tmpStdout, Stderr: tmpStderr, Truncated: tmpTruncated, IDWorkItem: tmpSettings.IDWorkItem || null },
				Log: []
			};
			if (pError)
			{
				let tmpErr = new Error('HarnessCapability: ' + pAction + ' failed: ' + pError.message);
				tmpErr.Result = tmpResult;
				return fCallback(tmpErr);
			}
			if (pCode === 0) { return fCallback(null, tmpResult); }
			let tmpExitErr = new Error('HarnessCapability: executor for ' + pAction + (pSignal ? (' was killed by ' + pSignal) : (' exited ' + pCode)));
			tmpExitErr.Result = tmpResult;
			return fCallback(tmpExitErr);
		};

		tmpChild.on('error', (pError) => fFinish(pError));
		tmpChild.on('close', (pCode, pSignal) => fFinish(null, pCode, pSignal));
		if (tmpTimeoutMs > 0)
		{
			tmpTimer = setTimeout(() =>
			{
				this._killTree(tmpChild);
				fFinish(new Error('timed out after ' + tmpTimeoutMs + 'ms'));
			}, tmpTimeoutMs);
		}
	}

	// Kill the executor's whole process group. Because the child is spawned detached (its own group leader), a
	// negative pid signals the group, so a wrapper's grandchildren die too. Falls back to the direct child if the
	// group signal is refused (e.g. the child already exited, or on a platform without process groups).
	_killTree(pChild)
	{
		if (!pChild || !pChild.pid) { return; }
		try { process.kill(-pChild.pid, 'SIGKILL'); }
		catch (pIgnore)
		{
			try { pChild.kill('SIGKILL'); } catch (pAlsoIgnore) { /* already gone */ }
		}
	}

	// {Placeholder} substitution in Args from the explicit map built in execute(). Unknown placeholders are left
	// verbatim so a stray brace in a command is not silently blanked.
	_substitute(pStr, pSubs)
	{
		return pStr.replace(/\{(\w+)\}/g, (pWhole, pKey) =>
		{
			return (pSubs[pKey] !== undefined && pSubs[pKey] !== null) ? String(pSubs[pKey]) : pWhole;
		});
	}

	initialize(fCallback)
	{
		(this._Log.info || this._Log.log || console.log)(
			'PlansheetHarness: capability [' + this.Capability + '] with actions [' + Object.keys(this._Actions).join(', ') + '].');
		return fCallback ? fCallback(null) : null;
	}

	shutdown(fCallback)
	{
		return fCallback ? fCallback(null) : null;
	}
}

module.exports = HarnessCapability;
