'use strict';

/**
 * Tests for ClientConfig -- the on-machine node store. Uses a real temp directory so file layout and the 0600
 * permission on the secret-bearing files are actually verified.
 */

const Chai = require('chai');
const Expect = Chai.expect;

const libFS = require('fs');
const libOS = require('os');
const libPath = require('path');

const libClientConfig = require('../source/ClientConfig.js');

function tempHome()
{
	return libPath.join(libOS.tmpdir(), 'plansheet-node-test-' + process.pid + '-' + Math.floor(Date.now()) + '-' + Math.floor(Math.random() * 1e6));
}

suite('ClientConfig', () =>
{
	let _Home = null;
	let _Config = null;

	setup(() =>
	{
		_Home = tempHome();
		_Config = new libClientConfig({ Home: _Home });
	});

	teardown(() =>
	{
		try { libFS.rmSync(_Home, { recursive: true, force: true }); } catch (pIgnore) { /* best-effort cleanup */ }
	});

	test('slug is filesystem-safe and lowercased', () =>
	{
		Expect(libClientConfig.slug('Matchbook-001')).to.equal('matchbook-001');
		Expect(libClientConfig.slug('  Weird Name!! ')).to.equal('weird-name');
		Expect(libClientConfig.slug('')).to.equal('node');
	});

	test('saveNode writes a per-node file and loadNode reads it back', () =>
	{
		let tmpPath = _Config.saveNode({ NodeName: 'Matchbook-001', NodeKey: 'nk-x', NodeToken: 'pls_node', BeaconName: 'ps.1.nk-x', PlansheetURL: 'https://p', HubURL: 'wss://h', IDNodeRegistration: 7 });
		Expect(libFS.existsSync(tmpPath)).to.equal(true);
		let tmpLoaded = _Config.loadNode('Matchbook-001');
		Expect(tmpLoaded.NodeToken).to.equal('pls_node');
		Expect(tmpLoaded.BeaconName).to.equal('ps.1.nk-x');
		Expect(tmpLoaded.Slug).to.equal('matchbook-001');
	});

	test('the saved node file is mode 0600', () =>
	{
		let tmpPath = _Config.saveNode({ NodeName: 'Secret-1', NodeKey: 'nk-y', NodeToken: 'pls_secret' });
		let tmpMode = libFS.statSync(tmpPath).mode & 0o777;
		Expect(tmpMode).to.equal(0o600);
	});

	test('saveNode requires a name and a token', () =>
	{
		Expect(() => _Config.saveNode({ NodeToken: 'pls_x' })).to.throw(/NodeName/);
		Expect(() => _Config.saveNode({ NodeName: 'X' })).to.throw(/NodeToken/);
	});

	test('listNodes returns all saved nodes and removeNode deletes one', () =>
	{
		_Config.saveNode({ NodeName: 'A-1', NodeKey: 'nk-a', NodeToken: 'pls_a' });
		_Config.saveNode({ NodeName: 'B-1', NodeKey: 'nk-b', NodeToken: 'pls_b' });
		Expect(_Config.listNodes().length).to.equal(2);
		Expect(_Config.removeNode('A-1')).to.equal(true);
		Expect(_Config.listNodes().length).to.equal(1);
		Expect(_Config.removeNode('A-1')).to.equal(false);
	});

	test('loadNode returns null for an unknown node', () =>
	{
		Expect(_Config.loadNode('nope')).to.equal(null);
	});
});
