'use strict';

/**
 * Tests for NodeRunner -- the hub join. The /1.0/Node/Self client and the ultravisor-beacon client are both
 * injected seams, so the whole start() path runs without a live plansheet or hub.
 */

const Chai = require('chai');
const Expect = Chai.expect;

const libNodeRunner = require('../source/NodeRunner.js');

const SILENT = { info: () => {}, warn: () => {}, error: () => {}, log: () => {} };

function activeSelf(pOverrides)
{
	return Object.assign(
		{ TokenKind: 'node', Status: 'Active', Active: true, BeaconName: 'ps.1.nk-x', IDCustomer: 1, NodeKey: 'nk-x', IDNodeRegistration: 5 },
		pOverrides || {});
}

function fakeClient(pSelfViewOrError)
{
	return { nodeSelf: async () => { if (pSelfViewOrError instanceof Error) { throw pSelfViewOrError; } return pSelfViewOrError; } };
}

function fakeBeaconFactory(pStartError)
{
	let tmpMade = [];
	let fFactory = (pConfig) =>
	{
		let tmpClient =
		{
			Config: pConfig, Started: false, Stopped: false,
			start: (fCallback) => { if (pStartError) { return fCallback(pStartError); } tmpClient.Started = true; return fCallback(null, { BeaconID: 'bkn-' + pConfig.Name }); },
			stop: (fCallback) => { tmpClient.Stopped = true; return fCallback ? fCallback(null) : null; }
		};
		tmpMade.push(tmpClient);
		return tmpClient;
	};
	fFactory.Made = tmpMade;
	return fFactory;
}

const FAKE_HARNESS = { Capability: 'plansheet.software', getCapabilities: () => [ 'plansheet.software' ], execute: () => {} };

function runner(pOverrides)
{
	return new libNodeRunner(Object.assign(
	{
		PlansheetURL: 'https://plansheet.example',
		NodeToken: 'pls_node',
		HubURL: 'wss://hub.example',
		Client: fakeClient(activeSelf()),
		BeaconClientFactory: fakeBeaconFactory(null),
		Harness: FAKE_HARNESS,
		Log: SILENT
	}, pOverrides || {}));
}

