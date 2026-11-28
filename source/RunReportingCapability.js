'use strict';

/**
 * RunReportingCapability -- the reporting interface, as a decorator around any capability provider.
 *
 * The generic harness runs a command and knows nothing about plansheet. This wraps it so that when the dispatched
 * unit carries a RunStep reference (Settings.IDRunStep, and usually Settings.IDRun), the node reports the step's
 * lifecycle back to plansheet over REST as it runs: Running at the start, StageLabel/HeartbeatDate as the harness
 * reports progress, then Succeeded or Failed with the captured Log, and it closes the Run. This is what puts a
 * hub-dispatched action's output into the plansheet workflow view. The hub does not relay Outputs/Log; the node
 * writes them straight onto the RunStep with its own token, and plansheet takes a node's writes only for a run that
 * node holds, in a plan sheet that node is granted.
 *
 * The start report gates the work: a Run-backed unit runs only after plansheet accepts its Running report. Any 4xx
 * (401, 403, 404, 409 and the rest) means the unit is not this node's to run: the hub handed it to a node that does
 * not hold the run, or delivered it again after its step started, or the run was stopped. The node then does not
 * run it, fails it to the hub with a reason that names the step and the HTTP status, and sends no further report
 * for it, so a Failed report never clobbers the delivery that owns the step. A network error or a 5xx is retried on
 * a short backoff inside a time budget (about 30 s by default); when the retries or the budget run out, the unit is
 * refused the same way.
 *
 * The terminal reports are retried the same way, on the start report's backoff and each inside a budget of its own:
 * first the step's Succeeded or Failed with its Log, then the Run close, which goes out only once plansheet has
 * accepted the step's report. Every attempt sends the same body, and a repeat is safe: plansheet takes the status a
 * row already has as no transition. The node never closes a run before plansheet holds its step's outcome: when the
 * step report never lands, the Run close is not sent, and the run stays open for a person to close. Plansheet's
 * deploy ledger reads that outcome too, the step's stored status and Log, when a hub deploy run closes Succeeded. The
 * ledger is legacy plansheet code that step 5 of plansheet's release cut deletes (WI #626), and this file does not
 * depend on it. A 4xx on a terminal report is final, as on the start report: it is logged and not retried. On the
 * step report a 409 means a person closed the step or its run first (a second Stop fails a running step), or an
 * approver corrected it, and a 403 that another node holds the run; the Run close is not sent then either, since
 * plansheet would refuse it for the same reason.
 *
 * Progress reports are best-effort and never retried. No report ever fails the work: the hub gets the unit's own
 * outcome once the terminal reports are done, whatever became of them. A unit with no IDRunStep passes straight
 * through, so the same node serves both Run-backed and plain dispatches.
 *
 * @author Steven Velozo <steven@velozo.com>
 * @license MIT
 */

const MAX_LOG_BYTES = 60 * 1024;

// The start report's retry schedule, which the terminal step report and the Run close use too. StartReportBackoffMs
// is the wait before each retry of a report that failed with a network error or a 5xx; StartReportBudgetMs bounds one
// report, retries included. A retry that would start after the budget is not tried, and each attempt's request
// deadline is cut to what is left of it, so a report gives up in about 30 s even when plansheet hangs. The step report
// and the Run close each get a budget, so a unit's terminal reports give up within about a minute. Both are
// constructor settings, so tests run fast.
const START_REPORT_BACKOFF_MS = Object.freeze([ 1000, 2000, 4000, 8000 ]);
const START_REPORT_BUDGET_MS = 30000;

function nowISO() { return new Date().toISOString(); }

function wait(pMs) { return new Promise((fResolve) => { setTimeout(fResolve, pMs); }); }

// Whether a failed report is worth another try: no HTTP answer at all (plansheet unreachable, or the request deadline
// passed) or a 5xx. Any other answer, a 4xx above all, is plansheet refusing the report, and it is final.
function isRetryable(pError)
{
	let tmpStatus = Number(pError && pError.StatusCode) || 0;
	if (tmpStatus <= 0) { return true; }
	return (tmpStatus >= 500) && (tmpStatus < 600);
}

// A failed report as it reads in a log line and in the reason the hub records: the HTTP status (or that there was
// none) and the client's message, which carries plansheet's own reason.
function describeFailure(pError)
{
	let tmpStatus = Number(pError && pError.StatusCode) || 0;
	let tmpWhat = (tmpStatus > 0) ? ('HTTP ' + tmpStatus) : 'no HTTP answer';
	let tmpMessage = (pError && pError.message) ? String(pError.message) : '';
	return tmpMessage ? (tmpWhat + ': ' + tmpMessage) : tmpWhat;
}

