'use strict';

/**
 * RunReportingCapability -- the reporting interface, as a decorator around any capability provider.
 *
 * The generic harness runs a command and knows nothing about plansheet. This wraps it so that when the dispatched
 * unit carries a RunStep reference (Settings.IDRunStep, and usually Settings.IDRun), the node reports the step's
 * lifecycle back to plansheet over REST as it runs: Running at the start, StageLabel/HeartbeatDate as the harness
 * reports progress, then Succeeded or Failed with the captured Log, and it closes the Run. This is what puts a
 * hub-dispatched action's output into the plansheet workflow view. The hub does not relay Outputs/Log; the node
 * writes them straight onto the RunStep with its own token (RunStep writes are gated by tenant auth, not node
 * ownership).
 *
 * Reporting is best-effort: a failed report is logged and never fails the work. A unit with no IDRunStep passes
 * straight through, so the same node serves both Run-backed and plain dispatches.
 *
 * @author Steven Velozo <steven@velozo.com>
 * @license MIT
 */

const MAX_LOG_BYTES = 60 * 1024;

function nowISO() { return new Date().toISOString(); }

class RunReportingCapability
{
	// pConfig: { Inner (the wrapped provider), Client (PlansheetClient), NodeToken, Log? }
	constructor(pConfig)
	{
		let tmpConfig = pConfig || {};
		if (!tmpConfig.Inner) { throw new Error('RunReportingCapability: an Inner provider is required.'); }
		if (!tmpConfig.Client) { throw new Error('RunReportingCapability: a Client is required.'); }
		this._Inner = tmpConfig.Inner;
		this._Client = tmpConfig.Client;
		this._NodeToken = tmpConfig.NodeToken || '';
		this._Log = tmpConfig.Log || console;
		this.Name = 'RunReporting(' + (this._Inner.Name || 'provider') + ')';
	}

	// Advertising is the inner provider's; this decorator changes execution, not what the node offers.
	get Capability() { return this._Inner.Capability; }
	get actions() { return this._Inner.actions; }
	getCapabilities() { return (typeof this._Inner.getCapabilities === 'function') ? this._Inner.getCapabilities() : [ this._Inner.Capability ]; }
	initialize(fCallback) { return (typeof this._Inner.initialize === 'function') ? this._Inner.initialize(fCallback) : (fCallback ? fCallback(null) : null); }
	shutdown(fCallback) { return (typeof this._Inner.shutdown === 'function') ? this._Inner.shutdown(fCallback) : (fCallback ? fCallback(null) : null); }

