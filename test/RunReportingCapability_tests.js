'use strict';

/**
 * Tests for RunReportingCapability -- the reporting decorator. A fake inner provider and a fake plansheet client
 * verify that a Run-backed unit runs only once plansheet accepts its Running report (any 4xx refuses the unit for
 * good, a network error or a 5xx is retried inside a budget), that an accepted unit reports progress, then the
 * terminal step with its Log, and closes the Run, that a refused unit reports nothing more, that a plain unit passes
 * straight through, and that a failed progress or terminal report never fails the work. The terminal step report and
 * the Run close are retried like the start report, the same body every time and the step first: the Run close goes
 * out only once the step report was accepted, and any 4xx on either is final.
 */

const Chai = require('chai');
const Expect = Chai.expect;

const libRunReporting = require('../source/RunReportingCapability.js');
const libPlansheetClient = require('../source/PlansheetClient.js');

const SILENT = { info: () => {}, warn: () => {}, error: () => {}, log: () => {} };

// A real PlansheetClient over a fake fetch (no network) that answers each request with the next of pStatuses (the
// last one repeats), so the client's errors and the decorator's verdicts are tested together.
function wiredClient(pStatuses, pReason)
{
	let tmpRequests = [];
	let fFetch = async (pURL, pOptions) =>
	{
		tmpRequests.push({ URL: pURL, Method: pOptions.method, Body: JSON.parse(pOptions.body) });
		let tmpStatus = pStatuses[Math.min(tmpRequests.length - 1, pStatuses.length - 1)];
		let tmpBody = (tmpStatus >= 200 && tmpStatus < 300) ? { Success: true } : { Error: pReason };
		return { status: tmpStatus, text: async () => JSON.stringify(tmpBody) };
	};
	let tmpClient = new libPlansheetClient({ BaseURL: 'https://plansheet.example', Fetch: fFetch });
	tmpClient.Requests = tmpRequests;
	return tmpClient;
}

// pBehavior: { error?, result?, progress?: [messages], throws?, onExecute? }. Executions counts the runs.
function fakeInner(pBehavior)
{
	let tmpBehavior = pBehavior || {};
	let tmpInner =
	{
		Name: 'FakeHarness',
		Capability: 'plansheet.ops',
		Executions: 0,
		getCapabilities: () => [ 'plansheet.ops' ],
		actions: { RebuildDev: { Description: 'rebuild dev' } },
		initialize: (fCallback) => (fCallback ? fCallback(null) : null),
		shutdown: (fCallback) => (fCallback ? fCallback(null) : null),
		execute: (pAction, pWorkItem, pContext, fCallback, fReportProgress) =>
		{
			tmpInner.Executions++;
			if (typeof tmpBehavior.onExecute === 'function') { tmpBehavior.onExecute(); }
			if (tmpBehavior.throws) { throw tmpBehavior.throws; }
			(tmpBehavior.progress || []).forEach((pMsg) => { if (fReportProgress) { fReportProgress({ Message: pMsg }); } });
			// On failure the real harness calls back with only the error (Outputs ride error.Result), no result.
			setImmediate(() => fCallback(tmpBehavior.error || null, tmpBehavior.error ? undefined : (tmpBehavior.result || { Outputs: { ExitCode: 0, Stdout: 'ok' }, Log: [] })));
		}
	};
	return tmpInner;
}

// The error PlansheetClient throws for an HTTP answer it does not accept: its message, with the status as StatusCode.
function httpError(pStatus)
{
	let tmpError = new Error('RunStep update failed: HTTP ' + pStatus);
	tmpError.StatusCode = pStatus;
	return tmpError;
}

