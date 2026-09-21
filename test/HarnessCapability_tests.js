'use strict';

/**
 * Tests for HarnessCapability -- the configurable work handler. Uses real /bin/sh executors so the actual
 * spawn/capture/exit path (including the env-strip and stdin-EOF hardening) is exercised.
 */

const Chai = require('chai');
const Expect = Chai.expect;

const libHarnessCapability = require('../source/HarnessCapability.js');

const SILENT = { info: () => {}, warn: () => {}, error: () => {}, log: () => {} };

function harness(pActions, pCapability)
{
	return new libHarnessCapability({ Capability: pCapability || 'plansheet.software', Actions: pActions, Log: SILENT });
}

function run(pProvider, pAction, pWorkItem, pContext)
{
	return new Promise((fResolve) =>
	{
		pProvider.execute(pAction, pWorkItem || {}, pContext || { StagingPath: '/tmp' }, (pErr, pResult) => fResolve({ Err: pErr, Result: pResult }));
	});
}

suite('HarnessCapability', () =>
{
	test('advertises the configured capability and its actions', () =>
	{
		let tmpProvider = harness({ RunWorkItem: { Command: '/bin/sh', Args: [ '-c', 'exit 0' ] } }, 'docucluster.software');
		Expect(tmpProvider.Capability).to.equal('docucluster.software');
		Expect(tmpProvider.getCapabilities()).to.deep.equal([ 'docucluster.software' ]);
		Expect(Object.keys(tmpProvider.actions)).to.deep.equal([ 'RunWorkItem' ]);
	});

	test('runs the configured executor and reports success on exit 0', async () =>
	{
		let tmpProvider = harness({ RunWorkItem: { Command: '/bin/sh', Args: [ '-c', 'echo hello; exit 0' ] } });
		let tmpResult = await run(tmpProvider, 'RunWorkItem', { WorkItemHash: 'wih1', Settings: { IDWorkItem: 42, WorkItemNumber: 7, Title: 'A thing' } });
		Expect(tmpResult.Err).to.equal(null);
		Expect(tmpResult.Result.Outputs.ExitCode).to.equal(0);
		Expect(tmpResult.Result.Outputs.Stdout).to.contain('hello');
	});

	test('injects the work item context as environment', async () =>
	{
		let tmpProvider = harness({ RunWorkItem: { Command: '/bin/sh', Args: [ '-c', 'echo "id=$PLANSHEET_IDWORKITEM num=$PLANSHEET_WORKITEM_NUMBER title=$PLANSHEET_WORKITEM_TITLE"' ] } });
		let tmpResult = await run(tmpProvider, 'RunWorkItem', { Settings: { IDWorkItem: 42, WorkItemNumber: 7, Title: 'A thing' } });
		Expect(tmpResult.Result.Outputs.Stdout).to.contain('id=42');
		Expect(tmpResult.Result.Outputs.Stdout).to.contain('num=7');
		Expect(tmpResult.Result.Outputs.Stdout).to.contain('title=A thing');
	});

	test('substitutes {Placeholder} in Args', async () =>
	{
		let tmpProvider = harness({ RunWorkItem: { Command: '/bin/sh', Args: [ '-c', 'echo item-{IDWorkItem}' ] } });
		let tmpResult = await run(tmpProvider, 'RunWorkItem', { Settings: { IDWorkItem: 99 } });
		Expect(tmpResult.Result.Outputs.Stdout).to.contain('item-99');
	});

	test('a non-zero exit is a failure, with the captured output on the error', async () =>
	{
		let tmpProvider = harness({ RunWorkItem: { Command: '/bin/sh', Args: [ '-c', 'echo oops 1>&2; exit 3' ] } });
		let tmpResult = await run(tmpProvider, 'RunWorkItem', { Settings: {} });
		Expect(tmpResult.Err).to.be.an('error');
		Expect(tmpResult.Err.Result.Outputs.ExitCode).to.equal(3);
		Expect(tmpResult.Err.Result.Outputs.Stderr).to.contain('oops');
	});

	test('an action with no configured executor fails cleanly', async () =>
	{
		let tmpProvider = harness({ RunWorkItem: { Command: '/bin/sh', Args: [ '-c', 'exit 0' ] } });
		let tmpResult = await run(tmpProvider, 'SomethingElse', {});
		Expect(tmpResult.Err).to.be.an('error');
		Expect(tmpResult.Err.message).to.contain('no executor configured');
	});

	test('a missing command fails cleanly (spawn error)', async () =>
	{
		let tmpProvider = harness({ RunWorkItem: { Command: '/nonexistent/binary-xyz-zzz', Args: [] } });
		let tmpResult = await run(tmpProvider, 'RunWorkItem', {});
		Expect(tmpResult.Err).to.be.an('error');
	});

	test('a runaway executor is killed at TimeoutMs', async function ()
	{
		this.timeout(5000);
		let tmpProvider = harness({ RunWorkItem: { Command: '/bin/sh', Args: [ '-c', 'sleep 10' ], TimeoutMs: 200 } });
		let tmpStart = Date.now();
		let tmpResult = await run(tmpProvider, 'RunWorkItem', {});
		Expect(tmpResult.Err).to.be.an('error');
		Expect(tmpResult.Err.message).to.contain('timed out');
		Expect(Date.now() - tmpStart).to.be.below(2500);
	});

	test('fReportProgress receives stdout', async () =>
	{
		let tmpProvider = harness({ RunWorkItem: { Command: '/bin/sh', Args: [ '-c', 'echo progressline' ] } });
		let tmpProgress = [];
		await new Promise((fResolve) => tmpProvider.execute('RunWorkItem', {}, {}, () => fResolve(), (pP) => tmpProgress.push(pP)));
		Expect(tmpProgress.some((pP) => (pP.Message || '').indexOf('progressline') >= 0)).to.equal(true);
	});

	test('does not leak the node token into the executor environment', async () =>
	{
		let tmpSaved = process.env.NODE_TOKEN;
		process.env.NODE_TOKEN = 'pls_secretnodetoken';
		try
		{
			let tmpProvider = harness({ RunWorkItem: { Command: '/bin/sh', Args: [ '-c', 'echo "token=[$NODE_TOKEN] haspath=[${PATH:+yes}]"' ] } });
			let tmpResult = await run(tmpProvider, 'RunWorkItem', { Settings: {} });
			Expect(tmpResult.Err).to.equal(null);
			Expect(tmpResult.Result.Outputs.Stdout).to.contain('token=[]');
			Expect(tmpResult.Result.Outputs.Stdout).to.contain('haspath=[yes]');
		}
		finally
		{
			if (tmpSaved === undefined) { delete process.env.NODE_TOKEN; } else { process.env.NODE_TOKEN = tmpSaved; }
		}
	});

	test('closes the executor stdin so a stdin-reading command sees EOF instead of hanging', async function ()
	{
		this.timeout(5000);
		let tmpProvider = harness({ RunWorkItem: { Command: '/bin/sh', Args: [ '-c', 'cat; echo done' ] } });
		let tmpStart = Date.now();
		let tmpResult = await run(tmpProvider, 'RunWorkItem', { Settings: {} });
		Expect(tmpResult.Err).to.equal(null);
		Expect(tmpResult.Result.Outputs.Stdout).to.contain('done');
		Expect(Date.now() - tmpStart).to.be.below(3000);
	});
});