	execute(pAction, pWorkItem, pContext, fCallback, fReportProgress)
	{
		let tmpSettings = (pWorkItem && pWorkItem.Settings) || {};
		let tmpIDRunStep = parseInt(tmpSettings.IDRunStep, 10);
		let tmpIDRun = parseInt(tmpSettings.IDRun, 10);

		// Not a Run-backed unit: run it plainly, no reporting.
		if (!(tmpIDRunStep > 0))
		{
			return this._Inner.execute(pAction, pWorkItem, pContext, fCallback, fReportProgress);
		}

		// The plan sheet this Run belongs to (dispatch stamps it into Settings). A node authorized for many plan
		// sheets sends it as X-Plansheet-Customer so the report lands in the dispatching tenant; a single-tenant
		// node has no IDCustomer here and reports into its home plan sheet.
		let tmpIDCustomer = parseInt(tmpSettings.IDCustomer, 10);
		let tmpAuth = { Bearer: this._NodeToken };
		if (tmpIDCustomer > 0) { tmpAuth.Customer = tmpIDCustomer; }

		// Mark the step Running (fire and forget; the work does not wait on it).
		this._report(() => this._Client.putRunStep(tmpIDRunStep,
			{ Status: 'Running', StartedDate: nowISO(), HeartbeatDate: nowISO(), StageLabel: 'running ' + pAction, Log: 'Dispatched to node; running.' }, tmpAuth));

		// Fold harness progress into the step's live-progress channel (StageLabel/HeartbeatDate, no status change),
		// and still pass it to the beacon's own progress channel.
		let fWrappedProgress = (pProgress) =>
		{
			let tmpStage = (pProgress && (pProgress.Message || pProgress.Stage)) ? String(pProgress.Message || pProgress.Stage).replace(/\s+/g, ' ').trim().slice(0, 120) : '';
			this._report(() => this._Client.putRunStep(tmpIDRunStep,
				{ HeartbeatDate: nowISO(), StageLabel: tmpStage || ('running ' + pAction) }, tmpAuth));
			if (typeof fReportProgress === 'function') { try { fReportProgress(pProgress); } catch (pIgnore) { /* beacon progress is best-effort */ } }
		};

		let fInnerCallback = (pError, pResult) =>
		{
			let tmpLog = this._composeLog(pError, pResult);
			let tmpStatus = pError ? 'Failed' : 'Succeeded';
			let fFinish = () => fCallback(pError, pResult);
			// Report the terminal step + close the run, then hand to the beacon regardless of reporting outcome.
			Promise.resolve()
				.then(() => this._Client.putRunStep(tmpIDRunStep, { Status: tmpStatus, FinishedDate: nowISO(), Log: tmpLog }, tmpAuth))
				.then(() => (tmpIDRun > 0) ? this._Client.putRun(tmpIDRun, { Status: tmpStatus, FinishedDate: nowISO(), ResultLog: tmpLog.slice(-8000) }, tmpAuth) : null)
				.catch((pReportError) => { (this._Log.warn || this._Log.log || (() => {}))('[run-report] could not report RunStep ' + tmpIDRunStep + ': ' + pReportError.message); })
				.then(fFinish, fFinish);
		};

		return this._Inner.execute(pAction, pWorkItem, pContext, fInnerCallback, fWrappedProgress);
	}

	// A human-readable Log for the step from the harness result or error. Caps the size so a chatty command does
	// not blow up the RunStep row.
	_composeLog(pError, pResult)
	{
		let tmpParts = [];
		let tmpOutputs = (pResult && pResult.Outputs) || (pError && pError.Result && pError.Result.Outputs) || {};
		if (tmpOutputs.ExitCode !== undefined && tmpOutputs.ExitCode !== null) { tmpParts.push('exit ' + tmpOutputs.ExitCode); }
		if (tmpOutputs.Signal) { tmpParts.push('signal ' + tmpOutputs.Signal); }
		if (pError) { tmpParts.push('ERROR: ' + pError.message); }
		let tmpHead = tmpParts.join('  ');
		let tmpBody = '';
		if (tmpOutputs.Stdout) { tmpBody += tmpOutputs.Stdout; }
		if (tmpOutputs.Stderr) { tmpBody += (tmpBody ? '\n--- stderr ---\n' : '') + tmpOutputs.Stderr; }
		let tmpLog = (tmpHead ? (tmpHead + '\n') : '') + tmpBody;
		if (tmpLog.length > MAX_LOG_BYTES) { tmpLog = tmpLog.slice(0, MAX_LOG_BYTES) + '\n...[truncated]'; }
		return tmpLog || (pError ? ('ERROR: ' + pError.message) : 'done');
	}

	// Best-effort fire-and-forget report; never throws into the work path.
	_report(fThunk)
	{
		try
		{
			let tmpPromise = fThunk();
			if (tmpPromise && typeof tmpPromise.catch === 'function')
			{
				tmpPromise.catch((pError) => { (this._Log.warn || this._Log.log || (() => {}))('[run-report] ' + pError.message); });
			}
		}
		catch (pError) { (this._Log.warn || this._Log.log || (() => {}))('[run-report] ' + pError.message); }
	}
}

module.exports = RunReportingCapability;