// pBehavior: { Start?: [answers], Step?: [answers], Close?: [answers], Later?: answer, StartDelayMs? }. An answer is
// 'ok', an HTTP status (thrown the way PlansheetClient throws it, with StatusCode), or 'unreachable' (thrown with no
// StatusCode, as a transport failure is). Start answers the Running report, Step the step's terminal report (Succeeded
// or Failed) and Close the Run close, one entry per attempt (the last entry repeats); Later answers the progress
// reports, and the terminal reports when Step or Close is not given. Events records each start report as it is sent
// and answered, and Ends each terminal report as it is answered, so a test can see what ran when.
function fakeClient(pBehavior)
{
	let tmpBehavior = pBehavior || {};
	let tmpStart = tmpBehavior.Start || [ 'ok' ];
	let tmpLater = tmpBehavior.Later || 'ok';
	let tmpStep = tmpBehavior.Step || [ tmpLater ];
	let tmpClose = tmpBehavior.Close || [ tmpLater ];
	let tmpStartAttempts = 0;
	let tmpStepAttempts = 0;
	let tmpCloseAttempts = 0;
	let tmpCalls = [];
	let tmpEvents = [];
	let tmpEnds = [];
	let fAnswer = (pAnswer) =>
	{
		if (pAnswer === 'unreachable') { throw new Error('Could not reach plansheet at https://plansheet.example (fetch failed).'); }
		if (typeof pAnswer === 'number') { throw httpError(pAnswer); }
		return {};
	};
	return {
		Calls: tmpCalls,
		Events: tmpEvents,
		Ends: tmpEnds,
		putRunStep: async (pID, pFields, pAuth, pOptions) =>
		{
			tmpCalls.push({ m: 'putRunStep', id: pID, fields: pFields, auth: pAuth, options: pOptions });
			if (pFields && pFields.Status === 'Running')
			{
				let tmpAnswer = tmpStart[Math.min(tmpStartAttempts, tmpStart.length - 1)];
				tmpStartAttempts++;
				tmpEvents.push('start:sent');
				if (tmpBehavior.StartDelayMs) { await new Promise((fResolve) => setTimeout(fResolve, tmpBehavior.StartDelayMs)); }
				tmpEvents.push('start:' + tmpAnswer);
				return fAnswer(tmpAnswer);
			}
			if (pFields && (pFields.Status === 'Succeeded' || pFields.Status === 'Failed'))
			{
				let tmpAnswer = tmpStep[Math.min(tmpStepAttempts, tmpStep.length - 1)];
				tmpStepAttempts++;
				tmpEnds.push('step:' + tmpAnswer);
				return fAnswer(tmpAnswer);
			}
			return fAnswer(tmpLater);
		},
		putRun: async (pID, pFields, pAuth, pOptions) =>
		{
			tmpCalls.push({ m: 'putRun', id: pID, fields: pFields, auth: pAuth, options: pOptions });
			let tmpAnswer = tmpClose[Math.min(tmpCloseAttempts, tmpClose.length - 1)];
			tmpCloseAttempts++;
			tmpEnds.push('close:' + tmpAnswer);
			return fAnswer(tmpAnswer);
		}
	};
}

// A Log that keeps every warning, so a test can read what an operator would see.
function capturingLog()
{
	let tmpLines = [];
	return { Lines: tmpLines, info: () => {}, error: () => {}, log: () => {}, warn: (pLine) => { tmpLines.push(String(pLine)); } };
}

// Retries wait nothing here; a test that needs a real schedule or a budget passes its own.
function reporter(pInner, pClient, pOptions)
{
	return new libRunReporting(Object.assign({ Inner: pInner, Client: pClient, NodeToken: 'pls_node', Log: SILENT, StartReportBackoffMs: [ 0, 0, 0, 0 ] }, pOptions || {}));
}

function run(pProvider, pWorkItem)
{
	return new Promise((fResolve) =>
	{
		pProvider.execute('RebuildDev', pWorkItem || {}, { StagingPath: '/tmp' }, (pErr, pResult) => fResolve({ Err: pErr, Result: pResult }), () => {});
	});
}

// Let any report a refused unit might still send arrive before the test counts them.
function settle() { return new Promise((fResolve) => setTimeout(fResolve, 20)); }

const RUN_UNIT = { WorkItemHash: 'wih1', Settings: { IDRun: 7, IDRunStep: 42, UnitKey: 'run:7:rebuild-dev' } };