// Why plansheet did not take a report, as a log line reads it: refused (any answer but a 5xx, which is final), or not
// accepted before the retries or the budget ran out (no HTTP answer, or a 5xx).
function describeNotAccepted(pOutcome)
{
	if (!isRetryable(pOutcome.Error))
	{
		return 'plansheet refused it (' + describeFailure(pOutcome.Error) + '), and a refusal is not retried';
	}
	return 'plansheet did not accept it after ' + pOutcome.Attempts + ' attempt' + ((pOutcome.Attempts === 1) ? '' : 's')
		+ ' (last: ' + describeFailure(pOutcome.Error) + ')';
}

class RunReportingCapability
{
	// pConfig: { Inner (the wrapped provider), Client (PlansheetClient), NodeToken, Log?, StartReportBackoffMs?, StartReportBudgetMs? }
	constructor(pConfig)
	{
		let tmpConfig = pConfig || {};
		if (!tmpConfig.Inner) { throw new Error('RunReportingCapability: an Inner provider is required.'); }
		if (!tmpConfig.Client) { throw new Error('RunReportingCapability: a Client is required.'); }
		this._Inner = tmpConfig.Inner;
		this._Client = tmpConfig.Client;
		this._NodeToken = tmpConfig.NodeToken || '';
		this._Log = tmpConfig.Log || console;
		this._StartReportBackoffMs = Array.isArray(tmpConfig.StartReportBackoffMs)
			? tmpConfig.StartReportBackoffMs.map((pMs) => Math.max(0, Number(pMs) || 0))
			: START_REPORT_BACKOFF_MS.slice();
		this._StartReportBudgetMs = (Number(tmpConfig.StartReportBudgetMs) > 0) ? Number(tmpConfig.StartReportBudgetMs) : START_REPORT_BUDGET_MS;
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
			// One finish for the step and the Run, stamped when the work ended, so every retry sends the same body.
			let tmpFinishedDate = nowISO();
			let fFinish = () => fCallback(pError, pResult);
			// Report the terminal step, then close the run, then hand to the beacon whatever became of the reports.
			this._sendTerminalReports(tmpIDRunStep, tmpIDRun, tmpAuth,
				{ Status: tmpStatus, FinishedDate: tmpFinishedDate, Log: tmpLog },
				{ Status: tmpStatus, FinishedDate: tmpFinishedDate, ResultLog: tmpLog.slice(-8000) })
				.then(fFinish, fFinish);
		};