suite('NodeRunner', () =>
{
	suite('decideStart', () =>
	{
		test('proceeds for an Active node and returns its bound name', () =>
		{
			let tmpDecision = libNodeRunner.decideStart(activeSelf());
			Expect(tmpDecision.Proceed).to.equal(true);
			Expect(tmpDecision.BeaconName).to.equal('ps.1.nk-x');
		});

		test('denies a null self view', () => { Expect(libNodeRunner.decideStart(null).Proceed).to.equal(false); });

		test('denies a non-node token', () =>
		{
			let tmpDecision = libNodeRunner.decideStart(activeSelf({ TokenKind: '' }));
			Expect(tmpDecision.Proceed).to.equal(false);
			Expect(tmpDecision.Reason).to.contain('not a node token');
		});

		test('denies a Pending node', () =>
		{
			let tmpDecision = libNodeRunner.decideStart(activeSelf({ Status: 'Pending', Active: false }));
			Expect(tmpDecision.Proceed).to.equal(false);
			Expect(tmpDecision.Reason).to.contain('not Active');
		});

		test('denies an Active node with no bound beacon name', () =>
		{
			let tmpDecision = libNodeRunner.decideStart(activeSelf({ BeaconName: '' }));
			Expect(tmpDecision.Proceed).to.equal(false);
			Expect(tmpDecision.Reason).to.contain('no beacon name');
		});
	});

	suite('normalizeHubURL', () =>
	{
		test('maps wss:// to https:// and ws:// to http:// (the origin the beacon library wants)', () =>
		{
			Expect(libNodeRunner.normalizeHubURL('wss://hub.dev.plansheet.io')).to.equal('https://hub.dev.plansheet.io');
			Expect(libNodeRunner.normalizeHubURL('WSS://Hub.Example')).to.equal('https://Hub.Example');
			Expect(libNodeRunner.normalizeHubURL('ws://localhost:54321')).to.equal('http://localhost:54321');
		});

		test('leaves http(s) and empty values untouched', () =>
		{
			Expect(libNodeRunner.normalizeHubURL('https://hub.dev.plansheet.io')).to.equal('https://hub.dev.plansheet.io');
			Expect(libNodeRunner.normalizeHubURL('http://ultravisor:54321')).to.equal('http://ultravisor:54321');
			Expect(libNodeRunner.normalizeHubURL('')).to.equal('');
			Expect(libNodeRunner.normalizeHubURL(undefined)).to.equal('');
		});

		test('a runner built with a wss:// hub hands the beacon an https:// ServerURL', async () =>
		{
			let tmpFactory = fakeBeaconFactory(null);
			await runner({ HubURL: 'wss://hub.dev.plansheet.io', BeaconClientFactory: tmpFactory }).start();
			Expect(tmpFactory.Made[0].Config.ServerURL).to.equal('https://hub.dev.plansheet.io');
		});
	});

	suite('buildBeaconConfig', () =>
	{
		test('maps the node identity and hub URL onto the beacon config', () =>
		{
			let tmpConfig = libNodeRunner.buildBeaconConfig(activeSelf(), { HubURL: 'wss://hub', NodeToken: 'pls_node', Providers: [ FAKE_HARNESS ] });
			Expect(tmpConfig.ServerURL).to.equal('wss://hub');
			Expect(tmpConfig.Name).to.equal('ps.1.nk-x');
			Expect(tmpConfig.JoinSecret).to.equal('pls_node');
			Expect(tmpConfig.Providers).to.deep.equal([ FAKE_HARNESS ]);
			Expect(tmpConfig.Tags.Capabilities).to.equal('plansheet.software');
			Expect(tmpConfig.FailStartOnRejection).to.equal(true);
		});

		test('aggregates the capabilities of several providers so one node can carry many', () =>
		{
			let tmpQuery = { Capability: 'plansheet.query', getCapabilities: () => [ 'plansheet.query' ], execute: () => {} };
			let tmpAssistant = { Capability: 'plansheet.assistant', getCapabilities: () => [ 'plansheet.assistant' ], execute: () => {} };
			let tmpConfig = libNodeRunner.buildBeaconConfig(activeSelf(), { HubURL: 'wss://hub', NodeToken: 'pls_node', Providers: [ tmpQuery, tmpAssistant ] });
			Expect(tmpConfig.Providers.length).to.equal(2);
			Expect(tmpConfig.Tags.Capabilities).to.equal('plansheet.query,plansheet.assistant');
		});
	});

	suite('start', () =>
	{
		test('joins an Active node and advertises its capability', async () =>
		{
			let tmpFactory = fakeBeaconFactory(null);
			let tmpResult = await runner({ BeaconClientFactory: tmpFactory }).start();
			Expect(tmpResult.Started).to.equal(true);
			Expect(tmpResult.BeaconName).to.equal('ps.1.nk-x');
			Expect(tmpFactory.Made.length).to.equal(1);
			Expect(tmpFactory.Made[0].Config.JoinSecret).to.equal('pls_node');
			Expect(tmpFactory.Made[0].Config.Providers.length).to.equal(1);
			Expect(tmpFactory.Made[0].Started).to.equal(true);
		});

		test('does not join a Pending node', async () =>
		{
			let tmpFactory = fakeBeaconFactory(null);
			let tmpResult = await runner({ Client: fakeClient(activeSelf({ Status: 'Pending', Active: false })), BeaconClientFactory: tmpFactory }).start();
			Expect(tmpResult.Started).to.equal(false);
			Expect(tmpResult.Reason).to.contain('not Active');
			Expect(tmpFactory.Made.length).to.equal(0);
		});

		test('reports an unreachable plansheet cleanly', async () =>
		{
			let tmpResult = await runner({ Client: fakeClient(new Error('ECONNREFUSED')) }).start();
			Expect(tmpResult.Started).to.equal(false);
			Expect(tmpResult.Reason).to.contain('Could not resolve node identity');
		});

		test('refuses without a hub URL', async () =>
		{
			let tmpResult = await runner({ HubURL: '' }).start();
			Expect(tmpResult.Started).to.equal(false);
			Expect(tmpResult.Reason).to.contain('hub URL');
		});

		test('reports a refused beacon join (transient; supervisor retries)', async () =>
		{
			let tmpResult = await runner({ BeaconClientFactory: fakeBeaconFactory(new Error('No auth beacon connected')) }).start();
			Expect(tmpResult.Started).to.equal(false);
			Expect(tmpResult.Reason).to.contain('refused');
		});

		test('stop() forwards to the beacon client', async () =>
		{
			let tmpFactory = fakeBeaconFactory(null);
			let tmpRunner = runner({ BeaconClientFactory: tmpFactory });
			await tmpRunner.start();
			await new Promise((fResolve) => tmpRunner.stop(fResolve));
			Expect(tmpFactory.Made[0].Stopped).to.equal(true);
		});
	});
});