suite('RunReportingCapability', () =>
{
	test('advertising delegates to the inner provider', () =>
	{
		let tmpProvider = reporter(fakeInner(), fakeClient());
		Expect(tmpProvider.Capability).to.equal('plansheet.ops');
		Expect(tmpProvider.getCapabilities()).to.deep.equal([ 'plansheet.ops' ]);
		Expect(Object.keys(tmpProvider.actions)).to.deep.equal([ 'RebuildDev' ]);
	});

	test('a Run-backed success reports Running, then Succeeded with a log, and closes the Run', async () =>
	{
		let tmpClient = fakeClient();
		let tmpResult = await run(reporter(fakeInner({ progress: [ 'cloning prod' ], result: { Outputs: { ExitCode: 0, Stdout: 'rebuilt' }, Log: [] } }), tmpClient), RUN_UNIT);
		Expect(tmpResult.Err).to.equal(null);
		let fStep = (pPred) => tmpClient.Calls.find((pC) => pC.m === 'putRunStep' && pPred(pC.fields));
		// The start report carries the same body as before 1.12.0.
		let tmpRunning = fStep((pF) => pF.Status === 'Running');
		Expect(tmpRunning).to.be.an('object');
		Expect(tmpRunning.fields).to.have.all.keys('Status', 'StartedDate', 'HeartbeatDate', 'StageLabel', 'Log');
		Expect(tmpRunning.fields.StageLabel).to.equal('running RebuildDev');
		Expect(tmpRunning.fields.Log).to.equal('Dispatched to node; running.');
		// a progress heartbeat carries a StageLabel and no Status change
		Expect(tmpClient.Calls.some((pC) => pC.m === 'putRunStep' && !pC.fields.Status && pC.fields.StageLabel === 'cloning prod')).to.equal(true);
		let tmpSucceeded = fStep((pF) => pF.Status === 'Succeeded');
		Expect(tmpSucceeded).to.be.an('object');
		Expect(tmpSucceeded.id).to.equal(42);
		Expect(tmpSucceeded.fields.Log).to.contain('rebuilt');
		let tmpClose = tmpClient.Calls.find((pC) => pC.m === 'putRun');
		Expect(tmpClose.id).to.equal(7);
		Expect(tmpClose.fields.Status).to.equal('Succeeded');
	});

	test('a Run-backed unit runs only after plansheet answers its start report with a 2xx', async () =>
	{
		let tmpClient = fakeClient({ Start: [ 'ok' ], StartDelayMs: 15 });
		let tmpInner = fakeInner({ onExecute: () => tmpClient.Events.push('execute') });
		let tmpResult = await run(reporter(tmpInner, tmpClient), RUN_UNIT);
		Expect(tmpResult.Err).to.equal(null);
		Expect(tmpInner.Executions).to.equal(1);
		Expect(tmpClient.Events).to.deep.equal([ 'start:sent', 'start:ok', 'execute' ]);
	});

	test('a Run-backed failure reports Failed and closes the Run Failed', async () =>
	{
		let tmpClient = fakeClient();
		let tmpErr = new Error('clone failed');
		tmpErr.Result = { Outputs: { ExitCode: 3, Stderr: 'boom' } };
		let tmpResult = await run(reporter(fakeInner({ error: tmpErr }), tmpClient), RUN_UNIT);
		Expect(tmpResult.Err).to.be.an('error');
		let tmpFailed = tmpClient.Calls.find((pC) => pC.m === 'putRunStep' && pC.fields.Status === 'Failed');
		Expect(tmpFailed).to.be.an('object');
		Expect(tmpFailed.fields.Log).to.contain('boom');
		Expect(tmpClient.Calls.find((pC) => pC.m === 'putRun').fields.Status).to.equal('Failed');
	});

	// Any 4xx refuses the unit for good: it is never run, never retried (even when a retry would be accepted), and
	// nothing more is reported for it, since a Failed report would clobber the delivery that owns the step.
	[ 401, 403, 404, 409, 400 ].forEach((pStatus) =>
	{
		test('a ' + pStatus + ' start report: the unit never runs and nothing more is reported', async () =>
		{
			let tmpClient = fakeClient({ Start: [ pStatus, 'ok' ] });
			let tmpInner = fakeInner();
			let tmpResult = await run(reporter(tmpInner, tmpClient), RUN_UNIT);
			await settle();
			Expect(tmpInner.Executions).to.equal(0);
			Expect(tmpResult.Err).to.be.an('error');
			Expect(tmpResult.Err.message).to.contain('RunStep 42');
			Expect(tmpResult.Err.message).to.contain('HTTP ' + pStatus);
			Expect(tmpResult.Err.message).to.contain('Not running RebuildDev');
			Expect(tmpResult.Err.StatusCode).to.equal(pStatus);
			Expect(tmpClient.Calls.length).to.equal(1);
			Expect(tmpClient.Calls[0].m).to.equal('putRunStep');
			Expect(tmpClient.Calls[0].fields.Status).to.equal('Running');
		});
	});

	test('a network error on the start report, then acceptance: the unit runs, and the retry resends the same body', async () =>
	{
		let tmpClient = fakeClient({ Start: [ 'unreachable', 'ok' ] });
		let tmpInner = fakeInner({ onExecute: () => tmpClient.Events.push('execute') });
		let tmpResult = await run(reporter(tmpInner, tmpClient), RUN_UNIT);
		Expect(tmpResult.Err).to.equal(null);
		Expect(tmpInner.Executions).to.equal(1);
		Expect(tmpClient.Events).to.deep.equal([ 'start:sent', 'start:unreachable', 'start:sent', 'start:ok', 'execute' ]);
		let tmpStarts = tmpClient.Calls.filter((pC) => pC.m === 'putRunStep' && pC.fields.Status === 'Running');
		Expect(tmpStarts.length).to.equal(2);
		Expect(tmpStarts[1].fields).to.deep.equal(tmpStarts[0].fields);
		Expect(tmpClient.Calls.some((pC) => pC.m === 'putRunStep' && pC.fields.Status === 'Succeeded')).to.equal(true);
		Expect(tmpClient.Calls.find((pC) => pC.m === 'putRun').fields.Status).to.equal('Succeeded');
	});

	test('through the real PlansheetClient, a 403 refuses the unit with plansheet\'s reason and is not retried', async () =>
	{
		let tmpClient = wiredClient([ 403, 200 ], 'Only the node working this run reports on it.');
		let tmpInner = fakeInner();
		let tmpResult = await run(reporter(tmpInner, tmpClient), RUN_UNIT);
		await settle();
		Expect(tmpInner.Executions).to.equal(0);
		Expect(tmpResult.Err.message).to.contain('RunStep 42');
		Expect(tmpResult.Err.message).to.contain('HTTP 403');
		Expect(tmpResult.Err.message).to.contain('Only the node working this run reports on it.');
		Expect(tmpClient.Requests.length).to.equal(1);
		Expect(tmpClient.Requests[0].Method).to.equal('PUT');
		Expect(tmpClient.Requests[0].URL).to.equal('https://plansheet.example/1.0/RunStep/42');
		Expect(tmpClient.Requests[0].Body.Status).to.equal('Running');
	});

	test('through the real PlansheetClient, a 503 is retried and the unit runs once plansheet accepts', async () =>
	{
		let tmpClient = wiredClient([ 503, 200 ], 'Could not check who is working this run, so the step was not changed. Try again.');
		let tmpInner = fakeInner();
		let tmpResult = await run(reporter(tmpInner, tmpClient), RUN_UNIT);
		Expect(tmpResult.Err).to.equal(null);
		Expect(tmpInner.Executions).to.equal(1);
		// Two start attempts, then the terminal step and the Run close.
		Expect(tmpClient.Requests.map((pRequest) => pRequest.Body.Status)).to.deep.equal([ 'Running', 'Running', 'Succeeded', 'Succeeded' ]);
	});

	test('a 5xx on the start report is retried like a network error', async () =>
	{
		let tmpClient = fakeClient({ Start: [ 503, 502, 'ok' ] });
		let tmpInner = fakeInner();
		let tmpResult = await run(reporter(tmpInner, tmpClient), RUN_UNIT);
		Expect(tmpResult.Err).to.equal(null);
		Expect(tmpInner.Executions).to.equal(1);
		Expect(tmpClient.Calls.filter((pC) => pC.m === 'putRunStep' && pC.fields.Status === 'Running').length).to.equal(3);
	});

	test('start report retries used up on 5xx: the unit never runs and nothing more is reported', async () =>
	{
		let tmpClient = fakeClient({ Start: [ 503 ] });
		let tmpInner = fakeInner();
		let tmpResult = await run(reporter(tmpInner, tmpClient, { StartReportBackoffMs: [ 0, 0 ] }), RUN_UNIT);
		await settle();
		Expect(tmpInner.Executions).to.equal(0);
		Expect(tmpResult.Err).to.be.an('error');
		Expect(tmpResult.Err.message).to.contain('RunStep 42');
		Expect(tmpResult.Err.message).to.contain('after 3 attempts');
		Expect(tmpResult.Err.message).to.contain('HTTP 503');
		Expect(tmpResult.Err.StatusCode).to.equal(503);
		// One first try plus one retry per backoff entry, every one of them the start report, and nothing after.
		Expect(tmpClient.Calls.length).to.equal(3);
		tmpClient.Calls.forEach((pCall) => { Expect(pCall.m).to.equal('putRunStep'); Expect(pCall.fields.Status).to.equal('Running'); });
	});

	test('start report retries used up on network errors: the unit never runs and nothing more is reported', async () =>
	{
		let tmpClient = fakeClient({ Start: [ 'unreachable' ] });
		let tmpInner = fakeInner();
		let tmpResult = await run(reporter(tmpInner, tmpClient, { StartReportBackoffMs: [ 0, 0, 0 ] }), RUN_UNIT);
		await settle();
		Expect(tmpInner.Executions).to.equal(0);
		Expect(tmpResult.Err).to.be.an('error');
		Expect(tmpResult.Err.message).to.contain('RunStep 42');
		Expect(tmpResult.Err.message).to.contain('after 4 attempts');
		Expect(tmpResult.Err.message).to.contain('no HTTP answer');
		Expect(tmpResult.Err.StatusCode).to.equal(undefined);
		Expect(tmpClient.Calls.length).to.equal(4);
		tmpClient.Calls.forEach((pCall) => { Expect(pCall.m).to.equal('putRunStep'); Expect(pCall.fields.Status).to.equal('Running'); });
	});

	test('the start report budget bounds the retries, and each attempt gets only what is left of it as its deadline', async () =>
	{
		let tmpClient = fakeClient({ Start: [ 'unreachable' ] });
		let tmpInner = fakeInner();
		let tmpBegan = Date.now();
		// Eight 60 ms waits would allow nine attempts, but a 150 ms budget leaves room for only two or three.
		let tmpResult = await run(reporter(tmpInner, tmpClient, { StartReportBackoffMs: [ 60, 60, 60, 60, 60, 60, 60, 60 ], StartReportBudgetMs: 150 }), RUN_UNIT);
		Expect(Date.now() - tmpBegan).to.be.below(1000);
		Expect(tmpInner.Executions).to.equal(0);
		Expect(tmpResult.Err).to.be.an('error');
		Expect(tmpResult.Err.message).to.contain('RunStep 42');
		let tmpStarts = tmpClient.Calls.filter((pC) => pC.m === 'putRunStep' && pC.fields.Status === 'Running');
		Expect(tmpStarts.length).to.be.within(2, 3);
		Expect(tmpClient.Calls.length).to.equal(tmpStarts.length);
		tmpStarts.forEach((pCall) => { Expect(pCall.options.TimeoutMs).to.be.within(1, 150); });
		Expect(tmpStarts[tmpStarts.length - 1].options.TimeoutMs).to.be.below(tmpStarts[0].options.TimeoutMs);
	});

	test('the default start report schedule gives up within about 30 seconds', () =>
	{
		let tmpWaits = libRunReporting.START_REPORT_BACKOFF_MS.reduce((pSum, pMs) => pSum + pMs, 0);
		Expect(libRunReporting.START_REPORT_BUDGET_MS).to.equal(30000);
		Expect(libRunReporting.START_REPORT_BACKOFF_MS.length).to.be.greaterThan(0);
		Expect(tmpWaits).to.be.below(libRunReporting.START_REPORT_BUDGET_MS);
	});

	test('isRetryable retries only a missing HTTP answer or a 5xx', () =>
	{
		Expect(libRunReporting.isRetryable(new Error('Could not reach plansheet'))).to.equal(true);
		Expect(libRunReporting.isRetryable(null)).to.equal(true);
		[ 500, 502, 503, 504 ].forEach((pStatus) => { Expect(libRunReporting.isRetryable(httpError(pStatus))).to.equal(true); });
		[ 400, 401, 403, 404, 409, 422, 302 ].forEach((pStatus) => { Expect(libRunReporting.isRetryable(httpError(pStatus))).to.equal(false); });
	});

	test('a provider that throws once its start report is accepted still gets its step closed as Failed', async () =>
	{
		let tmpClient = fakeClient();
		let tmpResult = await run(reporter(fakeInner({ throws: new Error('could not start') }), tmpClient), RUN_UNIT);
		Expect(tmpResult.Err).to.be.an('error');
		Expect(tmpResult.Err.message).to.equal('could not start');
		let tmpFailed = tmpClient.Calls.find((pC) => pC.m === 'putRunStep' && pC.fields.Status === 'Failed');
		Expect(tmpFailed).to.be.an('object');
		Expect(tmpFailed.fields.Log).to.contain('could not start');
		Expect(tmpClient.Calls.find((pC) => pC.m === 'putRun').fields.Status).to.equal('Failed');
	});

	test('a Run whose Settings name a plan sheet reports with that plan sheet as the Customer target', async () =>
	{
		let tmpClient = fakeClient();
		let tmpUnit = { WorkItemHash: 'wih2', Settings: { IDRun: 7, IDRunStep: 42, IDCustomer: 23, UnitKey: 'run:7:rebuild-dev' } };
		await run(reporter(fakeInner({ result: { Outputs: { ExitCode: 0, Stdout: 'ok' }, Log: [] } }), tmpClient), tmpUnit);
		// Every report -- Running, the terminal step, and the Run close -- targets the dispatching plan sheet.
		Expect(tmpClient.Calls.length).to.be.greaterThan(0);
		tmpClient.Calls.forEach((pCall) => { Expect(pCall.auth.Customer).to.equal(23); Expect(pCall.auth.Bearer).to.equal('pls_node'); });
	});

	test('a Run with no IDCustomer in Settings reports with no Customer target (single-tenant node)', async () =>
	{
		let tmpClient = fakeClient();
		await run(reporter(fakeInner({ result: { Outputs: { ExitCode: 0, Stdout: 'ok' }, Log: [] } }), tmpClient), RUN_UNIT);
		Expect(tmpClient.Calls.length).to.be.greaterThan(0);
		tmpClient.Calls.forEach((pCall) => { Expect(pCall.auth.Customer).to.equal(undefined); });
	});

	test('a unit with no IDRunStep passes through with no reporting and no start gate', async () =>
	{
		// A client that would refuse every report: a plain unit never asks it anything.
		let tmpClient = fakeClient({ Start: [ 403 ], Later: 403 });
		let tmpInner = fakeInner({ result: { Outputs: { ExitCode: 0 }, Log: [] } });
		let tmpPending = run(reporter(tmpInner, tmpClient), { Settings: { UnitKey: 'plain' } });
		// The inner runs at once, inside execute(), exactly as before.
		Expect(tmpInner.Executions).to.equal(1);
		let tmpResult = await tmpPending;
		Expect(tmpResult.Err).to.equal(null);
		Expect(tmpClient.Calls.length).to.equal(0);
	});

	test('a failed progress or terminal report is swallowed and never fails the work', async () =>
	{
		// The start report is accepted; every later report (progress, the terminal step, the Run close) throws.
		let tmpClient = fakeClient({ Start: [ 'ok' ], Later: 'unreachable' });
		let tmpResult = await run(reporter(fakeInner({ progress: [ 'step one' ], result: { Outputs: { ExitCode: 0, Stdout: 'ok' }, Log: [] } }), tmpClient), RUN_UNIT);
		// The work still completes successfully even though every report after the start threw.
		Expect(tmpResult.Err).to.equal(null);
		Expect(tmpResult.Result.Outputs.ExitCode).to.equal(0);
		Expect(tmpClient.Calls.some((pC) => pC.m === 'putRunStep' && !pC.fields.Status && pC.fields.StageLabel === 'step one')).to.equal(true);
		Expect(tmpClient.Calls.some((pC) => pC.m === 'putRunStep' && pC.fields.Status === 'Succeeded')).to.equal(true);
	});

	// The terminal reports. plansheet records a hub deploy when its run first moves into Succeeded, from the step's
	// stored status and Log, so a terminal report lost to a plansheet restart used to leave the run open and the deploy
	// unrecorded. They are retried like the start report now, the step first and then the Run.
	const DEPLOY_LOG = 'deploy.sh: dev ships commit ' + 'a'.repeat(40) + '\n';

	test('a network error on the terminal step report is retried with the same body, and then the Run is closed', async () =>
	{
		let tmpClient = fakeClient({ Step: [ 'unreachable', 'ok' ] });
		let tmpResult = await run(reporter(fakeInner({ result: { Outputs: { ExitCode: 0, Stdout: DEPLOY_LOG }, Log: [] } }), tmpClient), RUN_UNIT);
		Expect(tmpResult.Err).to.equal(null);
		Expect(tmpClient.Ends).to.deep.equal([ 'step:unreachable', 'step:ok', 'close:ok' ]);
		let tmpSteps = tmpClient.Calls.filter((pC) => pC.m === 'putRunStep' && pC.fields.Status === 'Succeeded');
		Expect(tmpSteps.length).to.equal(2);
		Expect(tmpSteps[1].fields).to.deep.equal(tmpSteps[0].fields);
		Expect(tmpSteps[0].fields.Log).to.contain('ships commit');
		let tmpCloses = tmpClient.Calls.filter((pC) => pC.m === 'putRun');
		Expect(tmpCloses.length).to.equal(1);
		Expect(tmpCloses[0].id).to.equal(7);
		Expect(tmpCloses[0].fields.Status).to.equal('Succeeded');
		// One finish for both rows: the moment the work ended, not the moment a report finally landed.
		Expect(tmpCloses[0].fields.FinishedDate).to.equal(tmpSteps[0].fields.FinishedDate);
	});

	test('a 5xx on the terminal step report is retried like a network error', async () =>
	{
		let tmpClient = fakeClient({ Step: [ 502, 503, 'ok' ] });
		let tmpResult = await run(reporter(fakeInner(), tmpClient), RUN_UNIT);
		Expect(tmpResult.Err).to.equal(null);
		Expect(tmpClient.Ends).to.deep.equal([ 'step:502', 'step:503', 'step:ok', 'close:ok' ]);
	});

	test('a 5xx or a network error on the Run close is retried with the same body, and the step report is not sent again', async () =>
	{
		let tmpClient = fakeClient({ Close: [ 502, 'unreachable', 'ok' ] });
		let tmpResult = await run(reporter(fakeInner(), tmpClient), RUN_UNIT);
		Expect(tmpResult.Err).to.equal(null);
		Expect(tmpClient.Ends).to.deep.equal([ 'step:ok', 'close:502', 'close:unreachable', 'close:ok' ]);
		let tmpCloses = tmpClient.Calls.filter((pC) => pC.m === 'putRun');
		Expect(tmpCloses.length).to.equal(3);
		Expect(tmpCloses[1].fields).to.deep.equal(tmpCloses[0].fields);
		Expect(tmpCloses[2].fields).to.deep.equal(tmpCloses[0].fields);
	});

	test('a failed unit\'s terminal reports are retried the same way, as Failed', async () =>
	{
		let tmpClient = fakeClient({ Step: [ 'unreachable', 'ok' ], Close: [ 503, 'ok' ] });
		let tmpErr = new Error('deploy refused');
		tmpErr.Result = { Outputs: { ExitCode: 4, Stderr: 'refusing to deploy prod' } };
		let tmpResult = await run(reporter(fakeInner({ error: tmpErr }), tmpClient), RUN_UNIT);
		Expect(tmpResult.Err).to.equal(tmpErr);
		Expect(tmpClient.Ends).to.deep.equal([ 'step:unreachable', 'step:ok', 'close:503', 'close:ok' ]);
		tmpClient.Calls.filter((pC) => pC.m !== 'putRunStep' || pC.fields.Status !== 'Running').forEach((pC) => { Expect(pC.fields.Status).to.equal('Failed'); });
	});

	test('the hub hears the unit\'s outcome only once the terminal reports are done', async () =>
	{
		let tmpClient = fakeClient({ Step: [ 'unreachable', 'ok' ], Close: [ 502, 'ok' ] });
		let tmpProvider = reporter(fakeInner(), tmpClient);
		await new Promise((fResolve) =>
		{
			tmpProvider.execute('RebuildDev', RUN_UNIT, { StagingPath: '/tmp' }, () => { tmpClient.Ends.push('hub'); fResolve(); }, () => {});
		});
		await settle();
		Expect(tmpClient.Ends).to.deep.equal([ 'step:unreachable', 'step:ok', 'close:502', 'close:ok', 'hub' ]);
	});

	test('terminal step report retries used up: the Run close is not sent, and the hub still gets the work\'s own outcome', async () =>
	{
		let tmpLog = capturingLog();
		let tmpClient = fakeClient({ Step: [ 'unreachable' ] });
		let tmpResult = await run(reporter(fakeInner(), tmpClient, { StartReportBackoffMs: [ 0, 0 ], Log: tmpLog }), RUN_UNIT);
		await settle();
		Expect(tmpResult.Err).to.equal(null);
		Expect(tmpResult.Result.Outputs.ExitCode).to.equal(0);
		// One first try plus one retry per backoff entry, and no Run close after a step report that never landed.
		Expect(tmpClient.Ends).to.deep.equal([ 'step:unreachable', 'step:unreachable', 'step:unreachable' ]);
		let tmpLast = tmpLog.Lines[tmpLog.Lines.length - 1];
		Expect(tmpLast).to.contain('RunStep 42 Succeeded');
		Expect(tmpLast).to.contain('after 3 attempts');
		Expect(tmpLast).to.contain('The close of Run 7 is not sent, so the run stays open.');
	});

	test('Run close retries used up: the hub still gets the work\'s own outcome, and the log says the run stays open', async () =>
	{
		let tmpLog = capturingLog();
		let tmpClient = fakeClient({ Close: [ 503 ] });
		let tmpResult = await run(reporter(fakeInner(), tmpClient, { StartReportBackoffMs: [ 0, 0 ], Log: tmpLog }), RUN_UNIT);
		await settle();
		Expect(tmpResult.Err).to.equal(null);
		Expect(tmpClient.Ends).to.deep.equal([ 'step:ok', 'close:503', 'close:503', 'close:503' ]);
		let tmpLast = tmpLog.Lines[tmpLog.Lines.length - 1];
		Expect(tmpLast).to.contain('could not close Run 7 as Succeeded');
		Expect(tmpLast).to.contain('after 3 attempts (last: HTTP 503');
		Expect(tmpLast).to.contain('The run stays open.');
	});

	// Any 4xx on a terminal report is final, as on the start report: a person's Stop closed the step or its run first, an
	// approver corrected it, or another node holds the run, and the same report sent again would be refused the same way.
	// After a refused step report the Run close is not sent either.
	[ 401, 403, 404, 409 ].forEach((pStatus) =>
	{
		test('a ' + pStatus + ' on the terminal step report is not retried, and the Run close is not sent', async () =>
		{
			let tmpClient = fakeClient({ Step: [ pStatus, 'ok' ] });
			let tmpResult = await run(reporter(fakeInner(), tmpClient), RUN_UNIT);
			await settle();
			Expect(tmpResult.Err).to.equal(null);
			Expect(tmpClient.Ends).to.deep.equal([ 'step:' + pStatus ]);
		});

		test('a ' + pStatus + ' on the Run close is not retried', async () =>
		{
			let tmpClient = fakeClient({ Close: [ pStatus, 'ok' ] });
			let tmpResult = await run(reporter(fakeInner(), tmpClient), RUN_UNIT);
			await settle();
			Expect(tmpResult.Err).to.equal(null);
			Expect(tmpClient.Ends).to.deep.equal([ 'step:ok', 'close:' + pStatus ]);
		});
	});

	test('a refused terminal step report is logged with plansheet\'s reason, and the log says the Run close is not sent', async () =>
	{
		let tmpLog = capturingLog();
		let tmpClient = wiredClient([ 200, 409, 200 ], 'A finished step stays finished (it is Failed).');
		let tmpResult = await run(reporter(fakeInner(), tmpClient, { Log: tmpLog }), RUN_UNIT);
		await settle();
		Expect(tmpResult.Err).to.equal(null);
		Expect(tmpClient.Requests.map((pRequest) => pRequest.Body.Status)).to.deep.equal([ 'Running', 'Succeeded' ]);
		let tmpLast = tmpLog.Lines[tmpLog.Lines.length - 1];
		Expect(tmpLast).to.contain('plansheet refused it (HTTP 409: RunStep update failed: A finished step stays finished (it is Failed).)');
		Expect(tmpLast).to.contain('The close of Run 7 is not sent.');
		Expect(tmpLast).to.not.contain('stays open');
	});

	test('through the real PlansheetClient, a 502 on the terminal step report is retried, then the Run is closed', async () =>
	{
		let tmpClient = wiredClient([ 200, 502, 200, 200 ], 'Bad gateway');
		let tmpResult = await run(reporter(fakeInner(), tmpClient), RUN_UNIT);
		Expect(tmpResult.Err).to.equal(null);
		Expect(tmpClient.Requests.map((pRequest) => pRequest.Method + ' ' + pRequest.URL + ' ' + pRequest.Body.Status)).to.deep.equal(
		[
			'PUT https://plansheet.example/1.0/RunStep/42 Running',
			'PUT https://plansheet.example/1.0/RunStep/42 Succeeded',
			'PUT https://plansheet.example/1.0/RunStep/42 Succeeded',
			'PUT https://plansheet.example/1.0/Run/7 Succeeded'
		]);
	});

	test('the terminal step report keeps to its budget, and each attempt gets only what is left of it as its deadline', async () =>
	{
		let tmpClient = fakeClient({ Step: [ 'unreachable' ] });
		let tmpBegan = Date.now();
		// Eight 60 ms waits would allow nine attempts, but a 150 ms budget leaves room for only two or three.
		let tmpResult = await run(reporter(fakeInner(), tmpClient, { StartReportBackoffMs: [ 60, 60, 60, 60, 60, 60, 60, 60 ], StartReportBudgetMs: 150 }), RUN_UNIT);
		Expect(Date.now() - tmpBegan).to.be.below(1000);
		Expect(tmpResult.Err).to.equal(null);
		let tmpSteps = tmpClient.Calls.filter((pC) => pC.m === 'putRunStep' && pC.fields.Status === 'Succeeded');
		Expect(tmpSteps.length).to.be.within(2, 3);
		tmpSteps.forEach((pCall) => { Expect(pCall.options.TimeoutMs).to.be.within(1, 150); });
		Expect(tmpSteps[tmpSteps.length - 1].options.TimeoutMs).to.be.below(tmpSteps[0].options.TimeoutMs);
		Expect(tmpClient.Calls.filter((pC) => pC.m === 'putRun').length).to.equal(0);
	});

	test('the Run close gets a budget of its own, not what the step report left of one', async () =>
	{
		// The step report spends about 100 ms of a 200 ms budget before plansheet accepts it.
		let tmpClient = fakeClient({ Step: [ 'unreachable', 'ok' ], Close: [ 'unreachable' ] });
		let tmpResult = await run(reporter(fakeInner(), tmpClient, { StartReportBackoffMs: [ 100, 60, 60, 60, 60, 60 ], StartReportBudgetMs: 200 }), RUN_UNIT);
		Expect(tmpResult.Err).to.equal(null);
		let tmpCloses = tmpClient.Calls.filter((pC) => pC.m === 'putRun');
		Expect(tmpCloses.length).to.be.at.least(2);
		Expect(tmpCloses[0].options.TimeoutMs).to.be.above(150);
		tmpCloses.forEach((pCall) => { Expect(pCall.options.TimeoutMs).to.be.within(1, 200); });
	});
});