		// Mark the step Running, and run the unit only once plansheet accepts that. A refused start report fails the
		// unit to the hub, and nothing more is reported for it.
		let tmpStartFields = { Status: 'Running', StartedDate: nowISO(), HeartbeatDate: nowISO(), StageLabel: 'running ' + pAction, Log: 'Dispatched to node; running.' };
		this._sendStartReport(tmpIDRunStep, tmpStartFields, tmpAuth)
			.then((pOutcome) =>
			{
				if (!pOutcome.Accepted)
				{
					let tmpRefusal = this._startRefusal(tmpIDRunStep, pAction, pOutcome);
					this._warn('[run-report] ' + tmpRefusal.message);
					return fCallback(tmpRefusal);
				}
				// A provider that throws instead of calling back still gets its step closed as Failed.
				try { this._Inner.execute(pAction, pWorkItem, pContext, fInnerCallback, fWrappedProgress); }
				catch (pError) { fInnerCallback(pError); }
			})
			.catch((pError) => { this._warn('[run-report] RunStep ' + tmpIDRunStep + ': ' + ((pError && pError.message) ? pError.message : String(pError))); });
	}

	// Send the start report, retrying a network error or a 5xx on the backoff schedule while the budget lasts. Every
	// attempt sends the same body, StartedDate included. Resolves to { Accepted: true, Attempts } once plansheet
	// accepts it, or to { Accepted: false, Attempts, Error } when plansheet refuses it or the retries or the budget
	// run out. It never rejects.
	_sendStartReport(pIDRunStep, pFields, pAuth)
	{
		return this._sendReport('RunStep ' + pIDRunStep + ' start report',
			(pTimeoutMs) => this._Client.putRunStep(pIDRunStep, pFields, pAuth, { TimeoutMs: pTimeoutMs }));
	}

	// Send the terminal step report, then close the Run, each retried like the start report inside a budget of its own.
	// The Run close goes out only once plansheet has accepted the step report, so a run never closes before plansheet
	// holds its step's outcome (see the header). A report plansheet does not take is logged with why, and nothing is
	// sent after it. Resolves once both are done or given up on; it never rejects.
	async _sendTerminalReports(pIDRunStep, pIDRun, pAuth, pStepFields, pRunFields)
	{
		let tmpStep = await this._sendReport('RunStep ' + pIDRunStep + ' ' + pStepFields.Status + ' report',
			(pTimeoutMs) => this._Client.putRunStep(pIDRunStep, pStepFields, pAuth, { TimeoutMs: pTimeoutMs }));
		if (!tmpStep.Accepted)
		{
			let tmpRunNote = '';
			if (pIDRun > 0)
			{
				tmpRunNote = ' The close of Run ' + pIDRun + ' is not sent' + (isRetryable(tmpStep.Error) ? ', so the run stays open.' : '.');
			}
			this._warn('[run-report] could not report RunStep ' + pIDRunStep + ' ' + pStepFields.Status + ': ' + describeNotAccepted(tmpStep) + '.' + tmpRunNote);
			return;
		}
		if (!(pIDRun > 0)) { return; }
		let tmpRun = await this._sendReport('Run ' + pIDRun + ' close report',
			(pTimeoutMs) => this._Client.putRun(pIDRun, pRunFields, pAuth, { TimeoutMs: pTimeoutMs }));
		if (!tmpRun.Accepted)
		{
			this._warn('[run-report] could not close Run ' + pIDRun + ' as ' + pRunFields.Status + ': ' + describeNotAccepted(tmpRun) + '.'
				+ (isRetryable(tmpRun.Error) ? ' The run stays open.' : ''));
		}
	}

	// Send one report, retrying a network error or a 5xx on the backoff schedule while the budget lasts. fSend(pTimeoutMs)
	// sends one attempt with that request deadline, and the same body every time. pWhat names the report in the retry
	// log line. Resolves to { Accepted: true, Attempts } once plansheet accepts it, or to { Accepted: false, Attempts,
	// Error } when plansheet refuses it or the retries or the budget run out. It never rejects.
	async _sendReport(pWhat, fSend)
	{
		let tmpDeadline = Date.now() + this._StartReportBudgetMs;
		let tmpAttempts = 0;
		while (true)
		{
			tmpAttempts++;
			try
			{
				await fSend(Math.max(1, tmpDeadline - Date.now()));
				return { Accepted: true, Attempts: tmpAttempts };
			}
			catch (pError)
			{
				let tmpWaitMs = this._StartReportBackoffMs[tmpAttempts - 1];
				if (!isRetryable(pError) || (tmpWaitMs === undefined) || ((Date.now() + tmpWaitMs) >= tmpDeadline))
				{
					return { Accepted: false, Attempts: tmpAttempts, Error: pError };
				}
				this._warn('[run-report] ' + pWhat + ' failed (' + describeFailure(pError) + '); retrying in ' + tmpWaitMs + ' ms.');
				await wait(tmpWaitMs);
			}
		}
	}

	// The Error a refused unit fails to the hub with. It names the action, the step, and the HTTP status of the last
	// answer (or that there was none), with plansheet's reason.
	_startRefusal(pIDRunStep, pAction, pOutcome)
	{
		let tmpCause = pOutcome.Error;
		let tmpMessage;
		if (isRetryable(tmpCause))
		{
			tmpMessage = 'Not running ' + pAction + ': plansheet did not accept the start report for RunStep ' + pIDRunStep
				+ ' after ' + pOutcome.Attempts + ' attempt' + ((pOutcome.Attempts === 1) ? '' : 's') + ' (last: ' + describeFailure(tmpCause) + ').';
		}
		else
		{
			tmpMessage = 'Not running ' + pAction + ': plansheet refused the start report for RunStep ' + pIDRunStep + ' (' + describeFailure(tmpCause) + ').';
		}
		let tmpError = new Error(tmpMessage);
		let tmpStatus = Number(tmpCause && tmpCause.StatusCode) || 0;
		if (tmpStatus > 0) { tmpError.StatusCode = tmpStatus; }
		return tmpError;
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
				tmpPromise.catch((pError) => { this._warn('[run-report] ' + pError.message); });
			}
		}
		catch (pError) { this._warn('[run-report] ' + pError.message); }
	}

	// Log a warning; never throws into the work path.
	_warn(pMessage)
	{
		try { (this._Log.warn || this._Log.log || (() => {})).call(this._Log, pMessage); }
		catch (pIgnore) { /* logging is best-effort */ }
	}
}

module.exports = RunReportingCapability;
module.exports.isRetryable = isRetryable;
module.exports.START_REPORT_BACKOFF_MS = START_REPORT_BACKOFF_MS;
module.exports.START_REPORT_BUDGET_MS = START_REPORT_BUDGET_MS;
