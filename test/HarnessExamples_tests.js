'use strict';

/**
 * Tests for the deploy harness example the package ships (package.json files). It mirrors the harness plansheet's
 * own deploy box runs, deploy/deploy-node/harness.deploy.json in the plansheet repository: both actions run deploy.sh
 * from the box's source checkout of plansheet, and DeployProd hands deploy.sh the commit plansheet pinned at Promote,
 * through {Input}, as one argument. deploy.sh prod refuses to deploy without that commit, so a node configured from an
 * example that lacks {Input} refuses every Promote.
 */

const Chai = require('chai');
const Expect = Chai.expect;

const libChildProcess = require('child_process');
const libFS = require('fs');
const libOS = require('os');
const libPath = require('path');

const libHarnessCapability = require('../source/HarnessCapability.js');

const SILENT = { info: () => {}, warn: () => {}, error: () => {}, log: () => {} };
const PACKAGE_ROOT = libPath.join(__dirname, '..');

// The source checkout's deploy.sh, at the path plansheet's deploy/deploy-node/harness.deploy.json names.
const SOURCE_DEPLOY_SH = '/home/plansheet/src/plansheet/deploy/scripts/deploy.sh';

// plansheet's deploy/deploy-node/harness.deploy.json Actions, which the example mirrors exactly.
const PLANSHEET_DEPLOY_ACTIONS =
{
	DeployDev:
	{
		Description: 'Deploy the box checkout\'s HEAD to dev; refuses to roll dev back.',
		Command: 'bash',
		Args: [ SOURCE_DEPLOY_SH, 'dev' ],
		TimeoutMs: 1800000
	},
	DeployProd:
	{
		Description: 'Promote: deploy the commit Plansheet pinned from dev ({Input}) to prod; refuses any other commit.',
		Command: 'bash',
		Args: [ SOURCE_DEPLOY_SH, 'prod', '{Input}' ],
		TimeoutMs: 1800000
	}
};

function readJSON(pName)
{
	return JSON.parse(libFS.readFileSync(libPath.join(PACKAGE_ROOT, pName), 'utf8'));
}

function run(pProvider, pAction, pWorkItem)
{
	return new Promise((fResolve) =>
	{
		pProvider.execute(pAction, pWorkItem || {}, { StagingPath: libOS.tmpdir() }, (pErr, pResult) => fResolve({ Err: pErr, Result: pResult }));
	});
}

suite('Harness examples', () =>
{
	test('the deploy example ships with the package and loads as a plansheet.deploy harness', () =>
	{
		Expect(readJSON('package.json').files).to.include('harness.deploy.example.json');
		let tmpProvider = new libHarnessCapability(Object.assign(readJSON('harness.deploy.example.json'), { Log: SILENT }));
		Expect(tmpProvider.Capability).to.equal('plansheet.deploy');
		Expect(Object.keys(tmpProvider.actions).sort()).to.deep.equal([ 'DeployDev', 'DeployProd' ]);
	});

	test('the deploy example\'s actions match plansheet\'s deploy box harness: the source checkout\'s deploy.sh, and DeployProd takes {Input}', () =>
	{
		let tmpExample = readJSON('harness.deploy.example.json');
		Expect(tmpExample.Capability).to.equal('plansheet.deploy');
		Expect(tmpExample.MaxOutputBytes).to.equal(262144);
		Expect(tmpExample.Actions).to.deep.equal(PLANSHEET_DEPLOY_ACTIONS);
	});

	test('run through the harness, DeployProd hands deploy.sh the pinned commit as one argument, and DeployDev hands it none', async () =>
	{
		// A spawn that records what the harness would run, then runs a no-op in its place.
		let tmpSpawned = [];
		let fSpawn = (pCommand, pArgs, pOptions) =>
		{
			tmpSpawned.push([ pCommand ].concat(pArgs));
			return libChildProcess.spawn('/bin/sh', [ '-c', 'exit 0' ], pOptions);
		};
		let tmpProvider = new libHarnessCapability(Object.assign(readJSON('harness.deploy.example.json'), { Log: SILENT, Spawn: fSpawn }));
		let tmpPin = '0123456789abcdef0123456789abcdef01234567';
		let tmpProd = await run(tmpProvider, 'DeployProd', { Settings: { IDRun: 7, IDRunStep: 42, Input: tmpPin } });
		Expect(tmpProd.Err).to.equal(null);
		// Plansheet sends DeployDev an empty Input; the example never puts it on the command line.
		let tmpDev = await run(tmpProvider, 'DeployDev', { Settings: { IDRun: 8, IDRunStep: 43, Input: '' } });
		Expect(tmpDev.Err).to.equal(null);
		Expect(tmpSpawned).to.deep.equal(
		[
			[ 'bash', SOURCE_DEPLOY_SH, 'prod', tmpPin ],
			[ 'bash', SOURCE_DEPLOY_SH, 'dev' ]
		]);
	});

	test('the deploy example\'s comment is plain ASCII and explains the pinned commit and {Input}', () =>
	{
		let tmpComment = readJSON('harness.deploy.example.json')._comment;
		Expect(tmpComment).to.be.a('string');
		Expect(tmpComment).to.match(/^[\x20-\x7e]+$/);
		Expect(tmpComment).to.contain('pinned commit');
		Expect(tmpComment).to.contain('{Input}');
		Expect(tmpComment).to.contain('deploy/deploy-node/harness.deploy.json');
	});
});
