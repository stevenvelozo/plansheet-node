'use strict';

/**
 * Tests for RunReportingCapability -- the reporting decorator. A fake inner provider and a fake plansheet client
 * verify that a Run-backed unit reports Running -> progress -> terminal + Log and closes the Run, that a plain
 * unit passes straight through, and that a reporting failure never fails the work.
 */

const Chai = require('chai');
const Expect = Chai.expect;

const libRunReporting = require('../source/RunReportingCapability.js');

const SILENT = { info: () => {}, warn: () => {}, error: () => {}, log: () => {} };

// pBehavior: { error?, result?, progress?: [messages] }
function fakeInner(pBehavior)
{
	let tmpBehavior = pBehavior || {};
	return {
		Name: 'FakeHarness',
		Capability: 'plansheet.ops',
		getCapabilities: () => [ 'plansheet.ops' ],
		actions: { RebuildDev: { Description: 'rebuild dev' } },
		initialize: (fCallback) => (fCallback ? fCallback(null) : null),
		shutdown: (fCallback) => (fCallback ? fCallback(null) : null),
		execute: (pAction, pWorkItem, pContext, fCallback, fReportProgress) =>
		{
			(tmpBehavior.progress || []).forEach((pMsg) => { if (fReportProgress) { fReportProgress({ Message: pMsg }); } });
			// On failure the real harness calls back with only the error (Outputs ride error.Result), no result.
			setImmediate(() => fCallback(tmpBehavior.error || null, tmpBehavior.error ? undefined : (tmpBehavior.result || { Outputs: { ExitCode: 0, Stdout: 'ok' }, Log: [] })));
		}
	};
}

function fakeClient(pFail)
{
	let tmpCalls = [];
	return {
		Calls: tmpCalls,
		putRunStep: async (pID, pFields, pAuth) => { tmpCalls.push({ m: 'putRunStep', id: pID, fields: pFields, auth: pAuth }); if (pFail) { throw new Error('report boom'); } return {}; },
		putRun: async (pID, pFields, pAuth) => { tmpCalls.push({ m: 'putRun', id: pID, fields: pFields, auth: pAuth }); if (pFail) { throw new Error('report boom'); } return {}; }
	};
}

function reporter(pInner, pClient)
{
	return new libRunReporting({ Inner: pInner, Client: pClient, NodeToken: 'pls_node', Log: SILENT });
}

function run(pProvider, pWorkItem)
{
	return new Promise((fResolve) =>
	{
		pProvider.execute('RebuildDev', pWorkItem || {}, { StagingPath: '/tmp' }, (pErr, pResult) => fResolve({ Err: pErr, Result: pResult }), () => {});
	});
}

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
		Expect(fStep((pF) => pF.Status === 'Running')).to.be.an('object');
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

	test('a unit with no IDRunStep passes through with no reporting', async () =>
	{
		let tmpClient = fakeClient();
		let tmpResult = await run(reporter(fakeInner({ result: { Outputs: { ExitCode: 0 }, Log: [] } }), tmpClient), { Settings: { UnitKey: 'plain' } });
		Expect(tmpResult.Err).to.equal(null);
		Expect(tmpClient.Calls.length).to.equal(0);
	});

	test('a reporting failure is swallowed and never fails the work', async () =>
	{
		let tmpClient = fakeClient(true); // every report throws
		let tmpResult = await run(reporter(fakeInner({ result: { Outputs: { ExitCode: 0, Stdout: 'ok' }, Log: [] } }), tmpClient), RUN_UNIT);
		// The work still completes successfully even though every report threw.
		Expect(tmpResult.Err).to.equal(null);
		Expect(tmpResult.Result.Outputs.ExitCode).to.equal(0);
	});
});
